'use strict';
/**
 * v2.5.1 — Credential Conflict 单元测试。
 *
 * §14-§18：Same Endpoint + Different Secret Conflict。
 *   - 同 baseUrl + 同 protocol + 同 key → DUPLICATE (sameKey=true)
 *   - 同 baseUrl + 同 protocol + 不同 key → CONFLICT (SAME_ENDPOINT_DIFFERENT_SECRET)
 *   - 不自动覆盖
 *   - §15：不通过 Mask 判断 Secret 相同
 *   - §16：constant-time compare
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  resolveConflict,
  resolveBatchConflicts,
  compareSecrets,
  constantTimeCompare,
  checkCredentialConflict,
  enrichBatchWithCredentialConflicts
} = require('../src/providers/onboarding/external/conflictResolver');

/** mock store: getDecrypted 返回指定 api_key */
function mockStore(decryptedKey) {
  return {
    connections: {
      getDecrypted(id) {
        return { id, api_key: decryptedKey, name: 'Test Existing', provider: 'openai', base_url: 'https://api.test.com/v1' };
      },
      list() {
        return [{ id: 'conn-1', name: 'Test Existing', provider: 'openai', base_url: 'https://api.test.com/v1', api_key_masked: 'sk-t****1234' }];
      }
    }
  };
}

/** mock sec: mask 函数 */
function mockSec() {
  return {
    mask(plain) {
      if (!plain) return '';
      const s = String(plain);
      if (s.length <= 8) return s[0] + '****' + s[s.length - 1];
      return s.slice(0, 4) + '*'.repeat(Math.min(s.length - 8, 12)) + s.slice(-4);
    }
  };
}

test('§16 constantTimeCompare：相同字符串 → true', () => {
  assert.strictEqual(constantTimeCompare('abc123', 'abc123'), true);
  assert.strictEqual(constantTimeCompare('sk-test-key-123', 'sk-test-key-123'), true);
});

test('§16 constantTimeCompare：不同字符串 → false', () => {
  assert.strictEqual(constantTimeCompare('abc123', 'abc124'), false);
  assert.strictEqual(constantTimeCompare('sk-key-A', 'sk-key-B'), false);
});

test('§16 constantTimeCompare：不同长度 → false', () => {
  assert.strictEqual(constantTimeCompare('abc', 'abcd'), false);
  assert.strictEqual(constantTimeCompare('short', 'longerstring'), false);
});

test('§16 constantTimeCompare：非字符串 → false', () => {
  assert.strictEqual(constantTimeCompare(null, 'abc'), false);
  assert.strictEqual(constantTimeCompare('abc', null), false);
  assert.strictEqual(constantTimeCompare(undefined, undefined), false);
  assert.strictEqual(constantTimeCompare(123, 123), false);
});

test('§14 同端同钥 → DUPLICATE (sameKey=true, requiresConfirmation=false)', () => {
  const candidate = {
    name: 'Test Import',
    baseUrl: 'https://api.test.com/v1',
    protocolHint: 'openai',
    apiKey: 'sk-test-same-key-12345'
  };
  const existing = [{
    id: 'conn-1',
    name: 'Test Existing',
    provider: 'openai',
    base_url: 'https://api.test.com/v1',
    api_key_masked: 'sk-t****2345'
  }];
  const conflict = resolveConflict(candidate, existing);
  assert.strictEqual(conflict.state, 'DUPLICATE');
  assert.strictEqual(conflict.requiresCredentialCheck, true);

  // credential check：同 key
  const store = mockStore('sk-test-same-key-12345');
  const sec = mockSec();
  const enriched = checkCredentialConflict(candidate, conflict, store, sec);
  assert.strictEqual(enriched.state, 'DUPLICATE');
  assert.strictEqual(enriched.sameKey, true);
  assert.strictEqual(enriched.credentialConflict, false);
  assert.strictEqual(enriched.requiresConfirmation, false);
});

test('§14/§17 同端异钥 → CONFLICT (SAME_ENDPOINT_DIFFERENT_SECRET, requiresConfirmation=true)', () => {
  const candidate = {
    name: 'Test Import',
    baseUrl: 'https://api.test.com/v1',
    protocolHint: 'openai',
    apiKey: 'sk-test-new-key-BBBBBB'
  };
  const existing = [{
    id: 'conn-1',
    name: 'Test Existing',
    provider: 'openai',
    base_url: 'https://api.test.com/v1',
    api_key_masked: 'sk-t****AAAA'
  }];
  const conflict = resolveConflict(candidate, existing);
  assert.strictEqual(conflict.state, 'DUPLICATE');
  assert.strictEqual(conflict.requiresCredentialCheck, true);

  // credential check：不同 key
  const store = mockStore('sk-test-old-key-AAAAAA');
  const sec = mockSec();
  const enriched = checkCredentialConflict(candidate, conflict, store, sec);
  assert.strictEqual(enriched.state, 'CONFLICT');
  assert.strictEqual(enriched.credentialConflict, true);
  assert.strictEqual(enriched.sameKey, false);
  assert.strictEqual(enriched.requiresConfirmation, true);
  assert.strictEqual(enriched.conflictReason, 'SAME_ENDPOINT_DIFFERENT_SECRET');
  assert.ok(enriched.importedMasked);
  assert.ok(enriched.existingMasked);
  // 不含完整 key
  assert.ok(!JSON.stringify(enriched).includes('sk-test-new-key-BBBBBB'));
  assert.ok(!JSON.stringify(enriched).includes('sk-test-old-key-AAAAAA'));
});

