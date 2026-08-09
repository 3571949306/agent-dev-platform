'use strict';
/**
 * v2.5.1 — Hostile Input Defense 单元测试。
 *
 * 覆盖 spec §24/§25/§26：
 *   §24 Fuzz Test：畸形 JSON/TOML/ENV 输入不 crash / 不 eval / 不 require
 *   §25 Prototype Pollution：__proto__ / prototype / constructor 被过滤
 *   §26 URL Scheme Whitelist：baseUrl 只允许 http/https
 *
 * 所有 fixture 在 test/fixtures/external-import/hostile/ 下。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  sanitizeObject,
  safeJsonParse,
  validateUrlScheme,
  isLocalUrl,
  hasControlChars,
  sanitizeString,
  FORBIDDEN_KEYS
} = require('../src/providers/onboarding/external/security/inputSanitizer');
const { normalizeCandidate } = require('../src/providers/onboarding/external/importNormalizer');
const { parse: parseJsonText } = require('../src/providers/onboarding/parsers/json');
const { parse: parseTomlText } = require('../src/providers/onboarding/parsers/toml');
const { parse: parseEnvText } = require('../src/providers/onboarding/parsers/env');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'external-import', 'hostile');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8');
}

/** 检查对象是否有 own property key */
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ─── §25 Prototype Pollution ──────────────────────────────────────────────

test('sanitizeObject: 过滤顶层 __proto__', () => {
  // 用 JSON.parse 构造含 __proto__ own property 的对象（不用对象字面量 __proto__ 语法）
  const input = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
  assert.ok(hasOwn(input, '__proto__'));
  const out = sanitizeObject(input);
  assert.strictEqual(out.a, 1);
  assert.strictEqual(hasOwn(out, '__proto__'), false);
  // 全局原型未被污染
  assert.strictEqual(Object.prototype.polluted, undefined);
});

test('sanitizeObject: 过滤 constructor / prototype', () => {
  const input = JSON.parse('{"a":1,"constructor":{"prototype":{"x":1}},"prototype":{"y":2}}');
  const out = sanitizeObject(input);
  assert.strictEqual(out.a, 1);
  assert.strictEqual(hasOwn(out, 'constructor'), false);
  assert.strictEqual(hasOwn(out, 'prototype'), false);
});

test('sanitizeObject: 递归过滤嵌套对象', () => {
  const input = JSON.parse('{"headers":{"X-Ok":"yes","__proto__":{"nested":true},"constructor":{"prototype":{"deep":true}}},"models":[{"name":"gpt-4","__proto__":{"evil":true}}]}');
  const out = sanitizeObject(input);
  assert.strictEqual(out.headers['X-Ok'], 'yes');
  assert.strictEqual(hasOwn(out.headers, '__proto__'), false);
  assert.strictEqual(hasOwn(out.headers, 'constructor'), false);
  assert.strictEqual(out.models[0].name, 'gpt-4');
  assert.strictEqual(hasOwn(out.models[0], '__proto__'), false);
  // 全局原型未被污染
  assert.strictEqual(Object.prototype.nested, undefined);
  assert.strictEqual(Object.prototype.deep, undefined);
  assert.strictEqual(Object.prototype.evil, undefined);
});

test('sanitizeObject: 数组递归过滤', () => {
  const input = JSON.parse('[{"ok":1,"__proto__":{"a":1}},{"ok":2,"constructor":{"prototype":{"b":2}}}]');
  const out = sanitizeObject(input);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].ok, 1);
  assert.strictEqual(hasOwn(out[0], '__proto__'), false);
  assert.strictEqual(out[1].ok, 2);
  assert.strictEqual(hasOwn(out[1], 'constructor'), false);
  assert.strictEqual(Object.prototype.a, undefined);
  assert.strictEqual(Object.prototype.b, undefined);
});

test('sanitizeObject: 不修改原始对象', () => {
  const input = JSON.parse('{"a":1,"__proto__":{"polluted":true}}');
  const originalKeys = Object.keys(input);
  sanitizeObject(input);
  assert.deepStrictEqual(Object.keys(input), originalKeys);
});

test('sanitizeObject: 深度超限截断为 null', () => {
  // 构造深度 > 5 的嵌套对象
  let obj = 'deep';
  for (let i = 0; i < 40; i++) obj = { nested: obj };
  const out = sanitizeObject(obj, { maxDepth: 5 });
  // 深度超限后，深层值截断为 null，但顶层对象仍存在
  assert.ok(out !== null);
  assert.ok(typeof out === 'object');
  // 递归到深度 6 处应为 null
  let cur = out;
  for (let i = 0; i < 6; i++) {
    if (cur === null) break;
    cur = cur.nested;
  }
  assert.strictEqual(cur, null);
});

