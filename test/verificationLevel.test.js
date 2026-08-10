'use strict';
/**
 * test/verificationLevel.test.js（spec §39-§43）。
 *
 * isClaimAllowed 同时做两件事：
 *   1. 正向证据 — 有没有足够证据声明该等级
 *   2. 负向约束（cap）— 有没有证据把上限压到该等级之下
 *
 * 核心不变量：
 *   §42 仅 --version 成功（无协议交互）→ 封顶 LOCAL_DETECTION_VERIFIED，
 *       不得声明 REAL_PROTOCOL_VERIFIED
 *   §43 付费 provider → 强制 NOT_VERIFIED
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  VERIFICATION_LEVEL,
  isClaimAllowed,
  formatLevel
} = require('../src/agents/verification/verificationLevel');

test('NOT_VERIFIED 无需任何证据即可声明', () => {
  assert.strictEqual(isClaimAllowed(VERIFICATION_LEVEL.NOT_VERIFIED, {}), true);
});

test('无任何证据时不得声明 REAL_PROTOCOL_VERIFIED', () => {
  assert.strictEqual(isClaimAllowed(VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED, {}), false);
});

test('可执行文件 + --version 成功 → 可声明 LOCAL_DETECTION_VERIFIED', () => {
  assert.strictEqual(
    isClaimAllowed(VERIFICATION_LEVEL.LOCAL_DETECTION_VERIFIED, {
      executableFound: true,
      versionSucceeded: true
    }),
    true
  );
});

test('仅 --version 成功、无协议交互 → 不得声明 REAL_PROTOCOL_VERIFIED（§42）', () => {
  assert.strictEqual(
    isClaimAllowed(VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED, {
      executableFound: true,
      versionSucceeded: true
    }),
    false
  );
});

test('补齐 protocolInitialized 后可声明 REAL_PROTOCOL_VERIFIED', () => {
  assert.strictEqual(
    isClaimAllowed(VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED, {
      executableFound: true,
      versionSucceeded: true,
      protocolInitialized: true
    }),
    true
  );
});

test('付费 provider → 强制 NOT_VERIFIED，不得声明 PACKAGED_VERIFIED（§43）', () => {
  assert.strictEqual(
    isClaimAllowed(VERIFICATION_LEVEL.PACKAGED_VERIFIED, { paidProvider: true }),
    false
  );
});

test('付费 provider 仍可声明 NOT_VERIFIED（§43）', () => {
  assert.strictEqual(
    isClaimAllowed(VERIFICATION_LEVEL.NOT_VERIFIED, { paidProvider: true }),
    true
  );
});

test('formatLevel 返回非空的可读标签', () => {
  const label = formatLevel(VERIFICATION_LEVEL.REAL_PROTOCOL_VERIFIED);
  assert.strictEqual(typeof label, 'string');
  assert.ok(label.length > 0);
});
