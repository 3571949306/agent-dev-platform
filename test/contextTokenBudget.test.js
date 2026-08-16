'use strict';
/**
 * v2.9.9 体验对标 Phase 4 — Context 近似 Token 预算测试。
 *
 *  - approxTokens：ASCII/4 + 非ASCII/1.5 近似
 *  - 超大 toolResults 下 buildContext 输出不超预算，且目标/计划始终完整保留
 *  - onTokens 回调暴露估算值
 * 不产生任何真实/付费模型调用。
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { buildContext, approxTokens } = require('../src/agent/runtime/contextBuilder');

test('approxTokens 近似公式', () => {
  assert.strictEqual(approxTokens('a'.repeat(400)), 100, 'ASCII 400/4=100');
  assert.strictEqual(approxTokens('中'.repeat(150)), 100, '中文 150/1.5=100');
  assert.strictEqual(approxTokens(''), 0);
});

test('超大 toolResults → 输出不超预算且目标/计划保留', () => {
  const big = [];
  for (let i = 0; i < 40; i++) big.push({ ok: true, tool: 'search', summary: 'x'.repeat(3000) });
  let reported = null;
  const out = buildContext({
    goal: '修复构建',
    plan: { tasks: [{ title: 't1', status: 'in_progress' }] },
    blackboard: { goal: '修复构建', problems: [], completed: [], importantFiles: [], confirmed: [], pending: [] },
    toolResults: big,
    projectSummary: 'proj',
    iteration: 3, repairRounds: 0,
    maxContextTokens: 2000,
    onTokens: (t, max) => { reported = { t, max }; }
  });
  assert.ok(approxTokens(out) <= 2000, `输出应不超预算 (got ${approxTokens(out)})`);
  assert.ok(out.includes('用户目标：修复构建'), '目标必须完整保留');
  assert.ok(out.includes('# 执行计划'), '计划必须完整保留');
  assert.ok(reported && reported.max === 2000, 'onTokens 应暴露估算值');
});

test('预算充足时不裁剪（保留全部最近结果）', () => {
  const small = [{ ok: true, tool: 'search', summary: 'hello' }];
  const out = buildContext({ goal: 'g', toolResults: small, iteration: 1 });
  assert.ok(out.includes('hello'), '小结果应保留');
});
