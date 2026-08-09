'use strict';
/**
 * v2.5.1 — Credential Classifier 单元测试。
 *
 * §8：至少覆盖 16 种 case：
 *   1. sk-test-abc123 → allowed
 *   2. Bearer sk-test-abc123 → allowed
 *   3. OAuth-looking JWT → rejected
 *   4. ChatGPT membership JWT → rejected
 *   5. JWT with subscription_active_until → rejected
 *   6. JWT with chatgpt_plan_type → rejected
 *   7. refresh_token field → rejected
 *   8. session token → rejected
 *   9. WorkBuddy membership token field → rejected
 *   10. unknown JWT in apiKey → rejected
 *   11. unknown JWT in Authorization → rejected
 *   12. normal DeepSeek API key → allowed
 *   13. Anthropic API key → allowed
 *   14. OpenRouter API key → allowed
 *   15. malformed JWT must not crash
 *   16. gigantic secret input must not crash/log raw value
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  isJwtLike,
  parseJwtPayload,
  stripAuthPrefix,
  looksLikeApiKey,
  classifyCredentialValue,
  classifyAuthorizationHeader,
  inspectJwtPayload
} = require('../src/providers/onboarding/external/security/credentialClassifier');
const { isUnsupportedCredential } = require('../src/providers/onboarding/external/security/secretSanitizer');

/** 构造一个 JWT（header.payload.signature），payload 可自定义。 */
function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = 'c2lnbmF0dXJl'; // "signature" base64url
  return `${header}.${body}.${sig}`;
}