test('sanitizeObject: 字段数超限截断', () => {
  const input = {};
  for (let i = 0; i < 100; i++) input[`key${i}`] = i;
  const out = sanitizeObject(input, { maxKeys: 10 });
  assert.strictEqual(Object.keys(out).length, 10);
});

test('sanitizeObject: 字符串长度限制', () => {
  const longStr = 'x'.repeat(100);
  const out = sanitizeObject({ s: longStr }, { maxStringLength: 10 });
  assert.strictEqual(out.s.length, 10);
});

test('sanitizeObject: 原始值原样返回', () => {
  assert.strictEqual(sanitizeObject(42), 42);
  assert.strictEqual(sanitizeObject(true), true);
  assert.strictEqual(sanitizeObject(null), null);
  assert.strictEqual(sanitizeObject('hello'), 'hello');
});

test('safeJsonParse: 正常 JSON 解析', () => {
  const obj = safeJsonParse('{"a":1,"b":"hello"}');
  assert.strictEqual(obj.a, 1);
  assert.strictEqual(obj.b, 'hello');
});

test('safeJsonParse: 过滤 prototype pollution', () => {
  const obj = safeJsonParse('{"a":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}');
  assert.strictEqual(obj.a, 1);
  assert.strictEqual(hasOwn(obj, '__proto__'), false);
  assert.strictEqual(hasOwn(obj, 'constructor'), false);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(Object.prototype.x, undefined);
});

test('safeJsonParse: 畸形 JSON 返回 null', () => {
  assert.strictEqual(safeJsonParse('{broken'), null);
  assert.strictEqual(safeJsonParse(''), null);
  assert.strictEqual(safeJsonParse(null), null);
  assert.strictEqual(safeJsonParse(undefined), null);
});

test('safeJsonParse: 数组 prototype pollution 过滤', () => {
  const arr = safeJsonParse('[{"ok":1,"__proto__":{"evil":true}}]');
  assert.strictEqual(arr.length, 1);
  assert.strictEqual(arr[0].ok, 1);
  assert.strictEqual(hasOwn(arr[0], '__proto__'), false);
  assert.strictEqual(Object.prototype.evil, undefined);
});

test('FORBIDDEN_KEYS: 包含 __proto__ / prototype / constructor', () => {
  assert.ok(FORBIDDEN_KEYS.has('__proto__'));
  assert.ok(FORBIDDEN_KEYS.has('prototype'));
  assert.ok(FORBIDDEN_KEYS.has('constructor'));
});

// ─── §26 URL Scheme Whitelist ────────────────────────────────────────────

test('validateUrlScheme: https 通过', () => {
  const r = validateUrlScheme('https://api.openai.com/v1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scheme, 'https:');
});

test('validateUrlScheme: http 通过', () => {
  const r = validateUrlScheme('http://localhost:8080/v1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.scheme, 'http:');
});

test('validateUrlScheme: javascript: 拒绝', () => {
  const r = validateUrlScheme('javascript:alert(1)');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不允许的协议/);
});

test('validateUrlScheme: file: 拒绝', () => {
  const r = validateUrlScheme('file:///C:/secret.txt');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不允许的协议/);
});

test('validateUrlScheme: data: 拒绝', () => {
  const r = validateUrlScheme('data:text/html,<script>alert(1)</script>');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不允许的协议/);
});

test('validateUrlScheme: ftp: 拒绝', () => {
  const r = validateUrlScheme('ftp://evil.com/file');
  assert.strictEqual(r.ok, false);
});

test('validateUrlScheme: ws: 拒绝', () => {
  const r = validateUrlScheme('ws://evil.com/socket');
  assert.strictEqual(r.ok, false);
});

test('validateUrlScheme: wss: 拒绝', () => {
  const r = validateUrlScheme('wss://evil.com/socket');
  assert.strictEqual(r.ok, false);
});

test('validateUrlScheme: gopher: 拒绝', () => {
  const r = validateUrlScheme('gopher://evil.com');
  assert.strictEqual(r.ok, false);
});

test('validateUrlScheme: 空字符串拒绝', () => {
  assert.strictEqual(validateUrlScheme('').ok, false);
  assert.strictEqual(validateUrlScheme(null).ok, false);
  assert.strictEqual(validateUrlScheme(undefined).ok, false);
});

test('validateUrlScheme: 畸形 URL 拒绝', () => {
  const r = validateUrlScheme('not-a-url');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /URL 格式无效/);
});

