'use strict';
/**
 * v2.4.0 — Smart API Onboarding: Parser + URL Normalizer + Secret Sanitizer + Presets + importCandidate。
 *
 * 覆盖 spec §68（Parser 单元测试）、§69（Security）、§70（URL Normalization）、
 * §47/§48（重复检测不用 secret hash）、§11/§39/§40（importCandidate + 主智能体分配）。
 *
 * Parser 必须脱离 GUI 独立测试（§9）—— 这里只 require onboarding 模块，不触 GUI。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const onboarding = require('../src/providers/onboarding');
const { parseInput } = onboarding;
const { normalizeBaseUrl, joinUrl, candidateModelPaths } = require('../src/providers/onboarding/urlNormalizer');
const { sanitizeCandidate, createCandidate, isSecretField, isViable } = require('../src/providers/onboarding/candidate');
const { detectPreset, listPresets, suggestName } = require('../src/providers/onboarding/presets');
const plainText = require('../src/providers/onboarding/parsers/plainText');
const env = require('../src/providers/onboarding/parsers/env');
const json = require('../src/providers/onboarding/parsers/json');
const toml = require('../src/providers/onboarding/parsers/toml');
const curl = require('../src/providers/onboarding/parsers/curl');
const codeSnippet = require('../src/providers/onboarding/parsers/codeSnippet');
const ccSwitch = require('../src/providers/onboarding/parsers/ccSwitch');

const store = require('../src/db/store');
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-onboard-'));
store.init(USER_DATA);

const SECRET = 'sk-test-secret-1234567890abcdef';

// ─── §70 URL Normalization ──────────────────────────────────────────────────

test('URL Normalizer: 去尾斜杠、补 scheme、保留 /v1', () => {
  assert.strictEqual(normalizeBaseUrl('https://x.com'), 'https://x.com');
  assert.strictEqual(normalizeBaseUrl('https://x.com/'), 'https://x.com');
  assert.strictEqual(normalizeBaseUrl('https://x.com/v1'), 'https://x.com/v1');
  assert.strictEqual(normalizeBaseUrl('https://x.com/v1/'), 'https://x.com/v1');
  assert.strictEqual(normalizeBaseUrl('x.com/v1'), 'https://x.com/v1');
  assert.strictEqual(normalizeBaseUrl('localhost:11434'), 'http://localhost:11434');
  assert.strictEqual(normalizeBaseUrl('127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.strictEqual(normalizeBaseUrl('"https://x.com/v1"'), 'https://x.com/v1');
  assert.strictEqual(normalizeBaseUrl(''), null);
  assert.strictEqual(normalizeBaseUrl(null), null);
});

test('URL Normalizer: joinUrl 不产生 /v1/v1', () => {
  assert.strictEqual(joinUrl('https://x.com/v1', '/models'), 'https://x.com/v1/models');
  assert.strictEqual(joinUrl('https://x.com/v1/', '/models'), 'https://x.com/v1/models');
  assert.strictEqual(joinUrl('https://x.com', '/v1/models'), 'https://x.com/v1/models');
  assert.strictEqual(joinUrl('https://x.com/v1', '/v1/models'), 'https://x.com/v1/models', '重复 /v1 必须折叠');
  assert.strictEqual(joinUrl('https://x.com', '/models'), 'https://x.com/models');
});

test('candidateModelPaths: 有 /v1 只返回 /models，否则 /v1/models 优先', () => {
  assert.deepStrictEqual(candidateModelPaths('https://x.com/v1'), ['/models']);
  assert.deepStrictEqual(candidateModelPaths('https://x.com'), ['/v1/models', '/models']);
  assert.deepStrictEqual(candidateModelPaths(''), []);
});

// ─── §68 Parser: plain text ─────────────────────────────────────────────────

test('Parser A: 带标签普通文本（接口地址/API Key）', () => {
  const text = `接口地址：https://api.example.com/v1\nAPI Key：${SECRET}`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'plainText');
  const c = r.candidate;
  assert.strictEqual(c.baseUrl, 'https://api.example.com/v1');
  assert.strictEqual(c.apiKey, SECRET);
  assert.ok(c.source.confidence >= 0.9, 'URL+Key 同时存在置信度应高');
});

test('Parser B: 纯 URL + Key 两行', () => {
  const text = `https://api.example.com/v1\n${SECRET}`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'plainText');
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

test('Parser: 裸 sk-xxx 行识别为 key', () => {
  const text = `https://api.example.com/v1\nsk-ant-abcdefgh1234567890`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, 'sk-ant-abcdefgh1234567890');
});

test('Parser: Authorization: Bearer 抽到 apiKey', () => {
  const text = `https://api.example.com/v1\nAuthorization: Bearer ${SECRET}`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

test('Parser: x-api-key 抽到 apiKey', () => {
  const text = `https://api.example.com/v1\nx-api-key: ${SECRET}`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

// ─── §68 Parser: ENV ────────────────────────────────────────────────────────

test('Parser C: sh ENV (OPENAI_API_KEY / OPENAI_BASE_URL)', () => {
  const text = `OPENAI_API_KEY=${SECRET}\nOPENAI_BASE_URL=https://api.example.com/v1`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'env');
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
  assert.strictEqual(r.candidate.providerHint, 'openai');
});

test('Parser C: sh ENV with export 前缀', () => {
  const text = `export OPENAI_API_KEY=${SECRET}\nexport OPENAI_BASE_URL=https://api.example.com/v1`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'env');
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

test('Parser D: PowerShell ENV ($env:)', () => {
  const text = `$env:OPENAI_API_KEY="${SECRET}"\n$env:OPENAI_BASE_URL="https://api.example.com/v1"`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'env');
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
});

test('Parser: ANTHROPIC ENV 映射到 anthropic preset', () => {
  const text = `ANTHROPIC_API_KEY=${SECRET}\nANTHROPIC_BASE_URL=https://api.anthropic.com`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.providerHint, 'anthropic');
  assert.strictEqual(r.candidate.protocolHint, 'anthropic');
});

test('Parser: 任意 ENV 块不含已知 key 时不误吞', () => {
  // 不含 API_KEY/BASE_URL 等已知 key，env parser 应返回 null
  const text = `FOO=bar\nBAZ=qux`;
  const r = parseInput(text);
  // 走 plainText 兜底，但 plainText 也不会把 FOO=bar 当成 url/key
  assert.ok(!r.candidate || !r.candidate.apiKey, '不应把 FOO=bar 当成 key');
});

// ─── §68 Parser: JSON ───────────────────────────────────────────────────────

test('Parser E: JSON { apiKey, baseURL, model }', () => {
  const text = JSON.stringify({ apiKey: SECRET, baseURL: 'https://api.example.com/v1', model: 'gpt-4o' });
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'json');
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
  assert.strictEqual(r.candidate.defaultModel, 'gpt-4o');
});

test('Parser: JSON secret header 抽到 apiKey（不重复存在 §52）', () => {
  const text = JSON.stringify({ baseURL: 'https://api.example.com/v1', headers: { Authorization: `Bearer ${SECRET}` } });
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.ok(!r.candidate.headers.Authorization, 'secret header 不应重复存在');
});

// ─── §68 Parser: curl ───────────────────────────────────────────────────────

test('Parser H: curl + Authorization Bearer', () => {
  const text = `curl https://api.example.com/v1/chat/completions -H "Authorization: Bearer ${SECRET}"`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'curl');
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1', '应剥掉 /chat/completions');
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

test('Parser H: curl + x-api-key + body model', () => {
  const text = `curl -X POST https://api.example.com/v1/chat/completions -H "x-api-key: ${SECRET}" -d '{"model":"gpt-4o"}'`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.strictEqual(r.candidate.defaultModel, 'gpt-4o');
});

test('Parser H: curl 行尾续行（反斜杠）', () => {
  const text = `curl https://api.example.com/v1/chat/completions \\\n  -H "Authorization: Bearer ${SECRET}"`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

// ─── §68 Parser: JS / Python code snippet ───────────────────────────────────

test('Parser F: JS new OpenAI({ apiKey, baseURL })', () => {
  const text = `new OpenAI({ apiKey: "${SECRET}", baseURL: "https://api.example.com/v1" })`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'codeSnippet');
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
});

test('Parser G: Python OpenAI(api_key=, base_url=)', () => {
  const text = `OpenAI(\n    api_key="${SECRET}",\n    base_url="https://api.example.com/v1"\n)`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'codeSnippet');
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
});

// ─── §68 Parser: TOML ───────────────────────────────────────────────────────

test('Parser I: TOML Codex 风格 [model_providers.foo]', () => {
  // 真实 Codex config.toml 格式：顶层 model/model_provider 在 [model_providers.*] 之前
  const text = `
model = "foo-1"
model_provider = "foo"

[model_providers.foo]
name = "Foo"
base_url = "https://api.foo.com/v1"
env_key = "FOO_API_KEY"
`.trim();
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'toml');
  assert.strictEqual(r.candidate.baseUrl, 'https://api.foo.com/v1');
  assert.strictEqual(r.candidate.defaultModel, 'foo-1');
  assert.strictEqual(r.candidate.name, 'Foo');
  // env_key 不是 secret，只是变量名
  assert.ok(!r.candidate.apiKey, 'env_key 不应被当作 apiKey');
});

// ─── §68 Parser: CC Switch ──────────────────────────────────────────────────

test('Parser J: CC Switch Deep Link', () => {
  const text = `ccswitch://v1/import?resource=provider&app=claude&name=MyClaude&endpoint=https://api.anthropic.com&apiKey=${SECRET}&model=claude-3-5-sonnet`;
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'ccSwitch-deeplink');
  const c = r.candidate;
  assert.strictEqual(c.name, 'MyClaude');
  assert.strictEqual(c.baseUrl, 'https://api.anthropic.com');
  assert.strictEqual(c.apiKey, SECRET);
  assert.strictEqual(c.defaultModel, 'claude-3-5-sonnet');
  assert.strictEqual(c.protocolHint, 'anthropic', 'app=claude 映射到 anthropic');
});

test('Parser J: CC Switch Deep Link 无效 resource 拒绝', () => {
  const text = `ccswitch://v1/import?resource=mcp&name=foo`;
  const r = parseInput(text);
  assert.ok(!r.candidate, 'resource != provider 不在本 parser 范围');
});

test('Parser J: CC Switch Config 批量', () => {
  const arr = [
    { name: 'OpenAI', settingsConfig: { env: { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: SECRET } } },
    { name: 'Anthropic', settingsConfig: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'sk-ant-xxx' } } }
  ];
  const text = JSON.stringify(arr);
  const r = parseInput(text);
  assert.strictEqual(r.matchedParser, 'ccSwitch-config-batch');
  assert.strictEqual(r.batch.length, 2);
  assert.strictEqual(r.batch[0].apiKey, SECRET);
  assert.strictEqual(r.batch[1].apiKey, 'sk-ant-xxx');
});

test('CC Switch parseConfigBatch: 跳过无效条目', () => {
  const arr = [
    { name: 'OK', settingsConfig: { env: { OPENAI_BASE_URL: 'https://api.openai.com/v1', OPENAI_API_KEY: SECRET } } },
    { name: 'Empty' } // 无 settingsConfig
  ];
  const batch = ccSwitch.parseConfigBatch(arr);
  assert.strictEqual(batch.length, 1);
  assert.strictEqual(batch[0].name, 'OK');
});

// ─── §68 Parser: 边界 / malformed ───────────────────────────────────────────

test('Parser: 空输入返回空', () => {
  assert.deepStrictEqual(parseInput(''), {});
  assert.deepStrictEqual(parseInput(null), {});
  assert.deepStrictEqual(parseInput('   '), {});
});

test('Parser: 无 URL 无 Key 的纯文本兜底返回 null', () => {
  const r = parseInput('只是一段普通文字，没有 API 信息');
  assert.ok(!r.candidate || (!r.candidate.baseUrl && !r.candidate.apiKey));
});

test('Parser: 只有 URL 无 Key 仍可解析', () => {
  const r = parseInput('https://api.example.com/v1');
  assert.ok(r.candidate);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.example.com/v1');
  assert.ok(!r.candidate.apiKey);
  assert.ok(isViable(r.candidate), '有 baseUrl 即可导入候选');
});

test('Parser: 只有 Key 无 URL 仍可解析', () => {
  const r = parseInput(SECRET);
  assert.ok(r.candidate);
  assert.strictEqual(r.candidate.apiKey, SECRET);
  assert.ok(!r.candidate.baseUrl);
});

test('Parser: 多个 URL 取第一个', () => {
  const text = `https://api.first.com/v1\nhttps://api.second.com/v1\n${SECRET}`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.baseUrl, 'https://api.first.com/v1');
});

test('Parser: 多个 Key 取第一个', () => {
  const text = `https://api.example.com/v1\nAPI Key: ${SECRET}\nAPI Key: sk-other-key`;
  const r = parseInput(text);
  assert.strictEqual(r.candidate.apiKey, SECRET);
});

test('Parser: malformed JSON 不崩溃', () => {
  const r = parseInput('{not valid json');
  assert.ok(!r.candidate || !r.candidate.baseUrl, 'malformed JSON 不应崩溃也不应误识别');
});

test('Parser: malformed curl 不崩溃', () => {
  const r = parseInput('curl');
  assert.ok(!r.candidate || !r.candidate.baseUrl);
});

// ─── §69 Security: Secret Mask + 不泄漏 ─────────────────────────────────────

test('Security: sanitizeCandidate mask apiKey', () => {
  const c = createCandidate();
  c.apiKey = SECRET;
  const safe = sanitizeCandidate(c);
  assert.ok(!safe.apiKey.includes(SECRET), 'mask 后不应包含完整 key');
  assert.ok(safe.apiKey.includes('*'), '应含 *');
  assert.strictEqual(safe.apiKey.slice(0, 4), SECRET.slice(0, 4), '前 4 位保留');
  assert.strictEqual(safe.apiKey.slice(-4), SECRET.slice(-4), '后 4 位保留');
});

test('Security: sanitizeCandidate mask headers 里的 secret 字段', () => {
  const c = createCandidate();
  c.headers = { Authorization: `Bearer ${SECRET}`, 'x-org': 'my-org' };
  const safe = sanitizeCandidate(c);
  assert.ok(!String(safe.headers.Authorization).includes(SECRET), 'Authorization 应被 mask');
  assert.strictEqual(safe.headers['x-org'], 'my-org', '非 secret header 保留');
});

test('Security: sanitizeCandidate 不改变原 candidate（不可变性）', () => {
  const c = createCandidate();
  c.apiKey = SECRET;
  sanitizeCandidate(c);
  assert.strictEqual(c.apiKey, SECRET, '原 candidate 的明文 key 必须保留（用于后续 probe/import）');
});

test('Security: serialize(safe) 不含明文 key', () => {
  const c = createCandidate();
  c.apiKey = SECRET;
  c.baseUrl = 'https://x.com';
  const safe = sanitizeCandidate(c);
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes(SECRET), '序列化预览不得含明文 key');
});

test('Security: isSecretField 识别常见 secret 字段名', () => {
  assert.ok(isSecretField('api_key'));
  assert.ok(isSecretField('apiKey'));
  assert.ok(isSecretField('apikey'));
  assert.ok(isSecretField('token'));
  assert.ok(isSecretField('auth_token'));
  assert.ok(isSecretField('access_token'));
  assert.ok(isSecretField('OPENAI_API_KEY'));
  assert.ok(isSecretField('ANTHROPIC_API_KEY'));
  assert.ok(isSecretField('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(isSecretField('authorization'));
  assert.ok(isSecretField('x-api-key'));
  assert.ok(isSecretField('secret'));
  assert.ok(!isSecretField('x-org'));
  assert.ok(!isSecretField('content-type'));
});

test('Security: defaultMask 短 key 也 mask', () => {
  const c = createCandidate();
  c.apiKey = 'sk-ab';
  const safe = sanitizeCandidate(c); // 不传 sec，走 defaultMask
  assert.ok(!safe.apiKey.includes('sk-ab') || safe.apiKey.length < 5, '短 key 也应 mask');
});

// ─── §21 Presets ────────────────────────────────────────────────────────────

test('Presets: listPresets 含 OpenAI/Anthropic/OpenRouter/DeepSeek/Ollama/LMStudio/Custom', () => {
  const ids = listPresets().map(p => p.id);
  for (const id of ['openai', 'anthropic', 'openrouter', 'deepseek', 'ollama', 'lmstudio', 'custom']) {
    assert.ok(ids.includes(id), `应含 preset: ${id}`);
  }
});

test('Presets: detectPreset by alias', () => {
  assert.strictEqual(detectPreset({ alias: 'deepseek' }).id, 'deepseek');
  assert.strictEqual(detectPreset({ alias: 'claude' }).id, 'anthropic');
  assert.strictEqual(detectPreset({ alias: 'lm-studio' }).id, 'lmstudio');
});

test('Presets: detectPreset by hostname', () => {
  assert.strictEqual(detectPreset({ hostname: 'api.deepseek.com' }).id, 'deepseek');
  assert.strictEqual(detectPreset({ hostname: 'openrouter.ai' }).id, 'openrouter');
  assert.strictEqual(detectPreset({ hostname: 'api.anthropic.com' }).id, 'anthropic');
});

test('Presets: detectPreset 未识别返回 custom', () => {
  assert.strictEqual(detectPreset({ hostname: 'api.unknown-vendor.com' }).id, 'custom');
});

test('Presets: OpenRouter/DeepSeek 复用 openai 协议（不新增 vendor protocol §22/§23）', () => {
  assert.strictEqual(detectPreset({ alias: 'openrouter' }).protocol, 'openai');
  assert.strictEqual(detectPreset({ alias: 'deepseek' }).protocol, 'openai');
});

test('Presets: suggestName by hostname', () => {
  assert.strictEqual(suggestName('https://api.deepseek.com/v1'), 'DeepSeek');
  assert.strictEqual(suggestName('http://localhost:11434'), 'Ollama');
  assert.ok(suggestName('https://api.example.com/v1'));
});

// ─── §11/§39/§40 importCandidate + 主智能体分配 ─────────────────────────────

test('importCandidate: 写入数据库，secret 走 sec.encrypt', () => {
  const c = createCandidate();
  c.name = '测试连接A';
  c.baseUrl = 'https://api.test-a.example.com/v1';
  c.apiKey = SECRET;
  c.protocolHint = 'openai';
  c.models = ['model-a', 'model-b'];
  const sec = require('../src/security/secret');
  const r = onboarding.importCandidate(c, { store, sec });
  assert.ok(r.connection && r.connection.id, '应返回 connection');
  assert.strictEqual(r.assigned, false, '未指定 assignToMain 不分配');
  const got = store.connections.get(r.connection.id);
  assert.strictEqual(got.name, '测试连接A');
  assert.strictEqual(got.base_url, 'https://api.test-a.example.com/v1');
  // secret 字段应已加密（不等于明文）
  assert.notStrictEqual(got.api_key, SECRET, 'api_key 必须加密存储');
  assert.ok(got.models && got.models.length >= 2, '模型应写入');
});

test('importCandidate: assignToMain 一键分配主智能体', () => {
  // 先确保有主智能体（fresh store 没有则创建一个）
  let main = store.agents.list().find(a => a.is_main);
  if (!main) {
    main = store.agents.create({ name: '主智能体', type: 'coding', is_main: true, model: 'old-model' });
  }
  const oldConn = main.api_connection_id;

  const c = createCandidate();
  c.name = '主智能体测试';
  c.baseUrl = 'https://api.main-test.example.com/v1';
  c.apiKey = SECRET;
  c.protocolHint = 'openai';
  c.models = ['main-model'];
  c.defaultModel = 'main-model';
  const sec = require('../src/security/secret');
  const r = onboarding.importCandidate(c, { store, sec, assignToMain: true });
  assert.strictEqual(r.assigned, true, '应分配成功');
  const after = store.agents.get(main.id);
  assert.strictEqual(after.api_connection_id, r.connection.id, '主智能体 api_connection_id 应更新');
  assert.strictEqual(after.model, 'main-model', '主智能体 model 应更新');
});

test('importCandidate: §47 重复检测（同 baseUrl + 同 provider）', () => {
  const c = createCandidate();
  c.name = '重复测试';
  c.baseUrl = 'https://api.dup.example.com/v1';
  c.apiKey = SECRET;
  c.protocolHint = 'openai';
  const sec = require('../src/security/secret');
  const r1 = onboarding.importCandidate(c, { store, sec });
  const r2 = onboarding.importCandidate(c, { store, sec });
  assert.ok(r1.duplicate === false, '首次导入非重复');
  assert.ok(r2.duplicate === true, '第二次应检测到重复');
  assert.strictEqual(r2.connection.id, r1.connection.id, '重复时返回已存在连接');
});

test('importCandidate: §48 不用 secret hash 做重复索引（同 baseUrl+protocol 不同 key 仍判重）', () => {
  const c1 = createCandidate();
  c1.name = 'Key A';
  c1.baseUrl = 'https://api.nokeyhash.example.com/v1';
  c1.apiKey = 'sk-key-a-1111111111111111';
  c1.protocolHint = 'openai';
  const c2 = createCandidate();
  c2.name = 'Key B';
  c2.baseUrl = 'https://api.nokeyhash.example.com/v1';
  c2.apiKey = 'sk-key-b-2222222222222222';
  c2.protocolHint = 'openai';
  const sec = require('../src/security/secret');
  const r1 = onboarding.importCandidate(c1, { store, sec });
  const r2 = onboarding.importCandidate(c2, { store, sec });
  assert.ok(r2.duplicate === true, '同 baseUrl+protocol 不同 key 仍判重');
});

test('importCandidate: forceOverwrite 覆盖现有连接', () => {
  const c1 = createCandidate();
  c1.name = '原连接';
  c1.baseUrl = 'https://api.overw.example.com/v1';
  c1.apiKey = 'sk-original-aaaaaaaaaaaaaaaa';
  c1.protocolHint = 'openai';
  const sec = require('../src/security/secret');
  const r1 = onboarding.importCandidate(c1, { store, sec });

  const c2 = createCandidate();
  c2.name = '新连接';
  c2.baseUrl = 'https://api.overw.example.com/v1';
  c2.apiKey = 'sk-newkey-bbbbbbbbbbbbbbbb';
  c2.protocolHint = 'openai';
  const r2 = onboarding.importCandidate(c2, { store, sec, forceOverwrite: true });
  assert.strictEqual(r2.connection.id, r1.connection.id, '覆盖应保持同一 id');
  const got = store.connections.get(r1.connection.id);
  assert.strictEqual(got.name, '新连接', 'name 应被覆盖');
});

test('importCandidate: isViable 拒绝空候选', () => {
  const empty = createCandidate();
  const sec = require('../src/security/secret');
  assert.throws(() => onboarding.importCandidate(empty, { store, sec }), /候选不可导入/);
});

// ─── §60 Audit 不泄漏 key ───────────────────────────────────────────────────

test('Audit: importCandidate 审计记录不含 API Key', () => {
  const c = createCandidate();
  c.name = '审计测试';
  c.baseUrl = 'https://api.audit.example.com/v1';
  c.apiKey = SECRET;
  c.protocolHint = 'openai';
  c.source.type = 'plain-text';
  const sec = require('../src/security/secret');
  onboarding.importCandidate(c, { store, sec });
  const logs = store.audit.list();
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes(SECRET), '审计日志不得含明文 API Key');
});
