'use strict';
/**
 * Filesystem tools — real local file operations with canonical path containment.
 *
 * v2.8.2 §60/§66：所有文件工具使用统一 PathSecurity（canonical）做 containment，
 * 替代旧 pathguard 的 lexical 判断。mutation 操作（write/create/move/copy/delete）
 * 在实际 fs 调用前执行 execution-time recheck（§66 TOCTOU 防护）。
 *
 * ctx.pathSecurity 可注入 per-run PathSecurity 实例（cacheRoots）；未注入时用
 * defaultPathSecurity（无 cache，每次 canonicalizeRoot）。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const pathSecurityMod = require('../security/pathSecurity');
const { PathSecurityError, CODE } = pathSecurityMod;

const MAX_READ = 5 * 1024 * 1024; // 5MB full read cap

function looksBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = false) { return { ok: false, error: { code, message, retryable } }; }

/**
 * 向后兼容 pathguard 的 PATH_OUTSIDE_WORKSPACE 错误码（§119 不破坏现有测试）。
 * PathSecurity 模块本身返回精确码（OUTSIDE_ROOT/REPARSE_ESCAPE/...），工具层
 * 在向调用方/测试暴露时映射为兼容码。
 */
function compatCode(code) {
  if (code === CODE.OUTSIDE_ROOT || code === CODE.REPARSE_ESCAPE || code === CODE.TAIL_ESCAPE) {
    return 'PATH_OUTSIDE_WORKSPACE';
  }
  return code;
}

/** 获取 ctx 的 PathSecurity 实例（per-run cache 或 default）。 */
function psOf(ctx) {
  return (ctx && ctx.pathSecurity) || pathSecurityMod;
}

/**
 * Canonical guard：返回 canonical-verified 绝对路径，不在 root 内则抛 PathSecurityError。
 * 替代旧 pathguard.guard + verifyNoSymlinkEscape（§5 修复：lexical 不足，需 canonical）。
 */
function guardCanonical(ctx, inputPath) {
  const ps = psOf(ctx);
  const r = ps.checkPathContainment(ctx.projectRoot, inputPath);
  if (!r.allowed) {
    throw new PathSecurityError(r.errorCode || CODE.OUTSIDE_ROOT, r.reason || '路径不在项目根目录内');
  }
  // 用 canonical target（解析 reparse point 后的真实路径）作为后续 fs 操作目标
  return r.canonicalTarget || path.resolve(ctx.projectRoot, inputPath);
}

/**
 * Execution-time recheck（§66 TOCTOU）：在 mutation fs 操作前再次 canonical 验证。
 * 如果 permission 评估后到执行前路径被替换为 junction 逃逸，则 DENY。
 */
function recheckMutationTarget(ctx, inputPath) {
  // fresh canonicalization（§104：target 不缓存）
  guardCanonical(ctx, inputPath);
}

async function safeRead(ctx, absPath) {
  // read 前也做 canonical 验证（absPath 已是 canonical，但 recheck 防 TOCTOU）
  recheckMutationTarget(ctx, absPath);
  const stat = await fsp.stat(absPath);
  if (stat.isDirectory()) return fail('IS_DIRECTORY', `${absPath} 是目录，不是文件`);
  if (stat.size > MAX_READ) {
    return fail('FILE_TOO_LARGE', `文件 ${stat.size} 字节超过单次读取上限 ${MAX_READ}，请使用 read_file_range 或搜索`, false);
  }
  const buf = await fsp.readFile(absPath);
  if (looksBinary(buf)) return fail('BINARY_FILE', '检测到二进制文件，无法作为文本读取', false);
  const content = buf.toString('utf8');
  // v2.9.8 R3：真实读取证据——记录观察哈希，供后续 stale-write 保护。
  observeFile(ctx, absPath, content);
  return ok({ content, size: stat.size });
}

// ---------------------------------------------------------------------------
// v2.9.8 R3 — Atomic File Mutation + Concurrent Change Protection
//
// 观察账本（per-run）：真实 read 证据的 sha256。模型无法凭空生成有效 token：
// expected_sha256 必须能在本 run 的真实读取记录中找到，否则拒绝。
// ---------------------------------------------------------------------------
function sha256Hex(content) {
  return crypto.createHash('sha256').update(content == null ? '' : content).digest('hex');
}

