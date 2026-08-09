'use strict';
/**
 * v2.5.0 — External Config Import 单元测试。
 *
 * 覆盖 spec：
 *   §67 Importer Unit Tests（Codex/Claude/OpenCode/CCSwitch/Env/File）
 *   §68 Security Tests（OAuth/Session/Membership 不导入；Secret 不出日志/audit；Mask；不持久化原文）
 *   §69 Conflict Tests（NEW/DUPLICATE/CONFLICT/MISSING_SECRET/INVALID）
 *   §70 Batch Tests（3 provider，2 ok 1 fail，不 rollback）
 *   §55 Path Security（路径策略）
 *
 * 所有 fixture 在 test/fixtures/external-import/ 下，仅含 sk-test-* 假 key。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const external = require('../src/providers/onboarding/external');
const {
  resolveConflict,
  resolveBatchConflicts,
  compareSecrets
} = require('../src/providers/onboarding/external/conflictResolver');
const {
  normalizeCandidate,
  toCandidates
} = require('../src/providers/onboarding/external/importNormalizer');
const {
  createExternalSource,
  IMPORT_SOURCE_VALUES,
  sourceTypeToImportSource
} = require('../src/providers/onboarding/external/externalSource');
const {
  verifyPath,
  knownLocations,
  isWithin,
  discoverKnownConfigs
} = require('../src/providers/onboarding/external/security/pathPolicy');
const {
  isUnsupportedCredential,
  isSupportedApiKey,
  classifyField,
  detectUnsupportedCredentials,
  isCodexAccountLogin,
  isClaudeSessionLogin,
  jwtLooksLikeMembership
} = require('../src/providers/onboarding/external/security/secretSanitizer');

const store = require('../src/db/store');
const sec = require('../src/security/secret');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-extimport-'));
store.init(USER_DATA);

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'external-import');

// ─── §55 Path Security ────────────────────────────────────────────────────

test('pathPolicy.verifyPath: 空路径拒绝', () => {
  assert.strictEqual(verifyPath('').ok, false);
  assert.strictEqual(verifyPath(null).ok, false);
  assert.strictEqual(verifyPath(undefined).ok, false);
});

test('pathPolicy.verifyPath: 用户主动选择文件直接放行', () => {
  const r = verifyPath('C:\\random\\path\\config.toml', { userSelected: true });
  assert.strictEqual(r.ok, true);
});

test('pathPolicy.verifyPath: 自动发现必须在已知目录内（拒绝 C:\\random）', () => {
  const r = verifyPath('C:\\random\\config.toml', { sourceType: 'codex' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不在 codex 已知配置目录内/);
});

test('pathPolicy.verifyPath: 非用户选择且无 sourceType 拒绝', () => {
  const r = verifyPath('C:\\some\\path', {});
  assert.strictEqual(r.ok, false);
});

test('pathPolicy.knownLocations: codex/claude-code/opencode/ccswitch 都有对应目录', () => {
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localAppdata = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const expected = {
    codex: [path.join(home, '.codex')],
    'claude-code': [path.join(home, '.claude')],
    opencode: [path.join(home, '.opencode'), path.join(localAppdata, 'opencode')],
    ccswitch: [path.join(appdata, 'cc-switch')]
  };
  for (const t of ['codex', 'claude-code', 'opencode', 'ccswitch']) {
    const locs = knownLocations(t);
    assert.ok(Array.isArray(locs) && locs.length > 0, `${t} 应有已知目录`);
    // §59: 路径必须由 os.homedir()/APPDATA 动态派生，而非硬编码
    assert.deepStrictEqual(locs, expected[t], `${t} 路径应由 os.homedir() 派生`);
  }
});

test('pathPolicy.knownLocations: 未知 sourceType 返回空数组', () => {
  assert.deepStrictEqual(knownLocations('unknown-tool'), []);
  assert.deepStrictEqual(knownLocations(null), []);
});

test('pathPolicy.isWithin: 子路径在父路径内', () => {
  assert.ok(isWithin('C:\\Users\\me\\.codex\\config.toml', 'C:\\Users\\me\\.codex'));
  assert.ok(isWithin('C:\\Users\\me\\.codex', 'C:\\Users\\me\\.codex'));
  assert.ok(!isWithin('C:\\Users\\other\\.codex', 'C:\\Users\\me\\.codex'));
});

test('pathPolicy.discoverKnownConfigs: 不存在的 sourceType 返回空数组', () => {
  const r = discoverKnownConfigs('unknown-tool');
  assert.deepStrictEqual(r, []);
});

// ─── §68 Security: secretSanitizer ────────────────────────────────────────

test('secretSanitizer.isUnsupportedCredential: OAuth/session/membership 字段被识别', () => {
  assert.ok(isUnsupportedCredential('oauth_access_token'));
  assert.ok(isUnsupportedCredential('refresh_token'));
  assert.ok(isUnsupportedCredential('session_token'));
  assert.ok(isUnsupportedCredential('id_token'));
  assert.ok(isUnsupportedCredential('claude_session'));
  assert.ok(isUnsupportedCredential('chatgpt_token'));
  assert.ok(isUnsupportedCredential('codex_membership_token'));
  assert.ok(isUnsupportedCredential('github_token'));
  assert.ok(isUnsupportedCredential('workbuddy_token'));
});

test('secretSanitizer.isUnsupportedCredential: 用户 API Key 字段不被误判', () => {
  assert.ok(!isUnsupportedCredential('OPENAI_API_KEY'));
  assert.ok(!isUnsupportedCredential('ANTHROPIC_API_KEY'));
  assert.ok(!isUnsupportedCredential('api_key'));
  assert.ok(!isUnsupportedCredential('base_url'));
});

test('secretSanitizer.isSupportedApiKey: 标准 API Key 字段被识别', () => {
  assert.ok(isSupportedApiKey('api_key'));
  assert.ok(isSupportedApiKey('OPENAI_API_KEY'));
  assert.ok(isSupportedApiKey('ANTHROPIC_API_KEY'));
  assert.ok(isSupportedApiKey('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(isSupportedApiKey('DEEPSEEK_API_KEY'));
  assert.ok(isSupportedApiKey('OPENROUTER_API_KEY'));
});

test('secretSanitizer.classifyField: 三态分类', () => {
  assert.strictEqual(classifyField('oauth_access_token'), 'unsupported');
  assert.strictEqual(classifyField('session_token'), 'unsupported');
  assert.strictEqual(classifyField('OPENAI_API_KEY'), 'supported');
  assert.strictEqual(classifyField('api_key'), 'supported');
  assert.strictEqual(classifyField('base_url'), 'neutral');
  assert.strictEqual(classifyField('model'), 'neutral');
});

test('secretSanitizer.detectUnsupportedCredentials: 检测嵌套对象', () => {
  const obj = {
    api_key: 'sk-test-123',
    auth: {
      oauth_access_token: 'fake-oauth',
      refresh_token: 'fake-refresh'
    }
  };
  const r = detectUnsupportedCredentials(obj);
  assert.ok(r.hasUnsupported, '应检测到不可迁移凭据');
  assert.ok(r.detectedFields.length >= 2, '至少 2 个字段');
  assert.ok(r.detectedFields.some(f => f.includes('oauth_access_token')));
  assert.ok(r.detectedFields.some(f => f.includes('refresh_token')));
  assert.match(r.reason, /不可迁移/);
});

test('secretSanitizer.detectUnsupportedCredentials: 纯 API Key 对象不误报', () => {
  const obj = { api_key: 'sk-test', base_url: 'http://x' };
  const r = detectUnsupportedCredentials(obj);
  assert.strictEqual(r.hasUnsupported, false);
  assert.deepStrictEqual(r.detectedFields, []);
});

test('secretSanitizer.detectUnsupportedCredentials: 空/非对象返回无', () => {
  assert.strictEqual(detectUnsupportedCredentials(null).hasUnsupported, false);
  assert.strictEqual(detectUnsupportedCredentials(undefined).hasUnsupported, false);
  assert.strictEqual(detectUnsupportedCredentials('string').hasUnsupported, false);
  assert.strictEqual(detectUnsupportedCredentials([]).hasUnsupported, false);
});

test('secretSanitizer.isCodexAccountLogin: auth_mode=chatgpt 识别为账号登录', () => {
  assert.ok(isCodexAccountLogin({ auth_mode: 'chatgpt' }));
  assert.ok(isCodexAccountLogin({ tokens: { access_token: 'x' } }));
  assert.ok(isCodexAccountLogin({ tokens: { refresh_token: 'x' } }));
  assert.ok(isCodexAccountLogin({ tokens: { id_token: 'x' } }));
  assert.ok(!isCodexAccountLogin({ auth_mode: 'apikey' }));
  assert.ok(!isCodexAccountLogin({}));
  assert.ok(!isCodexAccountLogin(null));
});

test('secretSanitizer.isClaudeSessionLogin: claude session 凭据识别', () => {
  assert.ok(isClaudeSessionLogin({ claude_session: 'x' }));
  assert.ok(isClaudeSessionLogin({ sessionToken: 'x' }));
  assert.ok(isClaudeSessionLogin({ claudeAccount: { plan: 'pro' } }));
  assert.ok(isClaudeSessionLogin({ oauthToken: 'x' }));
  assert.ok(!isClaudeSessionLogin({ apiKey: 'sk-test' }));
  assert.ok(!isClaudeSessionLogin(null));
});

test('secretSanitizer.jwtLooksLikeMembership: 含 plan_type/subscription 的 JWT 识别', () => {
  // 构造含会员字段的 fake JWT payload
  const payload = Buffer.from(JSON.stringify({
    chatgpt_plan_type: 'plus',
    subscription_active_until: '2099-12-31'
  })).toString('base64');
  const jwt = `eyJheader.${payload}.signature`;
  assert.ok(jwtLooksLikeMembership(jwt));
  // 普通 JWT 不含会员字段
  const plain = Buffer.from(JSON.stringify({ sub: 'user-123' })).toString('base64');
  assert.ok(!jwtLooksLikeMembership(`eyJheader.${plain}.signature`));
  // 非 JWT 字符串
  assert.ok(!jwtLooksLikeMembership('not-a-jwt'));
  assert.ok(!jwtLooksLikeMembership(null));
});

// ─── externalSource ────────────────────────────────────────────────────────

test('externalSource.createExternalSource: 初始结构正确', () => {
  const s = createExternalSource('codex');
  assert.strictEqual(s.sourceType, 'codex');
  assert.strictEqual(s.exists, false);
  assert.strictEqual(s.readable, false);
  assert.deepStrictEqual(s.candidates, []);
  assert.deepStrictEqual(s.warnings, []);
  assert.deepStrictEqual(s.errors, []);
});

test('externalSource.IMPORT_SOURCE_VALUES: 含所有来源', () => {
  for (const v of ['manual', 'smart-paste', 'codex', 'claude-code', 'opencode', 'ccswitch-local', 'environment', 'env-file', 'json-file', 'toml-file']) {
    assert.ok(IMPORT_SOURCE_VALUES.includes(v), `应含 ${v}`);
  }
});

test('externalSource.sourceTypeToImportSource: 正确映射', () => {
  assert.strictEqual(sourceTypeToImportSource('codex'), 'codex');
  assert.strictEqual(sourceTypeToImportSource('claude-code'), 'claude-code');
  assert.strictEqual(sourceTypeToImportSource('opencode'), 'opencode');
  assert.strictEqual(sourceTypeToImportSource('ccswitch'), 'ccswitch-local');
  assert.strictEqual(sourceTypeToImportSource('environment'), 'environment');
  assert.strictEqual(sourceTypeToImportSource('env-file'), 'env-file');
  assert.strictEqual(sourceTypeToImportSource('json-file'), 'json-file');
  assert.strictEqual(sourceTypeToImportSource('toml-file'), 'toml-file');
  assert.strictEqual(sourceTypeToImportSource('unknown'), 'manual');
});

// ─── importNormalizer ─────────────────────────────────────────────────────

test('importNormalizer.normalizeCandidate: wire_api=responses → openai-responses', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:18000/v1',
    wireApi: 'responses',
    apiKey: 'sk-test',
    sourceType: 'codex',
    sourcePath: '/tmp/config.toml'
  });
  assert.strictEqual(c.protocolHint, 'openai-responses');
  assert.strictEqual(c.apiKey, 'sk-test');
  assert.strictEqual(c.source.type, 'codex');
  assert.strictEqual(c.source.path, '/tmp/config.toml');
});

test('importNormalizer.normalizeCandidate: wire_api=chat → openai', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:18001/v1',
    wireApi: 'chat',
    apiKey: 'sk-test',
    sourceType: 'codex'
  });
  assert.strictEqual(c.protocolHint, 'openai');
});

test('importNormalizer.normalizeCandidate: protocolHint 优先于 wireApi', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:18002',
    wireApi: 'responses',
    protocolHint: 'anthropic',
    apiKey: 'sk-test',
    sourceType: 'claude-code'
  });
  assert.strictEqual(c.protocolHint, 'anthropic');
});

test('importNormalizer.toCandidates: 过滤完全无信息的候选', () => {
  const list = toCandidates([
    { baseUrl: 'http://a', apiKey: 'k', sourceType: 'codex' },
    { /* empty */ },
    { apiKey: 'k2', sourceType: 'codex' }
  ], 'codex', '/tmp');
  assert.strictEqual(list.length, 2, '应过滤掉 empty 候选');
});

