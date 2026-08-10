'use strict';
/**
 * test/verificationRegistry.test.js（spec §65/§78）。
 *
 * 注册表按 agentId 累积证据，并用 isClaimAllowed 反推"当前可声明的最高等级"，
 * 因此等级只会随证据增加而单调上升。
 *
 * 同时守护 §78：证据记录的任何字符串字段都不得把凭据带进证据流 / 日志 / GUI。
 * redactField 覆盖两种情形——字段名命中敏感词（整值替换），或字段值中「任意位置」
 * 出现密钥片段（全局片段替换，与 security/permissionAudit.js 同一套模式）。
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  createVerificationRegistry,
  sanitizeEvidence,
  summarizeEvidence
} = require('../src/agents/verification/verificationRegistry');
const { VERIFICATION_LEVEL } = require('../src/agents/verification/verificationLevel');

test('local_detection 通过 → 等级为 LOCAL_DETECTION_VERIFIED', () => {
  const reg = createVerificationRegistry();
  reg.record('claude', { type: 'local_detection', status: 'pass', version: '1.2' });
  assert.strictEqual(reg.getLevel('claude'), VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED);
});

test('再补 protocol 证据 → 等级升到 REAL_PROTOCOL_VERIFIED（取已达成的最高等级）', () => {
  const reg = createVerificationRegistry();
  reg.record('claude', { type: 'local_detection', status: 'pass', version: '1.2' });
  reg.record('claude', { type: 'protocol', status: 'pass' });
  assert.strictEqual(reg.getLevel('claude'), VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED);
});

test('summarizeEvidence 从 local_detection 推出 executableFound', () => {
  const summary = summarizeEvidence([{ type: 'local_detection', status: 'pass' }]);
  assert.strictEqual(summary.executableFound, true);
});

test('sanitizeEvidence 脱敏敏感字段名，保留普通字段（§78）', () => {
  const out = sanitizeEvidence({ apiKey: 'sk-test-secret', note: 'ok' });
  assert.strictEqual(out.apiKey, '[REDACTED]');
  assert.strictEqual(out.note, 'ok');
});

test('凭据回归：details 以 Bearer 开头时被脱敏（§78）', () => {
  const reg = createVerificationRegistry();
  reg.record('y', { type: 'local_detection', status: 'pass', details: 'Bearer fake' });
  const evidence = reg.getEvidence('y');
  assert.strictEqual(evidence[0].details, '[REDACTED]');
  for (const record of evidence) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string') assert.ok(!value.includes('Bearer fake'));
    }
  }
});

// ── 凭据嵌在句子中间的回归（§78 的真实泄漏面）──────────────────────────

test('凭据回归：details 中间夹带 sk- 密钥必须被脱敏（§78）', () => {
  const reg = createVerificationRegistry();
  reg.record('x', { type: 'local_detection', status: 'pass', details: 'token sk-test-secret leaked' });
  const evidence = reg.getEvidence('x');
  for (const record of evidence) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string') {
        assert.ok(!value.includes('sk-test-secret'), `证据字段泄漏凭据：${value}`);
      }
    }
  }
});

test('凭据回归：details 中的 Cookie=fake 必须被脱敏（§78）', () => {
  const reg = createVerificationRegistry();
  reg.record('z', { type: 'local_detection', status: 'pass', details: 'Cookie=fake' });
  const evidence = reg.getEvidence('z');
  for (const record of evidence) {
    for (const value of Object.values(record)) {
      if (typeof value === 'string') {
        assert.ok(!value.includes('Cookie=fake'), `证据字段泄漏凭据：${value}`);
      }
    }
  }
});