test('§17 GUI 必须显示密钥不同提示', () => {
  const candidate = {
    name: 'Test',
    baseUrl: 'https://api.test.com/v1',
    protocolHint: 'openai',
    apiKey: 'sk-test-BBBB1234'
  };
  const existing = [{
    id: 'conn-1',
    name: 'Existing',
    provider: 'openai',
    base_url: 'https://api.test.com/v1',
    api_key_masked: 'sk-t****AAAA'
  }];
  const conflict = resolveConflict(candidate, existing);
  const store = mockStore('sk-test-AAAA5678');
  const sec = mockSec();
  const enriched = checkCredentialConflict(candidate, conflict, store, sec);
  assert.match(enriched.reason, /密钥不同/);
});

test('§15 mask 相同不代表 secret 相同 — compareSecrets 仅供 UI 显示', () => {
  // 两个不同 key 可能 mask 相同
  const masked1 = 'sk-t****1234';
  const masked2 = 'sk-t****1234';
  assert.strictEqual(masked1, masked2); // mask 相同
  // 但实际 key 不同
  assert.strictEqual(constantTimeCompare('sk-test-aaa1234', 'sk-test-bbb1234'), false);
});

test('§16 解密失败 → 保守视为 credential conflict', () => {
  const candidate = {
    name: 'Test',
    baseUrl: 'https://api.test.com/v1',
    protocolHint: 'openai',
    apiKey: 'sk-test-key-12345'
  };
  const conflict = {
    state: 'DUPLICATE',
    duplicateId: 'conn-1',
    duplicateName: 'Existing',
    duplicateMasked: 'sk-t****2345',
    requiresCredentialCheck: true,
    reason: 'test'
  };
  // mock store that throws on getDecrypted
  const badStore = {
    connections: {
      getDecrypted() { throw new Error('decrypt failed'); }
    }
  };
  const sec = mockSec();
  const enriched = checkCredentialConflict(candidate, conflict, badStore, sec);
  assert.strictEqual(enriched.state, 'CONFLICT');
  assert.strictEqual(enriched.credentialConflict, true);
  assert.strictEqual(enriched.sameKey, false);
});

test('§18 enrichBatchWithCredentialConflicts：批量增强', () => {
  const candidates = [
    {
      name: 'Same Key',
      baseUrl: 'https://api.test.com/v1',
      protocolHint: 'openai',
      apiKey: 'sk-same-key-12345'
    },
    {
      name: 'Different Key',
      baseUrl: 'https://api.test.com/v1',
      protocolHint: 'openai',
      apiKey: 'sk-different-key-999'
    },
    {
      name: 'New Conn',
      baseUrl: 'https://api.new.com/v1',
      protocolHint: 'openai',
      apiKey: 'sk-new-key-67890'
    }
  ];
  const existing = [
    { id: 'conn-1', name: 'Existing', provider: 'openai', base_url: 'https://api.test.com/v1', api_key_masked: 'sk-s****2345' }
  ];
  const batch = resolveBatchConflicts(candidates, existing);

  // mock store：conn-1 的 key 是 'sk-same-key-12345'
  const store = {
    connections: {
      getDecrypted(id) {
        if (id === 'conn-1') return { id, api_key: 'sk-same-key-12345' };
        return null;
      }
    }
  };
  const sec = mockSec();
  const enriched = enrichBatchWithCredentialConflicts(batch, store, sec);

  // candidate 0: 同端同钥 → DUPLICATE
  assert.strictEqual(enriched[0].conflict.state, 'DUPLICATE');
  assert.strictEqual(enriched[0].conflict.sameKey, true);
  assert.strictEqual(enriched[0].conflict.requiresConfirmation, false);

  // candidate 1: 同端异钥 → CONFLICT
  assert.strictEqual(enriched[1].conflict.state, 'CONFLICT');
  assert.strictEqual(enriched[1].conflict.credentialConflict, true);
  assert.strictEqual(enriched[1].conflict.conflictReason, 'SAME_ENDPOINT_DIFFERENT_SECRET');
  assert.strictEqual(enriched[1].conflict.requiresConfirmation, true);

  // candidate 2: 新连接 → NEW（不受影响）
  assert.strictEqual(enriched[2].conflict.state, 'NEW');
});

test('§14 无 apiKey 的 candidate → 不需 credential check', () => {
  const candidate = {
    name: 'Test',
    baseUrl: 'https://api.test.com/v1',
    protocolHint: 'openai',
    apiKey: null
  };
  const conflict = {
    state: 'DUPLICATE',
    duplicateId: 'conn-1',
    duplicateName: 'Existing',
    duplicateMasked: 'sk-t****2345',
    requiresCredentialCheck: true,
    reason: 'test'
  };
  const store = mockStore('sk-test-key-12345');
  const sec = mockSec();
  const enriched = checkCredentialConflict(candidate, conflict, store, sec);
  assert.strictEqual(enriched.credentialConflict, false);
  assert.strictEqual(enriched.requiresConfirmation, false);
});
