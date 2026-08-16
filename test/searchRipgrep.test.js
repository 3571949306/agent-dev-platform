'use strict';
/**
 * v2.9.9 体验对标 Phase 3 — search 真用 ripgrep 测试。
 *
 * 有 rg：对临时目录跑真实 rgSearch/rgFindFiles，断言结果结构与旧 jsGrep/jsFindFiles 一致。
 * 无 rg：rgSearch/rgFindFiles 返回 null（触发 fallback），jsGrep/jsFindFiles 行为不变（回归保护）。
 * 两种环境都必须通过（用 hasRipgrep() 分支决定断言，不假设 rg 一定存在）。
 * 不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { jsGrep, jsFindFiles, hasRipgrep, rgSearch, rgFindFiles } = require('../src/tools/search');

function makeTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-rg-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const hello = 1;\nconsole.log(hello);\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'hello world\n');
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'hello should be excluded\n');
  return dir;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* noop */ } }

test('hasRipgrep 返回布尔且进程级缓存', async () => {
  const a = await hasRipgrep();
  const b = await hasRipgrep();
  assert.strictEqual(typeof a, 'boolean');
  assert.strictEqual(a, b, '缓存结果应一致');
});

test('search_text：rg 与 js 结果结构一致 / 无 rg 时 fallback', async () => {
  const dir = makeTree();
  try {
    const useRg = await hasRipgrep();
    const jsRes = await jsGrep(dir, 'hello', 50);
    assert.ok(jsRes.some(r => r.path === 'a.js'), 'js 路径应命中 a.js');
    assert.ok(!jsRes.some(r => r.path.startsWith('node_modules')), 'js 路径应排除 node_modules');
    if (useRg) {
      const rgOut = await rgSearch(dir, 'hello', { maxResults: 50 });
      const rgRes = rgOut.matches;
      assert.ok(Array.isArray(rgRes), 'rg 应返回 matches 数组');
      assert.ok(rgRes.some(r => r.path === 'a.js'), 'rg 应命中 a.js');
      assert.ok(!rgRes.some(r => r.path.startsWith('node_modules')), 'rg 应排除 node_modules');
      for (const r of rgRes) {
        assert.strictEqual(typeof r.path, 'string');
        assert.strictEqual(typeof r.line, 'number');
        assert.strictEqual(typeof r.column, 'number');
        assert.strictEqual(typeof r.preview, 'string');
      }
    } else {
      assert.strictEqual(await rgSearch(dir, 'hello'), null, '无 rg 时 rgSearch 应返回 null 触发 fallback');
    }
  } finally { rm(dir); }
});

test('search_files：rg 与 js 通配语义一致 / 无 rg 时 fallback', async () => {
  const dir = makeTree();
  try {
    const useRg = await hasRipgrep();
    const jsRes = await jsFindFiles(dir, '*.js', 50);
    assert.ok(jsRes.some(r => r.path === 'a.js'));
    if (useRg) {
      const rgOut = await rgFindFiles(dir, '*.js', { maxResults: 50 });
      const rgRes = rgOut.files;
      assert.ok(Array.isArray(rgRes));
      assert.ok(rgRes.some(r => r.path === 'a.js'));
      assert.ok(!rgRes.some(r => r.path.startsWith('node_modules')), 'rg 应排除 node_modules');
    } else {
      assert.strictEqual(await rgFindFiles(dir, '*.js'), null, '无 rg 时 rgFindFiles 应返回 null');
    }
  } finally { rm(dir); }
});

test('rg pattern 作为独立 argv 传递（注入安全）：含 shell 元字符不报错且不执行', async () => {
  const dir = makeTree();
  try {
    const useRg = await hasRipgrep();
    // 恶意 pattern 若被拼进 shell 会执行命令；作为 argv 则只被当作正则/字面量
    const malicious = 'hello; echo pwned';
    if (useRg) {
      const res = await rgSearch(dir, malicious, { maxResults: 10 });
      // 不抛错、不产生 pwned 副作用；结果为数组（可能为空）
      assert.ok(Array.isArray(res) || res === null);
    } else {
      // js 路径：RegExp('hello; echo pwned') 合法，仅文本匹配
      const res = await jsGrep(dir, malicious, 10);
      assert.ok(Array.isArray(res));
    }
  } finally { rm(dir); }
});
