'use strict';
/**
 * v2.3.0 — Run 状态机契约测试。
 *
 * 验证：
 *  - externalAgents.TERMINAL_STATES 与 i18n.isTerminal 的终态集合一致（后者是超集）
 *  - runCodex 在缺少配置时返回合法 failed 结果（不抛异常、不卡死），保证 Spinner 终有收尾
 *  - run_state_changed 事件使用的 status 枚举闭合：终态被 isTerminal 识别，其余不被识别
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ext = require('../src/services/externalAgents');

async function loadI18n() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), 'i18n-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(tmp, src);
  try {
    return await import('file://' + tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

test('TERMINAL_STATES 是 isTerminal 的子集', async () => {
  const i18n = await loadI18n();
  for (const s of ext.TERMINAL_STATES) {
    assert.strictEqual(i18n.isTerminal(s), true, `externalAgent 终态 ${s} 必须被 isTerminal 识别`);
  }
  // isTerminal 额外覆盖 interrupted，保证「用户中断」也能收尾 Spinner
  assert.strictEqual(i18n.isTerminal('interrupted'), true);
});

test('runCodex 失败结果带有合法 status 与错误', async () => {
  // 没有任何 CLI / 连接配置时，必须返回 failed 结构化结果，而不是抛异常或卡死
  const raw = await ext.runCodex({ config: { cliMode: 'auto' } }, 'task', null, {});
  const parsed = JSON.parse(raw);
  assert.ok(['failed', 'timeout', 'cancelled'].includes(parsed.status), '应为失败类状态，实际: ' + parsed.status);
  assert.ok(Array.isArray(parsed.errors), '应有 errors 数组');
  assert.strictEqual(parsed.status, 'failed');
});

test('run_state_changed 使用的 status 枚举闭合', async () => {
  const i18n = await loadI18n();
  const known = [
    'preparing', 'requesting_model', 'streaming', 'executing_tool',
    'waiting_permission', 'waiting_subagent', 'waiting_external_agent',
    'testing', 'completed', 'failed', 'cancelled', 'timeout', 'interrupted'
  ];
  for (const s of known) {
    if (['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(s)) {
      assert.strictEqual(i18n.isTerminal(s), true, s + ' 应终态');
    } else {
      assert.strictEqual(i18n.isTerminal(s), false, s + ' 应非终态');
    }
  }
});