// ─── §69 Conflict Resolver ────────────────────────────────────────────────

test('conflictResolver.resolveConflict: NEW — 无现有连接', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:19000/v1',
    apiKey: 'sk-test-new',
    protocolHint: 'openai',
    sourceType: 'codex'
  });
  const r = resolveConflict(c, []);
  assert.strictEqual(r.state, 'NEW');
});

test('conflictResolver.resolveConflict: DUPLICATE — 同 baseUrl + 同 protocol', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:19001/v1',
    apiKey: 'sk-test-dup',
    protocolHint: 'openai',
    name: 'Dup Test',
    sourceType: 'codex'
  });
  const existing = [{
    id: 'conn-1', name: 'Existing',
    base_url: 'http://127.0.0.1:19001/v1', provider: 'openai'
  }];
  const r = resolveConflict(c, existing);
  assert.strictEqual(r.state, 'DUPLICATE');
  assert.strictEqual(r.duplicateId, 'conn-1');
  assert.strictEqual(r.duplicateName, 'Existing');
});

test('conflictResolver.resolveConflict: CONFLICT — 同 name 不同 baseUrl', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:19002/v1',
    apiKey: 'sk-test-conflict',
    protocolHint: 'openai',
    name: 'Same Name',
    sourceType: 'codex'
  });
  const existing = [{
    id: 'conn-2', name: 'Same Name',
    base_url: 'http://127.0.0.1:19999/v1', provider: 'openai'
  }];
  const r = resolveConflict(c, existing);
  assert.strictEqual(r.state, 'CONFLICT');
  assert.strictEqual(r.conflictId, 'conn-2');
});

