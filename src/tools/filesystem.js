'use strict';
/**
 * Filesystem tools — real local file operations with strict workspace containment.
 * Every tool resolves its path through WorkspacePathGuard before touching disk.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { guard, verifyNoSymlinkEscape, PathGuardError } = require('../security/pathguard');

const MAX_READ = 5 * 1024 * 1024; // 5MB full read cap

function looksBinary(buf) {
  // scan first 8KB for NUL byte
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = false) { return { ok: false, error: { code, message, retryable } }; }

async function safeRead(ctx, absPath) {
  await verifyNoSymlinkEscape(ctx.projectRoot, absPath);
  const stat = await fsp.stat(absPath);
  if (stat.isDirectory()) return fail('IS_DIRECTORY', `${absPath} 是目录，不是文件`);
  if (stat.size > MAX_READ) {
    return fail('FILE_TOO_LARGE', `文件 ${stat.size} 字节超过单次读取上限 ${MAX_READ}，请使用 read_file_range 或搜索`, false);
  }
  const buf = await fsp.readFile(absPath);
  if (looksBinary(buf)) return fail('BINARY_FILE', '检测到二进制文件，无法作为文本读取', false);
  return ok({ content: buf.toString('utf8'), size: stat.size });
}

const tools = [
  {
    name: 'list_directory', description: '列出目录内容（文件与子目录）。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: '目录路径，相对于项目根' } }, required: ['path'] },
    async exec(ctx, args) {
      const abs = guard(ctx.projectRoot, args.path || '.');
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
      try { const abs = guard(ctx.projectRoot, args.path); return await safeRead(ctx, abs); }
      catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('READ_FAILED', e.message); }
    }
  },
  {
    name: 'read_file_range', description: '按行号范围读取文件片段（适合大文件）。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number', description: '起始行（从1开始）' }, end_line: { type: 'number', description: '结束行（含）' } }, required: ['path'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, args.path);
        await verifyNoSymlinkEscape(ctx.projectRoot, abs);
        const start = args.start_line ? Math.max(1, args.start_line) : 1;
        const end = args.end_line || start + 200;
        const content = await fsp.readFile(abs, 'utf8');
        const lines = content.split(/\r?\n/);
        const slice = lines.slice(start - 1, end);
        return ok({ content: slice.join('\n'), start_line: start, end_line: start - 1 + slice.length, total_lines: lines.length });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('READ_FAILED', e.message); }
    }
  },
  {
    name: 'file_exists', description: '检查文件或目录是否存在。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(ctx, args) {
      try { const abs = guard(ctx.projectRoot, args.path); return ok({ exists: fs.existsSync(abs) }); }
      catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('CHECK_FAILED', e.message); }
    }
  },
  {
    name: 'get_file_metadata', description: '获取文件大小、修改时间、是否为目录。', risk_level: 'low', permission: 'filesystem.read',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, args.path);
        const st = await fsp.stat(abs);
        return ok({ size: st.size, is_dir: st.isDirectory(), is_file: st.isFile(), mtime: st.mtimeMs, ctime: st.ctimeMs });
      } catch (e) { return fail('STAT_FAILED', e.message); }
    }
  },
  {
    name: 'create_file', description: '创建新文件（若已存在则失败）。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '文件内容' } }, required: ['path', 'content'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, args.path);
        if (fs.existsSync(abs)) return fail('FILE_EXISTS', `${args.path} 已存在，请使用 write_file 覆盖或先删除`);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, args.content || '', 'utf8');
        return ok({ created: args.path });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('CREATE_FAILED', e.message); }
    }
  },
  {
    name: 'write_file', description: '写入/覆盖文件（整文件）。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, record_change: { type: 'boolean', description: '是否记录到 file_changes（默认 true）' } }, required: ['path', 'content'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, args.path);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        let before = null;
        if (fs.existsSync(abs)) before = await fsp.readFile(abs, 'utf8');
        await fsp.writeFile(abs, args.content || '', 'utf8');
        if (args.record_change !== false && ctx.store) {
          const { diff } = require('./patch');
          const d = diff(before || '', args.content);
          ctx.store.fileChanges.create({ projectId: ctx.projectId, taskId: ctx.taskId, agentId: ctx.agentId, path: args.path, before, after: args.content, diff: d });
          if (ctx.emit) ctx.emit('file_changed', { path: args.path, diff: d, taskId: ctx.taskId });
        }
        return ok({ written: args.path, bytes: (args.content || '').length });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('WRITE_FAILED', e.message); }
    }
  },
  {
    name: 'move_file', description: '移动/重命名文件或目录。', risk_level: 'high', permission: 'filesystem.delete',
    input_schema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] },
    async exec(ctx, args) {
      try {
        const a = guard(ctx.projectRoot, args.source);
        const b = guard(ctx.projectRoot, args.destination);
        await fsp.mkdir(path.dirname(b), { recursive: true });
        await fsp.rename(a, b);
        return ok({ moved: args.source, to: args.destination });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('MOVE_FAILED', e.message); }
    }
  },
  {
    name: 'copy_file', description: '复制文件。', risk_level: 'medium', permission: 'filesystem.write',
    input_schema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source', 'destination'] },
    async exec(ctx, args) {
      try {
        const a = guard(ctx.projectRoot, args.source);
        const b = guard(ctx.projectRoot, args.destination);
        await fsp.mkdir(path.dirname(b), { recursive: true });
        await fsp.copyFile(a, b);
        return ok({ copied: args.source, to: args.destination });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('COPY_FAILED', e.message); }
    }
  },
  {
    name: 'delete_file', description: '删除文件或（空）目录。高风险，需权限确认。', risk_level: 'high', permission: 'filesystem.delete',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async exec(ctx, args) {
      try {
        const abs = guard(ctx.projectRoot, args.path);
        const st = await fsp.stat(abs);
        if (st.isDirectory()) await fsp.rmdir(abs); else await fsp.unlink(abs);
        return ok({ deleted: args.path });
      } catch (e) { return e instanceof PathGuardError ? fail(e.code, e.message) : fail('DELETE_FAILED', e.message); }
    }
  }
];

module.exports = { tools };
