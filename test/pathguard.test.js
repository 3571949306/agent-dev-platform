'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { guard, isInside, normalizeRoot, PathGuardError } = require('../src/security/pathguard');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-guard-'));
fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'src', 'a.txt'), 'hello');

test('相对路径解析为工作区内绝对路径', () => {
  const p = guard(ROOT, 'src/a.txt');
  assert.strictEqual(p, path.join(ROOT, 'src', 'a.txt'));
});

test('允许工作区根自身', () => {
  assert.strictEqual(guard(ROOT, '.'), normalizeRoot(ROOT));
});

test('拦截 ../ 逃逸', () => {
  assert.throws(() => guard(ROOT, '../../Windows/System32/drivers/etc/hosts'), (e) => {
    assert.ok(e instanceof PathGuardError);
    assert.strictEqual(e.code, 'PATH_OUTSIDE_WORKSPACE');
    return true;
  });
});

test('拦截混合分隔符逃逸 (..\\..\\)', () => {
  assert.throws(() => guard(ROOT, '..\\..\\secret.txt'), /超出工作区范围/);
});

test('拦截指向工作区外的绝对路径', () => {
  const outside = path.join(os.tmpdir(), 'definitely-outside-' + Date.now() + '.txt');
  assert.throws(() => guard(ROOT, outside), /超出工作区范围/);
});

test('接受指向工作区内的绝对路径', () => {
  const inside = path.join(ROOT, 'src', 'a.txt');
  assert.strictEqual(guard(ROOT, inside), inside);
});

test('空路径被拒绝', () => {
  assert.throws(() => guard(ROOT, ''), /路径不能为空/);
});

test('前缀相似的兄弟目录不算在内 (root vs root-evil)', () => {
  assert.strictEqual(isInside(ROOT, ROOT + '-evil/x.txt'), false);
  assert.strictEqual(isInside(ROOT, path.join(ROOT, 'x.txt')), true);
});

test('深层嵌套 ../ 回到区内是允许的', () => {
  assert.strictEqual(guard(ROOT, 'src/../src/a.txt'), path.join(ROOT, 'src', 'a.txt'));
});