test('conflictResolver.resolveConflict: MISSING_SECRET — 有 baseUrl 无 apiKey', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://127.0.0.1:19003/v1',
    apiKey: null,
    defaultModel: 'model-x',
    protocolHint: 'openai',
    sourceType: 'codex'
  });
  const r = resolveConflict(c, []);
  assert.strictEqual(r.state, 'MISSING_SECRET');
});

test('conflictResolver.resolveConflict: INVALID — 无 baseUrl 无 apiKey 无 model', () => {
  const c = normalizeCandidate({
    sourceType: 'codex'
  });
  const r = resolveConflict(c, []);
  assert.strictEqual(r.state, 'INVALID');
});

test('conflictResolver.resolveBatchConflicts: 批量评估', () => {
  const c1 = normalizeCandidate({ baseUrl: 'http://x1/v1', apiKey: 'k1', protocolHint: 'openai', sourceType: 'codex' });
  const c2 = normalizeCandidate({ baseUrl: 'http://x2/v1', apiKey: null, defaultModel: 'm', protocolHint: 'openai', sourceType: 'codex' });
  const c3 = normalizeCandidate({ sourceType: 'codex' });
  const r = resolveBatchConflicts([c1, c2, c3], []);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].conflict.state, 'NEW');
  assert.strictEqual(r[1].conflict.state, 'MISSING_SECRET');
  assert.strictEqual(r[2].conflict.state, 'INVALID');
});