function observationLedger(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  if (!ctx._fileObservations) ctx._fileObservations = new Map();
  return ctx._fileObservations;
}

function observeFile(ctx, absPath, content) {
  const ledger = observationLedger(ctx);
  if (!ledger) return;
  ledger.set(String(absPath).toLowerCase(), { sha256: sha256Hex(content), at: Date.now() });
}

/**
 * stale-write 保护：写入前比对磁盘真实内容与本 run 的观察证据。
 * - 提供了 expected_sha256：必须是本 run 真实读取过的哈希（防模型凭空生成），
 *   且与磁盘当前内容一致；
 * - 未提供但存在观察记录：磁盘内容必须与最后一次观察一致（外部修改 → fail-closed）。
 */
function checkStaleWrite(ctx, absPath, currentContent, expectedSha) {
  const ledger = observationLedger(ctx);
  const observed = ledger ? ledger.get(String(absPath).toLowerCase()) : null;
  const currentSha = sha256Hex(currentContent);
  if (expectedSha) {
    if (!observed || observed.sha256 !== expectedSha) {
      return fail('EXPECTED_HASH_NOT_OBSERVED', 'expected_sha256 不是本 run 真实读取证据（禁止凭空生成 hash）', false);
    }
  }
  if (observed && observed.sha256 !== currentSha) {
    return fail('FILE_CHANGED_SINCE_READ', '文件在读取后被外部修改，拒绝基于旧内容覆盖（请重新读取）', true);
  }
  return { ok: true, sha256: currentSha };
}

/**
 * 原子写入：同目录 temp → 完整写入 → rename 替换。
 * 写失败绝不留下 truncate 后的半个原文件。
 * ctx.__testWriteFault：仅测试可用的故障注入点（在最终替换前触发）。
 */
