'use strict';
/**
 * test/agentVerification.test.js（spec §39/§40/§41/§42/§44/§45/§82）。
 *
 * 这层的价值不在"跑得通"，而在"不许吹牛"：
 *   - 机器上没装 codex 时，Codex 绝不能显示成本地检测/真实协议已验证（§41）
 *   - 只有 --version 成功、没有真实 initialize，就只能停在本地检测级（§42）
 *   - Health 再绿也不能抬高验证级别（§45）
 */
const test = require('node:test');
const assert = require('node:assert');

const { describeAgentVerification, describeAll } = require('../src/agents/verification/agentVerification');
const { VERIFICATION_LEVEL } = require('../src/agents/verification/verificationLevel');

function dim(desc, key) {
  const d = desc.dimensions.find(x => x.key === key);
  return d ? d.value : undefined;
}

test('§41 未探测到可执行文件 → 最高只能到 Fixture 级，且各维度显示未验证', () => {
  const desc = describeAgentVerification('codex', null);
  assert.strictEqual(desc.level, VERIFICATION_LEVEL.FIXTURE_VERIFIED);
  assert.strictEqual(dim(desc, 'installed'), '未检测到');
  assert.strictEqual(dim(desc, 'localDetection'), '未验证');
  assert.strictEqual(dim(desc, 'realProtocol'), '未验证');
  assert.strictEqual(dim(desc, 'realAgentTask'), '未验证');
});

test('§42 探测到可执行文件 + 版本号 → 本地检测级；无真实协议不得升级', () => {
  const desc = describeAgentVerification('claude-code', { id: 'claude-code', available: true, version: '1.2.3' });
  assert.strictEqual(desc.level, VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED);
  assert.strictEqual(dim(desc, 'localDetection'), '已验证');
  assert.strictEqual(dim(desc, 'realProtocol'), '未验证');
});

test('§45 Health=healthy 不能抬高验证级别（健康 ≠ 已验证）', () => {
  const desc = describeAgentVerification('codex', {
    id: 'codex', available: false, health: { status: 'healthy' }
  });
  assert.strictEqual(desc.level, VERIFICATION_LEVEL.FIXTURE_VERIFIED);
  assert.strictEqual(dim(desc, 'realProtocol'), '未验证');
});

test('探测到但拿不到版本号 → 不得声明本地检测级（宁可少认）', () => {
  const desc = describeAgentVerification('codex', { id: 'codex', available: true });
  assert.strictEqual(desc.level, VERIFICATION_LEVEL.FIXTURE_VERIFIED);
  assert.strictEqual(dim(desc, 'installed'), '是');
  assert.strictEqual(dim(desc, 'localDetection'), '未验证');
});

test('§43 Cline health/constructibility 不可替代显式协议证据', () => {
  const desc = describeAgentVerification('cline', {
    id: 'cline', available: true, version: '1.0.0',
    health: { status: 'healthy', sidecar: { ready: true }, runtime: { nodeVersion: 'v22.0.0', probe: true, coreConstructible: true } }
  });
  assert.strictEqual(desc.level, VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED);
  assert.strictEqual(dim(desc, 'realProtocol'), '未验证');
  assert.strictEqual(dim(desc, 'realAgentTask'), '未验证');
});

test('显式 protocolVerified 才可升级真实协议级', () => {
  const desc = describeAgentVerification('cline', {
    id: 'cline', available: true, configured: true, version: '1.0.0', runtime: 'sdk', protocolVerified: true
  });
  assert.strictEqual(desc.level, VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED);
  assert.strictEqual(dim(desc, 'realProtocol'), '已验证');
});

test('§40 维度取值来自固定枚举，不出现自由文案', () => {
  const allowed = new Set(['是', '否', '已验证', '未验证', '未知', 'Fixture 已验证', '仅实现级', '未检测到']);
  const desc = describeAgentVerification('opencode', { id: 'opencode', available: true, version: '0.1' });
  for (const d of desc.dimensions) {
    if (d.key === 'auth') continue; // 认证状态透传状态机的展示值
    assert.ok(allowed.has(d.value), `维度 ${d.key} 出现自由文案：${d.value}`);
  }
});

test('describeAll 覆盖全部 manifest，即使该 Agent 不在 available 列表里', () => {
  const out = describeAll(
    [{ id: 'codex' }, { id: 'cline' }, { id: 'openhands' }],
    [{ id: 'cline', available: true, version: '1.0.0' }]
  );
  assert.deepStrictEqual(Object.keys(out).sort(), ['cline', 'codex', 'openhands']);
  assert.strictEqual(out.openhands.level, VERIFICATION_LEVEL.FIXTURE_VERIFIED);
});

test('证据链可追溯：每条 evidence 都带来源，且不含凭据', () => {
  const desc = describeAgentVerification('codex', { id: 'codex', available: true, version: 'sk-not-a-real-key' });
  assert.ok(desc.evidence.length >= 2);
  for (const e of desc.evidence) {
    assert.ok(e.type && e.status, 'evidence 必须有 type/status');
    for (const v of Object.values(e)) {
      if (typeof v === 'string') assert.ok(!v.includes('sk-not-a-real-key'), `证据泄漏疑似凭据：${v}`);
    }
  }
});
