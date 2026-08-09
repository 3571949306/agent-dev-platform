'use strict';
/**
 * v2.6.0 — Main Agent Loop 集成测试辅助：把 coding-agent fixture 复制到临时目录，
 * 让测试可以真实修改文件而不污染源 fixture。每次 reset 恢复到「有 bug」基线。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

// reset.js 自身就位于 fixture 目录内，__dirname 即为 fixture 根。
// 之前误写成 path.join(__dirname,'..','..','test','fixtures','coding-agent')，
// 会得到 ...\test\test\fixtures\coding-agent（双重 test），导致 copyFixture ENOENT。
const FIXTURE = __dirname;

const BROKEN_MATH = `'use strict';
// Fake Coding Project fixture — Main Agent 自主编码测试项目（spec §34）。
// 故意有 Bug：add 函数返回 a - b，应当返回 a + b。

function add(a, b) {
  return a - b;
}

function subtract(a, b) {
  return a - b;
}

module.exports = { add, subtract };
`;

/** 复制 fixture 到临时目录，返回临时 projectRoot。 */
async function copyFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-coding-'));
  await fsp.mkdir(path.join(tmp, 'src'), { recursive: true });
  await fsp.mkdir(path.join(tmp, 'test'), { recursive: true });
  await fsp.writeFile(path.join(tmp, 'src', 'math.js'), BROKEN_MATH, 'utf8');
  await fsp.writeFile(path.join(tmp, 'test', 'math.test.js'),
    fs.readFileSync(path.join(FIXTURE, 'test', 'math.test.js'), 'utf8'), 'utf8');
  await fsp.writeFile(path.join(tmp, 'package.json'),
    fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8'), 'utf8');
  return tmp;
}

/** 重置 math.js 到「有 bug」基线。 */
async function resetToBroken(root) {
  await fsp.writeFile(path.join(root, 'src', 'math.js'), BROKEN_MATH, 'utf8');
}

/** 清理临时目录。 */
async function cleanup(root) {
  try { await fsp.rm(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

module.exports = { copyFixture, resetToBroken, cleanup, FIXTURE, BROKEN_MATH };