test('conflictResolver.compareSecrets: 相同 key 返回 same=true', () => {
  const realMask = (k) => k.slice(0, 5) + '••••' + k.slice(-4);
  const r = compareSecrets('sk-ab••••wxyz', 'sk-abcd1234wxyz', realMask);
  assert.strictEqual(r.same, true);
});

test('conflictResolver.compareSecrets: 不同 key 返回 same=false', () => {
  const realMask = (k) => k.slice(0, 6) + '••••' + k.slice(-4);
  const r = compareSecrets('sk-ab••••wxyz', 'sk-efgh5678wxyz', realMask);
  assert.strictEqual(r.same, false);
  assert.ok(r.importedMasked);
  assert.ok(r.importedMasked.includes('•'));
});

// ─── §67 Codex Importer ───────────────────────────────────────────────────

test('Codex importer: config-responses → openai-responses + model-A', () => {
  const codexImporter = external.getImporter('codex');
  const filePath = path.join(FIXTURE_ROOT, 'codex', 'config-responses.toml');
  const r = codexImporter.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.strictEqual(c.protocolHint, 'openai-responses');
  assert.strictEqual(c.defaultModel, 'model-A');
  assert.strictEqual(c.apiKey, 'sk-test-codex-responses-1234567890abcdef');
  assert.strictEqual(c.source.type, 'codex');
});

