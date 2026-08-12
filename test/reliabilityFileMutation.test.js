'use strict';
/**
 * v2.9.8 Real Project Reliability — R3.
 *
 * Atomic File Mutation + Concurrent Change Protection:
 *  - stale-write protection（观察证据来自真实读取，模型不得凭空生成 hash）
 *  - write_file 原子替换（失败注入后原文件字节不变）
 *  - create_file exclusive create（无 TOCTOU 覆盖）
 *  - move/copy destination 碰撞明确失败（除非显式 replace）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getBuiltin } = require('../src/tools/registry');

function makeCtx(root, extra = {}) {
  return { projectRoot: root, projectId: 'rpr-files', taskId: 'rpr-task', store: null, emit: () => {}, ...extra };
}

function freshProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rpr-files-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

test('R3 concurrent edit: stale write is rejected and external change survives', async () => {
  const root = freshProject();
  try {
    const cfg = path.join(root, 'src', 'config.js');
    fs.writeFileSync(cfg, 'module.exports = { version: "A" };\n', 'utf8');
    const ctx = makeCtx(root);

    // Agent 真实读取（记录观察证据）
    const read = await getBuiltin('read_file').exec(ctx, { path: 'src/config.js' });
    assert.strictEqual(read.ok, true);
    assert.ok(read.data.content.includes('version: "A"'));

    // Agent 写入前，外部进程修改了文件
    fs.appendFileSync(cfg, '// EXTERNAL_EDIT_MARKER_7281\n', 'utf8');

    // Agent 基于旧内容写入 → 必须 fail-closed
    const write = await getBuiltin('write_file').exec(ctx, {
      path: 'src/config.js',
      content: 'module.exports = { version: "B" };\n'
    });
    assert.strictEqual(write.ok, false);
    assert.strictEqual(write.error.code, 'FILE_CHANGED_SINCE_READ');

    const after = fs.readFileSync(cfg, 'utf8');
    assert.ok(after.includes('EXTERNAL_EDIT_MARKER_7281'), 'external edit survives');
    assert.ok(!after.includes('version: "B"'), 'old agent content not written');

    // Agent 重新读取后再写 → 允许
    const reread = await getBuiltin('read_file').exec(ctx, { path: 'src/config.js' });
    assert.strictEqual(reread.ok, true);
    const write2 = await getBuiltin('write_file').exec(ctx, {
      path: 'src/config.js',
      content: reread.data.content + 'module.exports.extra = true;\n'
    });
    assert.strictEqual(write2.ok, true, JSON.stringify(write2));
    assert.ok(fs.readFileSync(cfg, 'utf8').includes('EXTERNAL_EDIT_MARKER_7281'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3 expected_sha256 must be real read evidence (fabricated hashes rejected)', async () => {
  const root = freshProject();
  try {
    const f = path.join(root, 'src', 'data.txt');
    fs.writeFileSync(f, 'original\n', 'utf8');
    const ctx = makeCtx(root);

    // 凭空生成的 hash（本 run 从未读取）→ 拒绝
    const fabricated = await getBuiltin('write_file').exec(ctx, {
      path: 'src/data.txt', content: 'evil\n',
      expected_sha256: 'deadbeef'.repeat(8)
    });
    assert.strictEqual(fabricated.ok, false);
    assert.strictEqual(fabricated.error.code, 'EXPECTED_HASH_NOT_OBSERVED');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'original\n');

    // 真实读取后的 hash 才是有效 token
    const { sha256Hex } = require('../src/tools/filesystem');
    await getBuiltin('read_file').exec(ctx, { path: 'src/data.txt' });
    const valid = await getBuiltin('write_file').exec(ctx, {
      path: 'src/data.txt', content: 'updated\n',
      expected_sha256: sha256Hex('original\n')
    });
    assert.strictEqual(valid.ok, true, JSON.stringify(valid));
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'updated\n');

    // apply_patch 同样受 stale-write 保护
    const stalePatch = await getBuiltin('apply_patch').exec(ctx, {
      path: 'src/data.txt',
      patch: '@@ -1,1 +1,1 @@\n-updated\n+hacked',
      expected_sha256: 'deadbeef'.repeat(8)
    });
    assert.strictEqual(stalePatch.ok, false);
    assert.strictEqual(stalePatch.error.code, 'EXPECTED_HASH_NOT_OBSERVED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3 write_file atomicity: injected failure before replace leaves original bytes intact', async () => {
  const root = freshProject();
  try {
    const f = path.join(root, 'src', 'atomic.txt');
    fs.writeFileSync(f, 'ATOMIC_ORIGINAL_MARKER_5512\n', 'utf8');
    let faultTriggered = false;
    const ctx = makeCtx(root, {
      __testWriteFault: () => { faultTriggered = true; throw new Error('injected disk failure before final replace'); }
    });

    const write = await getBuiltin('write_file').exec(ctx, {
      path: 'src/atomic.txt', content: 'ATOMIC_NEW_CONTENT\n'
    });
    assert.strictEqual(faultTriggered, true);
    assert.strictEqual(write.ok, false);
    assert.strictEqual(write.error.code, 'WRITE_FAILED');

    // 原文件字节不变，且没有残留 temp 文件
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'ATOMIC_ORIGINAL_MARKER_5512\n');
    const leftovers = fs.readdirSync(path.join(root, 'src')).filter(n => n.includes('.adp-tmp-'));
    assert.deepStrictEqual(leftovers, [], 'no temp file residue');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3 create_file is exclusive: existing file is never overwritten (no TOCTOU)', async () => {
  const root = freshProject();
  try {
    const f = path.join(root, 'src', 'existing.txt');
    fs.writeFileSync(f, 'user content\n', 'utf8');
    const ctx = makeCtx(root);

    const created = await getBuiltin('create_file').exec(ctx, { path: 'src/existing.txt', content: 'overwrite attempt\n' });
    assert.strictEqual(created.ok, false);
    assert.strictEqual(created.error.code, 'FILE_EXISTS');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'user content\n');

    // 新文件仍可创建
    const ok = await getBuiltin('create_file').exec(ctx, { path: 'src/new.txt', content: 'fresh\n' });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'fresh\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R3 move/copy destination collision fails unless explicitly replaced', async () => {
  const root = freshProject();
  try {
    const ctx = makeCtx(root);
    fs.writeFileSync(path.join(root, 'src', 'source.txt'), 'SOURCE\n', 'utf8');
    fs.writeFileSync(path.join(root, 'src', 'dest.txt'), 'UNKNOWN_USER_FILE\n', 'utf8');

    // move：碰撞 → 明确失败，不静默毁掉用户文件
    const moveDenied = await getBuiltin('move_file').exec(ctx, { source: 'src/source.txt', destination: 'src/dest.txt' });
    assert.strictEqual(moveDenied.ok, false);
    assert.strictEqual(moveDenied.error.code, 'DESTINATION_EXISTS');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'dest.txt'), 'utf8'), 'UNKNOWN_USER_FILE\n');
    assert.ok(fs.existsSync(path.join(root, 'src', 'source.txt')));

    // copy：同样失败
    const copyDenied = await getBuiltin('copy_file').exec(ctx, { source: 'src/source.txt', destination: 'src/dest.txt' });
    assert.strictEqual(copyDenied.ok, false);
    assert.strictEqual(copyDenied.error.code, 'DESTINATION_EXISTS');
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'dest.txt'), 'utf8'), 'UNKNOWN_USER_FILE\n');

    // 显式 replace 才允许
    const copyReplace = await getBuiltin('copy_file').exec(ctx, { source: 'src/source.txt', destination: 'src/dest.txt', replace: true });
    assert.strictEqual(copyReplace.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'dest.txt'), 'utf8'), 'SOURCE\n');

    // move 到不存在目标正常
    const moveOk = await getBuiltin('move_file').exec(ctx, { source: 'src/source.txt', destination: 'src/moved.txt' });
    assert.strictEqual(moveOk.ok, true);
    assert.ok(fs.existsSync(path.join(root, 'src', 'moved.txt')));
    assert.strictEqual(fs.existsSync(path.join(root, 'src', 'source.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