test('1) sk-test-abc123 → api_key allowed', () => {
  const r = classifyCredentialValue('sk-test-abc123456', { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('2) Bearer sk-test-abc123 → api_key allowed（剥离 Bearer 前缀）', () => {
  const r = classifyAuthorizationHeader('Bearer sk-test-abc123456');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
  assert.ok(r.reasons.some(x => /Bearer/.test(x)));
});

test('3) OAuth-looking JWT（含 scope）→ oauth_token rejected', () => {
  const jwt = makeJwt({ scope: 'read write', iss: 'https://auth.example.com' });
  const r = classifyCredentialValue(jwt, { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'oauth_token');
});

test('4) ChatGPT membership JWT（含 chatgpt_plan_type=plus）→ membership_token rejected', () => {
  const jwt = makeJwt({ chatgpt_plan_type: 'plus', sub: 'user-123' });
  const r = classifyCredentialValue(jwt, { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'membership_token');
});

test('5) JWT with subscription_active_until → membership_token rejected', () => {
  const jwt = makeJwt({ subscription_active_until: '2026-12-31', sub: 'user-456' });
  const r = classifyCredentialValue(jwt, { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'membership_token');
});

test('6) JWT with chatgpt_plan_type → membership_token rejected', () => {
  const jwt = makeJwt({ chatgpt_plan_type: 'pro', exp: 9999999999 });
  const r = classifyCredentialValue(jwt, { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'membership_token');
});

test('7) refresh_token field name → oauth_token rejected（字段名优先）', () => {
  const r = classifyCredentialValue('some-random-value-12345', { fieldName: 'refresh_token' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'oauth_token');
  assert.ok(isUnsupportedCredential('refresh_token'));
});

test('8) session_token field name → oauth_token rejected（字段名优先）', () => {
  const r = classifyCredentialValue('some-session-value-abcdef', { fieldName: 'session_token' });
  assert.strictEqual(r.allowed, false);
});

test('9) workbuddy_membership field name → rejected', () => {
  const r = classifyCredentialValue('wb-xxxxxx', { fieldName: 'workbuddy_membership' });
  assert.strictEqual(r.allowed, false);
  assert.ok(isUnsupportedCredential('workbuddy_membership'));
});

test('10) unknown JWT in apiKey field → jwt_unknown rejected（§5 保守处理）', () => {
  const jwt = makeJwt({ sub: 'user-789', iat: 1234567890 }); // 无会员/oauth/session 字段
  const r = classifyCredentialValue(jwt, { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'jwt_unknown');
});

test('11) unknown JWT in Authorization field → jwt_unknown rejected', () => {
  const jwt = makeJwt({ sub: 'user-000', iat: 1234567890 });
  const r = classifyAuthorizationHeader('Bearer ' + jwt);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'jwt_unknown');
});

test('12) normal DeepSeek API key → api_key allowed', () => {
  const r = classifyCredentialValue('sk-deepseekabcdef1234567890', { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('13) Anthropic API key (sk-ant-) → api_key allowed', () => {
  const r = classifyCredentialValue('sk-ant-api03-1234567890abcdef', { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('14) OpenRouter API key (sk-or-) → api_key allowed', () => {
  const r = classifyCredentialValue('sk-or-v1-1234567890abcdef', { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('15) malformed JWT must not crash', () => {
  // 只有 2 段
  assert.strictEqual(isJwtLike('abc.def'), false);
  // 空段
  assert.strictEqual(isJwtLike('a..b'), false);
  // 非法字符
  assert.strictEqual(isJwtLike('ab!.cd!.ef!'), false);
  // parseJwtPayload 对非 JWT 返回 null
  assert.strictEqual(parseJwtPayload('not-a-jwt'), null);
  // 长度 < 16 的短字符串不算 JWT
  assert.strictEqual(isJwtLike('abc.def.ghi'), false);
  // classifyCredentialValue 不 crash：用足够长的 JWT 结构但 payload 不可解析
  const longMalformed = 'aaaaaaa.bbbbbbb.ccccccc';
  assert.strictEqual(isJwtLike(longMalformed), true);
  const r = classifyCredentialValue(longMalformed, { fieldName: 'api_key' });
  // payload 解析失败 → jwt_unknown，保守拒绝
  assert.strictEqual(r.allowed, false);
});

test('16) gigantic secret input must not crash / reasons 不含原始值', () => {
  const huge = 'sk-' + 'a'.repeat(100000);
  const r = classifyCredentialValue(huge, { fieldName: 'api_key' });
  assert.strictEqual(r.allowed, true);
  // reasons 不应包含完整 key
  const allReasons = r.reasons.join(' ');
  assert.ok(!allReasons.includes(huge));
  assert.ok(allReasons.length < 500);
});

test('§7 classifyAuthorizationHeader：Bearer sk-xxx → allowed', () => {
  const r = classifyAuthorizationHeader('Bearer sk-test-abc123456');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('§7 classifyAuthorizationHeader：Bearer eyJ JWT → rejected', () => {
  const jwt = makeJwt({ chatgpt_plan_type: 'plus' });
  const r = classifyAuthorizationHeader('Bearer ' + jwt);
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'membership_token');
});

test('stripAuthPrefix：剥离 Bearer/Token/Basic', () => {
  assert.strictEqual(stripAuthPrefix('Bearer sk-xxx'), 'sk-xxx');
  assert.strictEqual(stripAuthPrefix('token sk-xxx'), 'sk-xxx');
  assert.strictEqual(stripAuthPrefix('Basic abc123'), 'abc123');
  assert.strictEqual(stripAuthPrefix('BEARER  sk-xxx'), 'sk-xxx');
  assert.strictEqual(stripAuthPrefix('sk-xxx'), 'sk-xxx');
  assert.strictEqual(stripAuthPrefix(''), '');
  assert.strictEqual(stripAuthPrefix(null), null);
});

test('looksLikeApiKey：已知前缀形状', () => {
  assert.strictEqual(looksLikeApiKey('sk-test123456'), true);
  assert.strictEqual(looksLikeApiKey('sk-ant-api03-abc'), true);
  assert.strictEqual(looksLikeApiKey('sk-proj-abcdef123'), true);
  assert.strictEqual(looksLikeApiKey('sk-or-v1-abcdef'), true);
  assert.strictEqual(looksLikeApiKey('AIzaSyA1234567890abcdef'), true);
  assert.strictEqual(looksLikeApiKey('short'), false);
  assert.strictEqual(looksLikeApiKey(''), false);
  assert.strictEqual(looksLikeApiKey(null), false);
});

test('inspectJwtPayload：会员字段优先于 oauth 字段', () => {
  const r = inspectJwtPayload({
    scope: 'read',
    chatgpt_plan_type: 'plus',
    session: 'xxx'
  });
  assert.strictEqual(r.type, 'membership');
  assert.ok(r.matchedFields.length >= 2);
});

test('§4 JWT payload 不出现在 reasons / error 中', () => {
  const payload = { chatgpt_plan_type: 'plus', secret_field: 'DO_NOT_LEAK_THIS_VALUE' };
  const jwt = makeJwt(payload);
  const r = classifyCredentialValue(jwt, { fieldName: 'api_key' });
  const allText = JSON.stringify(r) + r.reasons.join(' ');
  assert.ok(!allText.includes('DO_NOT_LEAK_THIS_VALUE'));
  assert.ok(!allText.includes('chatgpt_plan_type'));
});

test('空值 / null / undefined → unknown not allowed', () => {
  assert.strictEqual(classifyCredentialValue('').allowed, false);
  assert.strictEqual(classifyCredentialValue(null).allowed, false);
  assert.strictEqual(classifyCredentialValue(undefined).allowed, false);
});

// v2.6.0 §3.1 — Basic Authorization 不得自动作为 API Key
test('v2.6.0 §3.1 Basic Auth (classifyCredentialValue) → basic_auth allowed=false', () => {
  const r = classifyCredentialValue('Basic dXNlcjpwYXNz', { fieldName: 'authorization' });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'basic_auth');
  assert.ok(r.reasons.some(x => /Basic Authentication/i.test(x)), '应提示 Basic Auth 不可自动迁移');
});

test('v2.6.0 §3.1 Basic Auth (classifyAuthorizationHeader) → basic_auth allowed=false', () => {
  const r = classifyAuthorizationHeader('Basic dXNlcjpwYXNz');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'basic_auth');
  assert.ok(r.reasons.some(x => /Basic Authentication/i.test(x)));
});

test('v2.6.0 §3.1 Basic Auth admin:123456 → basic_auth allowed=false', () => {
  const r = classifyAuthorizationHeader('Basic YWRtaW46MTIzNDU2');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'basic_auth');
});

test('v2.6.0 §3.1 Bearer sk-xxx 仍允许（不受 Basic 改动影响）', () => {
  const r = classifyAuthorizationHeader('Bearer sk-test-abc123456');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('v2.6.0 §3.1 Token sk-xxx 仍允许（不受 Basic 改动影响）', () => {
  const r = classifyAuthorizationHeader('Token sk-test-abc123456');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.classification, 'api_key');
});

test('v2.6.0 §3.1 Basic 前缀大小写不敏感', () => {
  const r = classifyAuthorizationHeader('basic dXNlcjpwYXNz');
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.classification, 'basic_auth');
});

test('v2.6.0 §3.1 basic_auth reasons 不含原始 base64 凭据', () => {
  const raw = 'Basic dXNlcjpwYXNz';
  const r = classifyAuthorizationHeader(raw);
  const allText = JSON.stringify(r) + r.reasons.join(' ');
  // 不应泄漏 base64 凭据值
  assert.ok(!allText.includes('dXNlcjpwYXNz'));
});