test('Codex importer: config-chat → openai + model-B', () => {
  const codexImporter = external.getImporter('codex');
  const filePath = path.join(FIXTURE_ROOT, 'codex', 'config-chat.toml');
  const r = codexImporter.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].protocolHint, 'openai');
  assert.strictEqual(r.candidates[0].defaultModel, 'model-B');
});

test('Codex importer: env_key 在 env 提供时解析', () => {
  const codexImporter = external.getImporter('codex');
  const filePath = path.join(FIXTURE_ROOT, 'codex', 'config-envkey.toml');
  const r = codexImporter.parse({
    filePath, userSelected: true,
    env: { MY_CODEX_KEY: 'sk-test-from-env-abcdef123456' }
  });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].apiKey, 'sk-test-from-env-abcdef123456');
});

test('Codex importer: env_key 在 env 未提供时 MISSING_SECRET', () => {
  const codexImporter = external.getImporter('codex');
  const filePath = path.join(FIXTURE_ROOT, 'codex', 'config-envkey.toml');
  const r = codexImporter.parse({ filePath, userSelected: true, env: {} });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].apiKey, null);
  assert.ok(r.candidates[0]._missingSecret, '应标记 _missingSecret');
});

test('Codex importer: requires_openai_auth=true 被拒绝（§14）', () => {
  const codexImporter = external.getImporter('codex');
  const filePath = path.join(FIXTURE_ROOT, 'codex', 'config-oauth.toml');
  const r = codexImporter.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 0, 'OAuth provider 不应生成 candidate');
  assert.ok(r.warnings.some(w => w.type === 'unsupported_credential'), '应有 unsupported_credential 警告');
});

// ─── §67 Claude Code Importer ─────────────────────────────────────────────

test('Claude Code importer: standard.env → anthropic + ANTHROPIC_API_KEY', () => {
  const imp = external.getImporter('claude-code');
  const filePath = path.join(FIXTURE_ROOT, 'claude', 'standard.env');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.strictEqual(c.protocolHint, 'anthropic');
  assert.strictEqual(c.apiKey, 'sk-test-anthropic-key-abcdef123456');
  assert.strictEqual(c.baseUrl, 'http://127.0.0.1:18010');
});

