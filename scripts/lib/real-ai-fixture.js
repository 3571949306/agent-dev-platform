'use strict';
/**
 * v2.9.0 Framework Closure Patch — Real AI Smoke Fixture Builder（spec §20-22）。
 *
 * 创建临时 fixture 项目：src/math.js（含 bug：add 用了减法）+ test/math.test.js（断言 add(2,3)===5）。
 *
 * §20 bug 修复：先 mkdir(src/test) 再 writeFile；删除重复写入。
 * §22：返回 { root, sourcePath, testPath, originalTestContent, sha256Test, cleanup }。
 *
 * 禁止修改真实项目（§93）；fixture 必须落在 TEMP 目录，run 后由 cleanup 删除。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function sha256File(p) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

function createRealAiFixture() {
  // §20: 先建目录，再写文件
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-real-orchestrator-'));
  const srcDir = path.join(root, 'src');
  const testDir = path.join(root, 'test');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  const sourcePath = path.join(srcDir, 'math.js');
  const testPath = path.join(testDir, 'math.test.js');

  // §20 bug 修复：此处只写一次，不再重复 writeFileSync
  fs.writeFileSync(sourcePath,
    `'use strict';\nfunction add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`,
    { encoding: 'utf8' });
  fs.writeFileSync(testPath,
    `'use strict';\nconst { add } = require('../src/math');\nconst assert = require('assert');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('math test passed');\n`,
    { encoding: 'utf8' });
  fs.writeFileSync(path.join(root, 'package.json'),
    JSON.stringify({ name: 'real-ai-fixture', version: '1.0.0', scripts: { test: 'node test/math.test.js' } }, null, 2));

  const originalTestContent = fs.readFileSync(testPath, 'utf8');
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }
  }

  return {
    root,
    sourcePath,
    testPath,
    fixtureRoot: root,
    originalTestContent,
    originalSourceContent: fs.readFileSync(sourcePath, 'utf8'),
    sha256Test: sha256File(testPath),
    cleanup
  };
}

module.exports = { createRealAiFixture, sha256File };
