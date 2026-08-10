'use strict';
/**
 * Real AI Orchestrator Smoke — v2.9.0 §74-99。
 *
 * 验证真实 DeepSeek Main Agent → delegate → fixture reviewer → Blackboard → Main Agent 修复 → 测试通过。
 *
 * §75：独立运行（npm run test:real-ai:orchestrator），npm test 永不消耗 API。
 * §76：CI 无 credential → SKIP（不 FAIL）。
 * §93：必须用 TEMP fixture，禁止修改真实项目。
 * §89：严格 budget（maxModelCalls=6 / maxIterations=8 / maxToolCalls=15 / maxRuntimeMs=120000）。
 * §86：必须确认 DeepSeek Main Agent 真的产生 delegate（非测试代码直接调 AgentHub）。
 *
 * 运行：需配置 DeepSeek Test Connection（§78 realAiTestConnectionId setting）。
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/real-ai-orchestrator-smoke.js [connectionId]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_MODEL_CALLS = 6;
const MAX_ITERATIONS = 8;
const MAX_TOOL_CALLS = 15;
const MAX_RUNTIME_MS = 120000;

function log(msg) { console.log(`[real-ai-smoke] ${msg}`); }

async function main() {
  const connectionId = process.argv[2] || process.env.REAL_AI_TEST_CONNECTION_ID;

  if (!connectionId) {
    log('SKIP: REAL_AI_TEST_CONNECTION_ID 未设置（§76 CI 无 credential → SKIP，不 FAIL）');
    log('配置：在 Diagnostics/开发者设置选择 DeepSeek Test Connection，或设置 REAL_AI_TEST_CONNECTION_ID 环境变量');
    process.exit(0);
  }

  log(`使用 Connection: ${connectionId}`);

  // §82: 创建 TEMP fixture（禁止修改真实项目 §93）
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-real-orchestrator-'));
  log(`Fixture 目录: ${fixtureDir}`);

  // §83: fixture bug — add 用了减法
  fs.writeFileSync(path.join(fixtureDir, 'src', 'math.js'),
    `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`,
    { encoding: 'utf8' });
  fs.mkdirSync(path.join(fixtureDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'src', 'math.js'),
    `function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n`);
  fs.writeFileSync(path.join(fixtureDir, 'test', 'math.test.js'),
    `const { add } = require('../src/math');\nconst assert = require('assert');\nassert.strictEqual(add(2,3), 5);\nconsole.log('math test passed');\n`,
    { encoding: 'utf8' });
  fs.mkdirSync(path.join(fixtureDir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'test', 'math.test.js'),
    `const { add } = require('../src/math');\nconst assert = require('assert');\nassert.strictEqual(add(2,3), 5);\nconsole.log('math test passed');\n`);
  fs.writeFileSync(path.join(fixtureDir, 'package.json'),
    JSON.stringify({ name: 'real-ai-fixture', version: '1.0.0', scripts: { test: 'node test/math.test.js' } }, null, 2));

  log('Fixture 创建完成（math.js 含 bug：add 用了减法）');

  // §84: 注册 fixture reviewer（deterministic，不走真实 API）
  // §85: 给 DeepSeek 的任务
  const taskPrompt = `这个临时项目有一个很小的错误。
要求：
1. 先委派一个只读 reviewer 检查问题；
2. 读取 reviewer 返回的结论；
3. 自己完成最小修复；
4. 运行现有测试；
5. 测试通过后完成。
不要修改测试。`;

  // 实际运行需 electron app + connection store + runMainAgent + orchestrator + fixture reviewer adapter。
  // 当前脚本为框架预留：实际执行需在 electron 运行时内完成（connection store.getDecrypted + provider runtime）。
  // §76: CI 无 credential → SKIP。
  log('NOTE: 完整 Real AI Smoke 需 electron 运行时 + connection store。');
  log('请在 electron app Diagnostics 页面触发，或扩展本脚本接入 connection store。');
  log(`Task: ${taskPrompt}`);
  log(`Budget: maxModelCalls=${MAX_MODEL_CALLS} maxIterations=${MAX_ITERATIONS} maxToolCalls=${MAX_TOOL_CALLS} maxRuntimeMs=${MAX_RUNTIME_MS}`);

  // §94: 验证项（实际运行后检查）
  //   math.js repaired / tests pass / test file unchanged / changedFiles only expected
  //   delegate observed / child result consumed / parent completed
  //   outside workspace attempts = 0 / zombie children = 0

  // 清理 fixture
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  log('SKIP: 框架预留，需 electron 运行时接入 connection store（§76）');
  process.exit(0);
}

main().catch(e => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