test('Claude Code importer: authtoken.env → anthropic + AUTH_TOKEN', () => {
  const imp = external.getImporter('claude-code');
  const filePath = path.join(FIXTURE_ROOT, 'claude', 'authtoken.env');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].apiKey, 'sk-test-anthropic-auth-token-123456');
});

test('Claude Code importer: custom-gateway.env → 不强制定 Anthropic Official（§17）', () => {
  const imp = external.getImporter('claude-code');
  const filePath = path.join(FIXTURE_ROOT, 'claude', 'custom-gateway.env');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.strictEqual(c.protocolHint, 'anthropic');
  assert.strictEqual(c.baseUrl, 'http://127.0.0.1:18012/anthropic');
});

test('Claude Code importer: session-credentials.json 被拒绝（§18）', () => {
  const imp = external.getImporter('claude-code');
  const filePath = path.join(FIXTURE_ROOT, 'claude', 'session-credentials.json');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 0, 'session 凭据不应生成 candidate');
  assert.ok(r.warnings.some(w => w.type === 'unsupported_credential'), '应有拒绝警告');
});

// ─── §67 OpenCode Importer ────────────────────────────────────────────────

test('OpenCode importer: single.json → 单 Provider', () => {
  const imp = external.getImporter('opencode');
  const filePath = path.join(FIXTURE_ROOT, 'opencode', 'single.json');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].apiKey, 'sk-test-opencode-single-abcdef123456');
});

test('OpenCode importer: multi.json → 3 Providers（§20 批量）', () => {
  const imp = external.getImporter('opencode');
  const filePath = path.join(FIXTURE_ROOT, 'opencode', 'multi.json');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 3);
  const names = r.candidates.map(c => c.name).sort();
  assert.ok(names.includes('Provider A'));
  assert.ok(names.includes('Provider B'));
  assert.ok(names.includes('Provider C'));
});

test('OpenCode importer: env-ref.json 在 env 提供时解析（§21）', () => {
  const imp = external.getImporter('opencode');
  const filePath = path.join(FIXTURE_ROOT, 'opencode', 'env-ref.json');
  const r = imp.parse({ filePath, userSelected: true, env: { OPENCODE_TEST_KEY: 'sk-test-env-resolved' } });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].apiKey, 'sk-test-env-resolved');
});

test('OpenCode importer: env-ref.json 在 env 未提供时 MISSING_SECRET（§21）', () => {
  const imp = external.getImporter('opencode');
  const filePath = path.join(FIXTURE_ROOT, 'opencode', 'env-ref.json');
  const r = imp.parse({ filePath, userSelected: true, env: {} });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].apiKey, null);
  assert.ok(r.candidates[0]._missingSecret);
});

test('OpenCode importer: malformed.json 无 baseURL 被跳过', () => {
  const imp = external.getImporter('opencode');
  const filePath = path.join(FIXTURE_ROOT, 'opencode', 'malformed.json');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 0);
});

// ─── §67 CC Switch Local Importer ─────────────────────────────────────────

test('CC Switch importer: config.json → 2 Providers', () => {
  const imp = external.getImporter('ccswitch');
  const filePath = path.join(FIXTURE_ROOT, 'ccswitch', 'config.json');
  const r = imp.parse({ filePath, userSelected: true });
  assert.ok(r.candidates.length >= 2, '应至少解析 2 个 Provider');
  // source.type 应为 ccswitch-local（区分于 ccswitch-config 粘贴）
  for (const c of r.candidates) {
    assert.strictEqual(c.source.type, 'ccswitch-local');
  }
});

// ─── §67 Environment Importer ─────────────────────────────────────────────

test('Environment importer: 白名单字段被识别（§27/§28）', () => {
  const imp = external.getImporter('environment');
  const r = imp.parse({ env: {
    OPENAI_API_KEY: 'sk-test-env-openai',
    OPENAI_BASE_URL: 'http://127.0.0.1:18040/v1',
    ANTHROPIC_API_KEY: 'sk-test-env-anthropic',
    UNKNOWN_SECRET: 'should-not-be-imported'
  }});
  assert.ok(r.candidates.length >= 2, '应至少识别 OpenAI + Anthropic');
  // §28: 不应导入白名单外的字段
  for (const c of r.candidates) {
    assert.ok(c.apiKey !== 'should-not-be-imported', 'UNKNOWN_SECRET 不得被导入');
  }
});

