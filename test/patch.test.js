'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { diff, applyToLines, parseHunks, tools } = require('../src/tools/patch');

const applyPatch = tools.find(t => t.name === 'apply_patch');

test('diff 生成统一 diff 头', () => {
  const d = diff('a\nb\nc', 'a\nB\nc');
  assert.ok(d.startsWith('@@ -1,'), d);
  assert.ok(d.includes('-b'));
  assert.ok(d.includes('+B'));
  assert.ok(d.includes(' a'));
});

test('diff -> applyToLines 往返一致', () => {
  const before = 'line1\nline2\nline3\nline4';
  const after = 'line1\nlineTWO\nline3\nline4\nline5';
  const d = diff(before, after);
  const out = applyToLines(before.split('\n'), d).join('\n');
  assert.strictEqual(out, after);
});

test('parseHunks 解析多个 hunk', () => {
  const p = '@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -10,1 +10,2 @@\n j\n+k';
  const hs = parseHunks(p);
  assert.strictEqual(hs.length, 2);
  assert.strictEqual(hs[0].oldStart, 1);
  assert.strictEqual(hs[1].oldStart, 10);
});

test('上下文不匹配时报出精确行号', () => {
  assert.throws(() => applyToLines(['a', 'x', 'c'], '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c'),
    /删除内容不匹配（行 2）/);
});

test('空 patch 报错', () => {
  assert.throws(() => applyToLines(['a'], 'not a patch'), /未找到有效 hunk/);
});

test('apply_patch 工具真正写入磁盘并返回 ok', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-patch-'));
  fs.writeFileSync(path.join(root, 'f.txt'), 'a\nb\nc');
  const ctx = { projectRoot: root, store: null, emit: null };
  const r = await applyPatch.exec(ctx, { path: 'f.txt', patch: '@@ -1,3 +1,3 @@\n a\n-b\n+BEE\n c', record_change: false });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(path.join(root, 'f.txt'), 'utf8'), 'a\nBEE\nc');
});

test('apply_patch 越界路径被 pathguard 拦截', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-patch2-'));
  const ctx = { projectRoot: root, store: null, emit: null };
  const r = await applyPatch.exec(ctx, { path: '../evil.txt', patch: '@@ -1,1 +1,1 @@\n+x', record_change: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'PATH_OUTSIDE_WORKSPACE');
});

test('apply_patch 失败时返回可重试错误而非抛异常', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-patch3-'));
  fs.writeFileSync(path.join(root, 'f.txt'), 'a\nb\nc');
  const ctx = { projectRoot: root, store: null, emit: null };
  const r = await applyPatch.exec(ctx, { path: 'f.txt', patch: '@@ -1,3 +1,3 @@\n a\n-ZZZ\n+B\n c', record_change: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'PATCH_FAILED');
  assert.strictEqual(r.error.retryable, true);
  assert.match(r.error.message, /不匹配/);
});
