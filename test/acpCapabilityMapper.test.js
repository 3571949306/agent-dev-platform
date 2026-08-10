'use strict';
/**
 * v2.8.0 — test/acpCapabilityMapper.test.js（spec §124 / §22 / §45）。
 *
 * 能力协商的判定必须完全依据 ACP v1 AgentCapabilities 的真实形状：
 *   - v1 baseline（session/new · prompt · cancel · update）不出现在 capabilities 里
 *   - resume / close 在 sessionCapabilities 下，`{}` 即声明支持（只有 null/false/缺失才算没有）
 *   - 期望能力未满足 → 明确 missing 列表，绝不静默降级硬发
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  extractAcpCapabilityFlags,
  checkExpectedAcpCapabilities,
  mergeManifestCapabilities,
  negotiateCapabilities
} = require('../src/agents/protocols/acp/capabilityMapper');

/** 一份典型的 v1 AgentCapabilities（与 fakeAcpAgent 默认值同形状）。 */
const V1_CAPS = {
  promptCapabilities: { image: false, audio: false, embeddedContext: true },
  mcpCapabilities: { http: false, sse: false },
  sessionCapabilities: { resume: {}, close: {} }
};

test('extractAcpCapabilityFlags：v1 典型形状逐标志解析', () => {
  const flags = extractAcpCapabilityFlags(V1_CAPS, []);
  // v1 baseline 恒为 true（不依赖 capabilities 字段）
  assert.strictEqual(flags.sessions, true);
  assert.strictEqual(flags.prompt, true);
  assert.strictEqual(flags.cancel, true);
  assert.strictEqual(flags.resume, true, 'resume:{} 即声明支持');
  assert.strictEqual(flags.close, true);
  assert.strictEqual(flags.promptImage, false);
  assert.strictEqual(flags.promptAudio, false);
  assert.strictEqual(flags.promptEmbeddedContext, true);
  assert.strictEqual(flags.mcpHttp, false);
  assert.strictEqual(flags.mcpSse, false);
  assert.strictEqual(flags.mcp, false);
  assert.strictEqual(flags.auth, false, '无 authMethods → 无 auth 面');
});

test('extractAcpCapabilityFlags：authMethods 非空 → auth=true（仅状态，不含凭据）', () => {
  const flags = extractAcpCapabilityFlags(V1_CAPS, ['oauth-chatgpt']);
  assert.strictEqual(flags.auth, true);
  assert.ok(!JSON.stringify(flags).includes('oauth-chatgpt'), '标志集绝不携带 methodId 之外的东西');
});

test('extractAcpCapabilityFlags：null / 畸形输入不抛错，全 false 兜底', () => {
  for (const bad of [null, undefined, {}, { sessionCapabilities: null }, 'garbage']) {
    const flags = extractAcpCapabilityFlags(bad, null);
    assert.strictEqual(flags.resume, false);
    assert.strictEqual(flags.mcpHttp, false);
  }
});

test('sessionCapabilities 中 false / null 视为不支持（只有存在且非 false 才算支持）', () => {
  const flags = extractAcpCapabilityFlags({ sessionCapabilities: { resume: false, close: null } }, []);
  assert.strictEqual(flags.resume, false);
  assert.strictEqual(flags.close, false);
});

test('checkExpectedAcpCapabilities：满足 → ok；缺失 → missing 精确列出', () => {
  const flags = extractAcpCapabilityFlags(V1_CAPS, []);
  assert.deepStrictEqual(checkExpectedAcpCapabilities({ resume: true }, flags), { ok: true, missing: [] });

  const bad = checkExpectedAcpCapabilities({ resume: true, mcpHttp: true }, flags);
  assert.strictEqual(bad.ok, false);
  assert.deepStrictEqual(bad.missing, ['mcpHttp'], '只列出真正缺失的标志');
});

test('checkExpectedAcpCapabilities：期望值为 false/缺省 的键不参与判定', () => {
  const flags = extractAcpCapabilityFlags(V1_CAPS, []);
  assert.strictEqual(checkExpectedAcpCapabilities({ mcpHttp: false, resume: true }, flags).ok, true);
  assert.strictEqual(checkExpectedAcpCapabilities({}, flags).ok, true);
  assert.strictEqual(checkExpectedAcpCapabilities(null, flags).ok, true);
});

test('mergeManifestCapabilities：只并入 manifest 中为 true 的任务能力', () => {
  const flags = extractAcpCapabilityFlags(V1_CAPS, []);
  const merged = mergeManifestCapabilities({ coding: true, review: false, git: true }, flags);
  assert.ok(merged.includes('coding'));
  assert.ok(merged.includes('git'));
  assert.ok(!merged.includes('review'), 'false 的能力绝不混入');
});

test('mergeManifestCapabilities：协议层能力只并入真实为 true 的（不无脑全 true）', () => {
  const withMcp = extractAcpCapabilityFlags({ mcpCapabilities: { http: true } }, []);
  const merged = mergeManifestCapabilities({ coding: true }, withMcp);
  assert.ok(merged.includes('mcp'), 'mcpHttp=true 应并入协议能力 mcp');

  const noMcp = extractAcpCapabilityFlags(V1_CAPS, []);
  const merged2 = mergeManifestCapabilities({ coding: true }, noMcp);
  assert.ok(!merged2.includes('mcp'), 'mcpHttp=false 时绝不声明 mcp');
  assert.ok(merged2.includes('resume'), 'resume 真实声明时应并入');
  assert.ok(merged2.includes('sessions'), 'baseline sessions 恒并入');
});

test('negotiateCapabilities：一次性返回平台能力数组 + 原始 ACP 标志', () => {
  const { platformCaps, acpFlags } = negotiateCapabilities({ coding: true }, V1_CAPS, []);
  assert.ok(Array.isArray(platformCaps));
  assert.ok(platformCaps.includes('coding'));
  assert.strictEqual(acpFlags.resume, true);
});