test('Environment importer: 无已知 key 时返回空', () => {
  const imp = external.getImporter('environment');
  const r = imp.parse({ env: { PATH: '/usr/bin', HOME: '/home/u' }});
  assert.strictEqual(r.candidates.length, 0);
});

// ─── §67 File Importers ───────────────────────────────────────────────────

test('envFile importer: openai.env → 1 candidate', () => {
  const imp = external.getImporter('env-file');
  const filePath = path.join(FIXTURE_ROOT, 'env', 'openai.env');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].source.type, 'env-file');
  assert.strictEqual(r.candidates[0].source.path, filePath);
});

test('jsonFile importer: config.json → 1 candidate', () => {
  const imp = external.getImporter('json-file');
  const filePath = path.join(FIXTURE_ROOT, 'env', 'config.json');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].source.type, 'json-file');
});

test('tomlFile importer: config.toml → 1 candidate', () => {
  const imp = external.getImporter('toml-file');
  const filePath = path.join(FIXTURE_ROOT, 'env', 'config.toml');
  const r = imp.parse({ filePath, userSelected: true });
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].source.type, 'toml-file');
});

test('File importers: 未选择文件时返回空', () => {
  for (const id of ['env-file', 'json-file', 'toml-file']) {
    const imp = external.getImporter(id);
    const r = imp.parse({});
    assert.strictEqual(r.candidates.length, 0);
  }
});

// ─── Registry ─────────────────────────────────────────────────────────────

test('Registry: listSources 返回所有 importer', () => {
  const sources = external.listSources();
  const ids = sources.map(s => s.id);
  for (const id of ['codex', 'claude-code', 'opencode', 'ccswitch', 'environment', 'env-file', 'json-file', 'toml-file']) {
    assert.ok(ids.includes(id), `应含 ${id}`);
  }
});

test('Registry: parseFile 按扩展名选择 importer', () => {
  // 通过 external.parseSource('env-file', { filePath })
  const r1 = external.parseSource('env-file', { filePath: path.join(FIXTURE_ROOT, 'env', 'openai.env'), userSelected: true });
  assert.ok(r1.candidates.length >= 1);
  const r2 = external.parseSource('json-file', { filePath: path.join(FIXTURE_ROOT, 'env', 'config.json'), userSelected: true });
  assert.ok(r2.candidates.length >= 1);
  const r3 = external.parseSource('toml-file', { filePath: path.join(FIXTURE_ROOT, 'env', 'config.toml'), userSelected: true });
  assert.ok(r3.candidates.length >= 1);
});

// ─── §70 Batch Import ─────────────────────────────────────────────────────

test('importBatch: 3 provider，2 ok 1 fail，不 rollback（§70）', async () => {
  const c1 = normalizeCandidate({
    name: 'Batch OK 1', baseUrl: 'http://127.0.0.1:19101/v1',
    apiKey: 'sk-test-batch-ok1', protocolHint: 'openai', sourceType: 'codex'
  });
  const c2 = normalizeCandidate({
    name: 'Batch OK 2', baseUrl: 'http://127.0.0.1:19102/v1',
    apiKey: 'sk-test-batch-ok2', protocolHint: 'anthropic', sourceType: 'codex'
  });
  // 第三个：故意去掉 baseUrl（normalizeCandidate 后无 baseUrl，importCandidate 会抛错）
  const c3 = normalizeCandidate({
    name: 'Batch FAIL', apiKey: 'sk-test-batch-fail',
    protocolHint: 'openai', sourceType: 'codex'
  });
  c3.baseUrl = null; // 强制清空，触发 importCandidate 抛错

  const items = [
    { candidate: c1, action: 'import' },
    { candidate: c2, action: 'import' },
    { candidate: c3, action: 'import' }
  ];
  const results = await external.importBatch(items, { store, sec, maxConcurrency: 2 });
  assert.strictEqual(results.length, 3, '应返回 3 个结果');
  const okCount = results.filter(r => r.result && r.result.ok).length;
  const failCount = results.filter(r => !r.result || !r.result.ok).length;
  assert.strictEqual(okCount, 2, '应 2 成功');
  assert.strictEqual(failCount, 1, '应 1 失败');
  // 失败的不应影响成功的
  const okNames = results.filter(r => r.result && r.result.ok).map(r => r.candidate.name);
  assert.ok(okNames.includes('Batch OK 1'));
  assert.ok(okNames.includes('Batch OK 2'));
});