test('isLocalUrl: localhost 识别', () => {
  assert.strictEqual(isLocalUrl('http://localhost:8080'), true);
  assert.strictEqual(isLocalUrl('http://127.0.0.1:3000'), true);
});

test('isLocalUrl: IPv6 ::1 识别', () => {
  // new URL('http://[::1]:8080').hostname 返回 '[::1]'（含方括号）
  assert.strictEqual(isLocalUrl('http://[::1]:8080'), true);
});

test('isLocalUrl: 私有 IP 段识别', () => {
  assert.strictEqual(isLocalUrl('http://10.0.0.1'), true);
  assert.strictEqual(isLocalUrl('http://192.168.1.1'), true);
  assert.strictEqual(isLocalUrl('http://172.16.0.1'), true);
  assert.strictEqual(isLocalUrl('http://172.31.255.255'), true);
});

test('isLocalUrl: 公网 IP 不识别', () => {
  assert.strictEqual(isLocalUrl('https://api.openai.com'), false);
  assert.strictEqual(isLocalUrl('http://8.8.8.8'), false);
  assert.strictEqual(isLocalUrl('http://172.32.0.1'), false);  // 172.32 不在私有段
});

// ─── §24 控制字符检测 ────────────────────────────────────────────────────

test('hasControlChars: null byte 检测', () => {
  assert.strictEqual(hasControlChars('hello\0world'), true);
});

test('hasControlChars: 正常字符串无控制字符', () => {
  assert.strictEqual(hasControlChars('hello world'), false);
  assert.strictEqual(hasControlChars('line1\nline2\ttab'), false);
});

test('sanitizeString: 移除 null byte', () => {
  assert.strictEqual(sanitizeString('hello\0world'), 'helloworld');
});

test('sanitizeString: 截断超长字符串', () => {
  const long = 'x'.repeat(100);
  assert.strictEqual(sanitizeString(long, 10).length, 10);
});

// ─── §24 Fuzz：畸形 JSON fixture 不 crash ─────────────────────────────────

test('Fuzz: 空 JSON 文件不 crash', () => {
  const text = readFixture('empty.json');
  const obj = safeJsonParse(text);
  // 空 JSON 对象可被解析
  assert.ok(obj === null || (typeof obj === 'object'));
});

test('Fuzz: broken JSON 文件不 crash', () => {
  const text = readFixture('broken.json');
  const obj = safeJsonParse(text);
  assert.strictEqual(obj, null);
});

test('Fuzz: prototype pollution JSON 不污染原型', () => {
  const text = readFixture('prototype-pollution.json');
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  assert.strictEqual(hasOwn(obj, '__proto__'), false);
  assert.strictEqual(hasOwn(obj, 'constructor'), false);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(Object.prototype.topPolluted, undefined);
  assert.strictEqual(Object.prototype.polluted2, undefined);
});

test('Fuzz: javascript: URL JSON 被拒绝', () => {
  const text = readFixture('javascript-url.json');
  const obj = safeJsonParse(text);
  const c = normalizeCandidate({
    baseUrl: obj.baseUrl,
    apiKey: obj.apiKey,
    sourceType: 'json-file'
  });
  // baseUrl 被拒绝后保持 null（createCandidate 默认值）
  assert.ok(!c.baseUrl);
  assert.ok(c._invalidBaseUrl);
  assert.match(c._invalidBaseUrl, /不允许的协议/);
});

test('Fuzz: data: URL JSON 被拒绝', () => {
  const text = readFixture('data-url.json');
  const obj = safeJsonParse(text);
  const c = normalizeCandidate({
    baseUrl: obj.baseUrl,
    apiKey: obj.apiKey,
    sourceType: 'json-file'
  });
  assert.ok(!c.baseUrl);
  assert.ok(c._invalidBaseUrl);
});

test('Fuzz: file: URL JSON 被拒绝', () => {
  const text = readFixture('file-url.json');
  const obj = safeJsonParse(text);
  const c = normalizeCandidate({
    baseUrl: obj.baseUrl,
    apiKey: obj.apiKey,
    sourceType: 'json-file'
  });
  assert.ok(!c.baseUrl);
  assert.ok(c._invalidBaseUrl);
});

test('Fuzz: null bytes JSON 不 crash', () => {
  const text = readFixture('null-bytes.json');
  const obj = safeJsonParse(text);
  // null bytes 在 JSON 中是合法的 unicode escape，可被解析
  assert.ok(obj !== null);
});

test('Fuzz: huge whitespace JSON 不 crash', () => {
  const text = readFixture('huge-whitespace.json');
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  assert.ok(obj.headers['X-Spam'].length > 0);
});