async function atomicWriteFile(ctx, absPath, content) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.adp-tmp-${crypto.randomUUID()}`);
  try {
    await fsp.writeFile(tmp, content == null ? '' : content, 'utf8');
    if (ctx && typeof ctx.__testWriteFault === 'function') {
      await ctx.__testWriteFault(absPath, tmp); // 故障注入：最终替换前失败
    }
    await fsp.rename(tmp, absPath);
  } catch (err) {
    try { await fsp.rm(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

// Shared mutation implementations. Main-agent tools and explicit Workbench
// user actions call these same guarded functions; there is one mutation truth.
async function createDirectoryMutation(ctx, args) {
  try {
    const abs = guardCanonical(ctx, args.path);
    recheckMutationTarget(ctx, args.path);
    await fsp.mkdir(abs);
    return ok({ created: args.path });
  } catch (e) {
    if (e && e.code === 'EEXIST') return fail('DIRECTORY_EXISTS', `${args.path} 已存在，创建被拒绝`, false);
    return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('CREATE_DIRECTORY_FAILED', e.message);
  }
}

async function createFileMutation(ctx, args) {
  try {
    const abs = guardCanonical(ctx, args.path);
    recheckMutationTarget(ctx, args.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    let fh;
    try {
      fh = await fsp.open(abs, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o666);
    } catch (e) {
      if (e && e.code === 'EEXIST') return fail('FILE_EXISTS', `${args.path} 已存在，请使用 write_file 覆盖或先删除`);
      throw e;
    }
    try { await fh.writeFile(args.content || '', 'utf8'); } finally { await fh.close(); }
    observeFile(ctx, abs, args.content || '');
    return ok({ created: args.path });
  } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('CREATE_FAILED', e.message); }
}

async function moveFileMutation(ctx, args) {
  try {
    const a = guardCanonical(ctx, args.source);
    const b = guardCanonical(ctx, args.destination);
    recheckMutationTarget(ctx, args.source);
    recheckMutationTarget(ctx, args.destination);
    await fsp.mkdir(path.dirname(b), { recursive: true });
    if (fs.existsSync(b) && args.replace !== true) {
      return fail('DESTINATION_EXISTS', `${args.destination} 已存在，移动被拒绝（显式 replace=true 才允许覆盖）`, false);
    }
    await fsp.rename(a, b);
    return ok({ moved: args.source, to: args.destination });
  } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('MOVE_FAILED', e.message); }
}

async function deleteFileMutation(ctx, args) {
  try {
    const abs = guardCanonical(ctx, args.path);
    const st = await fsp.stat(abs);
    recheckMutationTarget(ctx, args.path);
    if (st.isDirectory()) await fsp.rmdir(abs); else await fsp.unlink(abs);
    return ok({ deleted: args.path });
  } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('DELETE_FAILED', e.message); }
}

async function deleteDirectoryMutation(ctx, args) {
  try {
    const abs = guardCanonical(ctx, args.path);
    if (path.resolve(abs) === path.resolve(ctx.projectRoot)) return fail('WORKSPACE_ROOT_MUTATION_BLOCKED', '不能删除项目根目录', false);
    const st = await fsp.lstat(abs);
    if (!st.isDirectory() || st.isSymbolicLink()) return fail('NOT_A_DIRECTORY', '目标不是普通文件夹', false);
    recheckMutationTarget(ctx, args.path);
    await fsp.rm(abs, { recursive: true, force: false });
    return ok({ deleted: args.path });
  } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('DELETE_DIRECTORY_FAILED', e.message); }
}

const workbenchMutations = Object.freeze({
  create_file: createFileMutation,
  create_directory: createDirectoryMutation,
  move_file: moveFileMutation,
  delete_file: deleteFileMutation,
  delete_directory: deleteDirectoryMutation
});

const tools = [
  {
    name: 'list_directory', description: '列出目录内容（文件与子目录）。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '目录路径，相对于项目根' } }, required: ['path'] },
    async exec(ctx, args) {
      const abs = guardCanonical(ctx, args.path || '.');
      let entries;
      try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { return fail('READ_DIR_FAILED', e.message); }
      const items = entries
        .filter(e => e.name !== 'node_modules' && e.name !== '.git')
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: path.relative(ctx.projectRoot, path.join(abs, e.name)) }));
      return ok({ items });
    }
  },
  {
    name: 'read_file', description: '读取文本文件全部内容（UTF-8，自动检测二进制）。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
    async exec(ctx, args) {
      try { const abs = guardCanonical(ctx, args.path); return await safeRead(ctx, abs); }
      catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('READ_FAILED', e.message); }
    }
  },
  {
    name: 'read_file_range', description: '按行号范围读取文件片段（适合大文件）。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number', description: '起始行（从1开始）' }, end_line: { type: 'number', description: '结束行（含）' } }, required: ['path'] },
    async exec(ctx, args) {
      try {
        const abs = guardCanonical(ctx, args.path);
        recheckMutationTarget(ctx, args.path);
        const start = args.start_line ? Math.max(1, args.start_line) : 1;
        const end = args.end_line || start + 200;
        const content = await fsp.readFile(abs, 'utf8');
        const lines = content.split(/\r?\n/);
        const slice = lines.slice(start - 1, end);
        return ok({ content: slice.join('\n'), start_line: start, end_line: start - 1 + slice.length, total_lines: lines.length });
      } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('READ_FAILED', e.message); }
    }
  },
  {
    name: 'file_exists', description: '检查文件或目录是否存在。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(ctx, args) {
      try { const abs = guardCanonical(ctx, args.path); return ok({ exists: fs.existsSync(abs) }); }
      catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('CHECK_FAILED', e.message); }
    }
  },
  {
    name: 'get_file_metadata', description: '获取文件大小、修改时间、是否为目录。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(ctx, args) {
      try {
        const abs = guardCanonical(ctx, args.path);
        const st = await fsp.stat(abs);
        return ok({ size: st.size, is_dir: st.isDirectory(), is_file: st.isFile(), mtime: st.mtimeMs, ctime: st.ctimeMs });
      } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('STAT_FAILED', e.message); }
    }
  },
  {
    name: 'create_directory', description: '创建文件夹（父文件夹必须存在，碰撞时拒绝）。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    exec: createDirectoryMutation
  },
  {
    name: 'create_file', description: '创建新文件（若已存在则失败）。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '文件内容' } }, required: ['path', 'content'] },
    exec: createFileMutation
  },
  {
    name: 'write_file', description: '写入/覆盖文件（整文件；原子替换 + stale-write 保护）。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, expected_sha256: { type: 'string', description: '可选：基于本 run 真实读取的观察哈希，不一致则拒绝写入' }, record_change: { type: 'boolean', description: '是否记录到 file_changes（默认 true）' } }, required: ['path', 'content'] },
    async exec(ctx, args) {
      try {
        const abs = guardCanonical(ctx, args.path);
        let before = null;
        if (fs.existsSync(abs)) before = await fsp.readFile(abs, 'utf8');
        // v2.9.8 R3：已有文件的 stale-write 保护（外部并发修改 → fail-closed）
        if (before !== null) {
          const stale = checkStaleWrite(ctx, abs, before, args.expected_sha256);
          if (!stale.ok) return stale;
        } else if (args.expected_sha256) {
          return fail('EXPECTED_HASH_NOT_OBSERVED', '目标文件不存在，expected_sha256 无真实读取证据', false);
        }
        // §66 execution-time recheck immediately before mutation
        recheckMutationTarget(ctx, args.path);
        // v2.9.8 R3：原子替换（同目录 temp → rename），失败不留下半个文件
        await atomicWriteFile(ctx, abs, args.content || '');
        observeFile(ctx, abs, args.content || '');
        if (args.record_change !== false && ctx.store) {
          const { diff } = require('./patch');
          const d = diff(before || '', args.content);
          ctx.store.fileChanges.create({ projectId: ctx.projectId, taskId: ctx.taskId, agentId: ctx.agentId, path: args.path, before, after: args.content, diff: d });
          if (ctx.emit) ctx.emit('file_changed', { path: args.path, diff: d, taskId: ctx.taskId });
        }
        return ok({ written: args.path, bytes: (args.content || '').length });
      } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('WRITE_FAILED', e.message); }
    }
  },
  {
    name: 'move_file', description: '移动/重命名文件或目录（目标已存在时默认失败）。', risk_level: 'high', permission: 'filesystem.delete',
    input_schema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, replace: { type: 'boolean', description: '目标已存在时是否显式允许覆盖（默认 false）' } }, required: ['source', 'destination'] },
    exec: moveFileMutation
  },
  {
    name: 'copy_file', description: '复制文件（目标已存在时默认失败）。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, replace: { type: 'boolean', description: '目标已存在时是否显式允许覆盖（默认 false）' } }, required: ['source', 'destination'] },
    async exec(ctx, args) {
      try {
        // §80: source 与 destination 都必须 canonical inside
        const a = guardCanonical(ctx, args.source);
        const b = guardCanonical(ctx, args.destination);
        recheckMutationTarget(ctx, args.source);
        recheckMutationTarget(ctx, args.destination);
        await fsp.mkdir(path.dirname(b), { recursive: true });
        // v2.9.8 R3：COPYFILE_EXCL —— 目标已存在时 fail，除非显式 replace
        const flags = args.replace === true ? 0 : fs.constants.COPYFILE_EXCL;
        try {
          await fsp.copyFile(a, b, flags);
        } catch (e) {
          if (e && e.code === 'EEXIST') return fail('DESTINATION_EXISTS', `${args.destination} 已存在，复制被拒绝（显式 replace=true 才允许覆盖）`, false);
          throw e;
        }
        return ok({ copied: args.source, to: args.destination });
      } catch (e) { return e instanceof PathSecurityError ? fail(compatCode(e.code), e.message) : fail('COPY_FAILED', e.message); }
    }
  },
  {
    name: 'delete_file', description: '删除文件或（空）目录。高风险，需权限确认。', risk_level: 'high', permission: 'filesystem.delete',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    exec: deleteFileMutation
  },
  {
    name: 'delete_directory', description: '递归删除项目内文件夹。高风险，需权限确认。', risk_level: 'high', permission: 'filesystem.delete',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    exec: deleteDirectoryMutation
  }
];

module.exports = { tools, workbenchMutations, atomicWriteFile, observeFile, checkStaleWrite, sha256Hex };