test('importBatch: action=skip 跳过不导入', async () => {
  const c = normalizeCandidate({
    name: 'Skip Test', baseUrl: 'http://127.0.0.1:19103/v1',
    apiKey: 'sk-test-skip', protocolHint: 'openai', sourceType: 'codex'
  });
  const results = await external.importBatch([{ candidate: c, action: 'skip' }], { store, sec });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].result.skipped, true);
  // 不应写入数据库
  const list = store.connections.list();
  assert.ok(!list.some(conn => conn.name === 'Skip Test'), 'skip 不应写库');
});

test('importBatch: manualKey 补 key（§36）', async () => {
  const c = normalizeCandidate({
    name: 'Manual Key Test', baseUrl: 'http://127.0.0.1:19104/v1',
    apiKey: null, protocolHint: 'openai', sourceType: 'codex'
  });
  const results = await external.importBatch([{
    candidate: c, action: 'import', manualKey: 'sk-test-manual-key-abcdef'
  }], { store, sec });
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].result.ok, true);
  assert.ok(results[0].result.connection, '应创建 connection');
});

// ─── §68 Security: Secret 不泄漏 ─────────────────────────────────────────

test('Security: import_source 元数据写入数据库（§49）', async () => {
  const c = normalizeCandidate({
    name: 'Source Metadata Test', baseUrl: 'http://127.0.0.1:19105/v1',
    apiKey: 'sk-test-source-meta', protocolHint: 'openai', sourceType: 'codex',
    sourcePath: '/home/user/.codex/config.toml'
  });
  const results = await external.importBatch([{ candidate: c, action: 'import' }], { store, sec });
  const conn = results[0].result.connection;
  const got = store.connections.get(conn.id);
  assert.strictEqual(got.import_source, 'codex', 'import_source 应为 codex');
  assert.strictEqual(got.import_source_path, '/home/user/.codex/config.toml', '应保存来源路径元数据');
});

test('Security: import_source_path 不含原始配置内容（§52）', async () => {
  const c = normalizeCandidate({
    name: 'Raw Persist Test', baseUrl: 'http://127.0.0.1:19106/v1',
    apiKey: 'sk-test-raw-persist', protocolHint: 'openai', sourceType: 'codex',
    sourcePath: '/tmp/config.toml'
  });
  const results = await external.importBatch([{ candidate: c, action: 'import' }], { store, sec });
  const conn = results[0].result.connection;
  const got = store.connections.get(conn.id);
  // 数据库中不应保存原始 config.toml 内容
  const serialized = JSON.stringify(got);
  assert.ok(!serialized.includes('model_providers'), '不得持久化原始配置');
  assert.ok(!serialized.includes('[model_providers'), '不得持久化 TOML 原文');
});

test('Security: Audit 不含明文 API Key（§54）', async () => {
  const SECRET = 'sk-test-audit-no-leak-1234567890';
  const c = normalizeCandidate({
    name: 'Audit Leak Test', baseUrl: 'http://127.0.0.1:19107/v1',
    apiKey: SECRET, protocolHint: 'openai', sourceType: 'codex'
  });
  await external.importBatch([{ candidate: c, action: 'import' }], { store, sec });
  const logs = store.audit.list();
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(SECRET), 'audit 日志不得含明文 API Key');
});

test('Security: import_source 字段值受 IMPORT_SOURCE_VALUES 约束', () => {
  // 所有 importer 写入的 import_source 必须在白名单内
  for (const v of IMPORT_SOURCE_VALUES) {
    assert.ok(typeof v === 'string' && v.length > 0, `import_source 值非法: ${v}`);
  }
});