test('Fuzz: deeply nested objects JSON 不 crash', () => {
  const text = readFixture('nested-objects.json');
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  // 通过 sanitizeObject 后，深度 > MAX_DEPTH 的部分截断为 null
  const sanitized = sanitizeObject(obj);
  assert.ok(sanitized !== null);
});

test('Fuzz: json parser 处理 prototype pollution JSON 不 crash', () => {
  const text = readFixture('prototype-pollution.json');
  const c = parseJsonText(text);
  assert.ok(c !== null);
  // apiKey 应该被提取
  assert.strictEqual(c.apiKey, 'sk-test-abc123');
});

test('Fuzz: json parser 处理 javascript: URL 不 crash', () => {
  const text = readFixture('javascript-url.json');
  const c = parseJsonText(text);
  // json parser 自己不做 URL scheme 校验（由 importNormalizer 做）
  // 但不应 crash
  assert.ok(c !== null || c === null);
});

// ─── §24 Fuzz：畸形 TOML fixture 不 crash ─────────────────────────────────

test('Fuzz: prototype pollution TOML 不 crash', () => {
  const text = readFixture('prototype-pollution.toml');
  const c = parseTomlText(text);
  assert.ok(c !== null);
  assert.strictEqual(c.apiKey, 'sk-test-abc123');
});

test('Fuzz: broken TOML 不 crash', () => {
  const text = readFixture('broken.toml');
  const c = parseTomlText(text);
  // 畸形 TOML 可能返回 null 或部分解析结果，关键是不 crash
  assert.ok(c === null || typeof c === 'object');
});

test('Fuzz: empty TOML 不 crash', () => {
  const text = readFixture('empty.toml');
  const c = parseTomlText(text);
  assert.strictEqual(c, null);
});

// ─── §24 Fuzz：畸形 ENV fixture 不 crash ──────────────────────────────────

test('Fuzz: prototype pollution ENV 不 crash', () => {
  const text = readFixture('prototype-pollution.env');
  const c = parseEnvText(text);
  assert.ok(c !== null);
  assert.strictEqual(c.apiKey, 'sk-test-abc123');
  // __proto__ / constructor 不是已知 KEY_MAP 项，会进 extras 但不影响
});

test('Fuzz: javascript: URL ENV 不 crash', () => {
  const text = readFixture('javascript-url.env');
  const c = parseEnvText(text);
  assert.ok(c !== null);
  // 通过 normalizeCandidate 后 URL scheme 会被校验
  const nc = normalizeCandidate({
    baseUrl: c.baseUrl,
    apiKey: c.apiKey,
    sourceType: 'env-file'
  });
  assert.ok(!nc.baseUrl);
  assert.ok(nc._invalidBaseUrl);
});

test('Fuzz: empty ENV 不 crash', () => {
  const text = readFixture('empty.env');
  const c = parseEnvText(text);
  assert.strictEqual(c, null);
});

// ─── §24 综合：normalizeCandidate 不被 hostile 输入污染 ─────────────────────

test('normalizeCandidate: prototype pollution headers 被过滤', () => {
  const headers = JSON.parse('{"X-Ok":"yes","__proto__":{"polluted":true},"constructor":{"prototype":{"deep":true}}}');
  const c = normalizeCandidate({
    name: 'test',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test-abc123',
    headers,
    sourceType: 'json-file'
  });
  assert.strictEqual(c.headers['X-Ok'], 'yes');
  assert.strictEqual(hasOwn(c.headers, '__proto__'), false);
  assert.strictEqual(hasOwn(c.headers, 'constructor'), false);
  assert.strictEqual(Object.prototype.polluted, undefined);
  assert.strictEqual(Object.prototype.deep, undefined);
});

test('normalizeCandidate: javascript: baseUrl 被拒绝', () => {
  const c = normalizeCandidate({
    baseUrl: 'javascript:alert(1)',
    apiKey: 'sk-test-abc123',
    sourceType: 'json-file'
  });
  assert.ok(!c.baseUrl);
  assert.ok(c._invalidBaseUrl);
  assert.match(c._invalidBaseUrl, /不允许的协议/);
});

test('normalizeCandidate: file: baseUrl 被拒绝', () => {
  const c = normalizeCandidate({
    baseUrl: 'file:///C:/secret.txt',
    apiKey: 'sk-test-abc123',
    sourceType: 'json-file'
  });
  assert.ok(!c.baseUrl);
  assert.ok(c._invalidBaseUrl);
});

