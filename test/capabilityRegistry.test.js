'use strict';
/**
 * CapabilityRegistry tests.
 *
 * Verifies:
 *   - CAPABILITIES has exactly 17 keys
 *   - all() returns every capability key
 *   - has() returns true for valid, false for invalid
 *   - match() returns { matched, missing, preferredMatched }
 *   - match() with all required present / missing required / preferred capabilities
 */
const test = require('node:test');
const assert = require('node:assert');

const { CAPABILITIES, createCapabilityRegistry } = require('../src/agents/hub/capabilityRegistry');

test('CAPABILITIES: 包含 17 个能力键', () => {
  assert.strictEqual(Object.keys(CAPABILITIES).length, 17);
});

test('CAPABILITIES: 值为小写字符串，无重复', () => {
  const values = Object.values(CAPABILITIES);
  assert.strictEqual(values.length, 17);
  assert.strictEqual(new Set(values).size, 17);
  for (const v of values) {
    assert.strictEqual(typeof v, 'string');
    assert.ok(/^[a-z][a-zA-Z]*$/.test(v), `能力键 ${v} 应为 camelCase`);
  }
});

test('CAPABILITIES: 包含核心能力键', () => {
  for (const k of ['CODING', 'PLANNING', 'FILESYSTEM', 'TERMINAL', 'COMPUTER', 'VISION', 'GIT', 'BROWSER', 'MCP', 'SANDBOX']) {
    assert.ok(CAPABILITIES[k], `缺少核心能力 ${k}`);
  }
});

test('all(): 返回全部 17 个能力键', () => {
  const r = createCapabilityRegistry();
  const all = r.all();
  assert.strictEqual(all.length, 17);
  assert.deepStrictEqual(all.slice().sort(), Object.values(CAPABILITIES).sort());
});

test('all(): 返回副本，修改不影响内部', () => {
  const r = createCapabilityRegistry();
  const a = r.all();
  a.push('mutated');
  const b = r.all();
  assert.strictEqual(b.length, 17);
  assert.ok(!b.includes('mutated'));
});

test('has(): 合法能力返回 true', () => {
  const r = createCapabilityRegistry();
  for (const v of Object.values(CAPABILITIES)) {
    assert.strictEqual(r.has(v), true, `应识别 ${v}`);
  }
});

test('has(): 非法能力返回 false', () => {
  const r = createCapabilityRegistry();
  assert.strictEqual(r.has('not-a-cap'), false);
  assert.strictEqual(r.has('CODEX'), false);  // 大写键名不是能力值
  assert.strictEqual(r.has(''), false);
  assert.strictEqual(r.has(null), false);
  assert.strictEqual(r.has(undefined), false);
});

test('match(): 返回 { matched, missing, preferredMatched }', () => {
  const r = createCapabilityRegistry();
  const res = r.match({ coding: true }, ['coding'], []);
  assert.ok(Array.isArray(res.matched));
  assert.ok(Array.isArray(res.missing));
  assert.ok(Array.isArray(res.preferredMatched));
});

test('match(): 所有 required 都满足', () => {
  const r = createCapabilityRegistry();
  const agentCaps = { coding: true, filesystem: true, terminal: true, vision: false };
  const res = r.match(agentCaps, ['coding', 'filesystem', 'terminal']);
  assert.deepStrictEqual(res.matched.sort(), ['coding', 'filesystem', 'terminal']);
  assert.deepStrictEqual(res.missing, []);
});

test('match(): 缺失部分 required', () => {
  const r = createCapabilityRegistry();
  const agentCaps = { coding: true, filesystem: false };
  const res = r.match(agentCaps, ['coding', 'filesystem', 'terminal']);
  assert.deepStrictEqual(res.matched, ['coding']);
  assert.deepStrictEqual(res.missing.sort(), ['filesystem', 'terminal']);
});

test('match(): capabilities 为 false 视为缺失', () => {
  const r = createCapabilityRegistry();
  const res = r.match({ coding: false }, ['coding']);
  assert.deepStrictEqual(res.matched, []);
  assert.deepStrictEqual(res.missing, ['coding']);
});

test('match(): preferred 能力不影响 matched/missing', () => {
  const r = createCapabilityRegistry();
  const agentCaps = { coding: true, vision: true, computer: false };
  const res = r.match(agentCaps, ['coding'], ['vision', 'computer', 'git']);
  assert.deepStrictEqual(res.matched, ['coding']);
  assert.deepStrictEqual(res.missing, []);
  assert.deepStrictEqual(res.preferredMatched, ['vision']);  // 只有 vision=true
});

test('match(): preferred 全部满足', () => {
  const r = createCapabilityRegistry();
  const agentCaps = { coding: true, vision: true, diff: true };
  const res = r.match(agentCaps, ['coding'], ['vision', 'diff']);
  assert.deepStrictEqual(res.preferredMatched.sort(), ['diff', 'vision']);
});

test('match: 空 required / preferred 返回空数组', () => {
  const r = createCapabilityRegistry();
  const res = r.match({ coding: true });
  assert.deepStrictEqual(res.matched, []);
  assert.deepStrictEqual(res.missing, []);
  assert.deepStrictEqual(res.preferredMatched, []);
});

test('match: agentCaps 为 null/undefined 不抛错', () => {
  const r = createCapabilityRegistry();
  const a = r.match(null, ['coding']);
  assert.deepStrictEqual(a.missing, ['coding']);
  const b = r.match(undefined, ['coding']);
  assert.deepStrictEqual(b.missing, ['coding']);
});