test('normalizeCandidate: data: baseUrl 被拒绝', () => {
  const c = normalizeCandidate({
    baseUrl: 'data:text/html,<script>alert(1)</script>',
    apiKey: 'sk-test-abc123',
    sourceType: 'json-file'
  });
  assert.ok(!c.baseUrl);
  assert.ok(c._invalidBaseUrl);
});

test('normalizeCandidate: http: localhost 通过', () => {
  const c = normalizeCandidate({
    baseUrl: 'http://localhost:8080/v1',
    apiKey: 'sk-test-abc123',
    sourceType: 'json-file'
  });
  assert.ok(c.baseUrl);
  assert.ok(c.baseUrl.includes('localhost'));
  assert.strictEqual(c._invalidBaseUrl, undefined);
});

test('normalizeCandidate: https: 公网通过', () => {
  const c = normalizeCandidate({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-abc123',
    sourceType: 'json-file'
  });
  assert.ok(c.baseUrl);
  assert.strictEqual(c._invalidBaseUrl, undefined);
});

test('normalizeCandidate: models prototype pollution 被过滤', () => {
  const models = JSON.parse('[{"id":"gpt-4","__proto__":{"evil":true}},{"id":"claude-3","constructor":{"prototype":{"bad":true}}}]');
  const c = normalizeCandidate({
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-test-abc123',
    models,
    sourceType: 'json-file'
  });
  assert.strictEqual(c.models.length, 2);
  assert.strictEqual(c.models[0].id, 'gpt-4');
  assert.strictEqual(hasOwn(c.models[0], '__proto__'), false);
  assert.strictEqual(c.models[1].id, 'claude-3');
  assert.strictEqual(hasOwn(c.models[1], 'constructor'), false);
  assert.strictEqual(Object.prototype.evil, undefined);
  assert.strictEqual(Object.prototype.bad, undefined);
});

// ─── §24 重复字段 / BOM / CRLF / unicode ──────────────────────────────────

test('Fuzz: BOM 前缀 JSON 不 crash', () => {
  const text = '\uFEFF{"name":"bom","baseUrl":"https://api.test.com/v1","apiKey":"sk-test-abc123"}';
  const obj = safeJsonParse(text);
  // BOM 会导致 JSON.parse 失败，safeJsonParse 返回 null
  assert.strictEqual(obj, null);
});

test('Fuzz: CRLF 行尾 JSON 不 crash', () => {
  const text = '{"name":"crlf","baseUrl":"https://api.test.com/v1","apiKey":"sk-test-abc123"}\r\n';
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  assert.strictEqual(obj.name, 'crlf');
});

test('Fuzz: unicode 内容 JSON 不 crash', () => {
  const text = '{"name":"中文配置","baseUrl":"https://api.test.com/v1","apiKey":"sk-test-abc123"}';
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  assert.strictEqual(obj.name, '中文配置');
});

test('Fuzz: 重复字段 JSON 不 crash', () => {
  const text = '{"apiKey":"sk-first","apiKey":"sk-second","baseUrl":"https://api.test.com/v1"}';
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  // JSON.parse 后者覆盖前者
  assert.strictEqual(obj.apiKey, 'sk-second');
});

test('Fuzz: very long key JSON 不 crash', () => {
  const longKey = 'k'.repeat(10000);
  const text = `{"${longKey}":"value","baseUrl":"https://api.test.com/v1","apiKey":"sk-test-abc123"}`;
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  // sanitizeObject 会保留这个 key（长度 < 256 才保留，否则跳过）
  // 但 baseUrl / apiKey 是顶层字段，不受影响
});

test('Fuzz: very long URL JSON 不 crash', () => {
  const longUrl = 'https://api.test.com/' + 'a'.repeat(10000);
  const text = `{"name":"longurl","baseUrl":"${longUrl}","apiKey":"sk-test-abc123"}`;
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
});

test('Fuzz: very long model name JSON 不 crash', () => {
  const longModel = 'm'.repeat(10000);
  const text = `{"name":"longmodel","baseUrl":"https://api.test.com/v1","apiKey":"sk-test-abc123","defaultModel":"${longModel}"}`;
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
});

test('Fuzz: wrong type JSON 不 crash', () => {
  const text = '{"name":123,"baseUrl":true,"apiKey":[]}';
  const obj = safeJsonParse(text);
  assert.ok(obj !== null);
  // 类型异常但不 crash
});

test('Fuzz: 42 不 crash（非对象 JSON）', () => {
  const obj = safeJsonParse('42');
  assert.strictEqual(obj, 42);
  // sanitizeObject 对原始值原样返回
  const sanitized = sanitizeObject(obj);
  assert.strictEqual(sanitized, 42);
});
