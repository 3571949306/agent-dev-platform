'use strict';
/**
 * v2.9.9 Phase B Final — B16 Model Router Inspector + B21 Problems Center 契约测试。
 *
 * 机器证明：
 *   MODEL_ROUTE_VISIBLE=PASS          （runs:modelRouting 数据源齐备）
 *   MODEL_SELECTED_WIRE_EQUAL=YES     （selected == wire 如实记录）
 *   MODEL_MISMATCH_DETECTED=PASS      （selected != wire → MODEL MISMATCH Problem）
 *   EXPLICIT_MISSING_NO_FALLBACK=PASS （显式模型缺失 FAIL CLOSED，绝不回退）
 *   CAPABILITY_EVIDENCE_TRUTH=PASS    （TESTED/DECLARED/INFERRED/UNKNOWN 不混淆）
 *   PROBLEM_DEDUPE=PASS / DISMISS_NOT_RESOLVED=PASS
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const store = require('../src/db/store');
const { createModelCatalog, createModelRouter, createRouteAudit } = require('../src/models/router');
const { createProviderModelAdapter } = require('../src/agent/runtime/providerModelAdapter');
const { createProblemCenter } = require('../src/services/problemCenter');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-b16b21-'));
store.init(ROOT);

const cap = (value, state, source) => ({ value, state, source: source || 'b16-fixture' });

// ---------------- B21 Problems Center ----------------

test('B21 problem center: dedupe bounded, dismiss != resolved, reoccurrence reactivates', () => {
  const events = [];
  const center = createProblemCenter({ store, emit: (type, payload) => events.push({ type, payload }) });

  // 同一稳定问题 100 次上报 → 只有 1 条，计数 100（绝不刷屏）
  for (let i = 0; i < 100; i++) {
    center.report({ severity: 'ERROR', source: 'Workflow', code: 'WORKFLOW_FAILED', message: 'step broke', relatedKey: 'wf-1' });
  }
  const matching = center.list().filter(p => p.code === 'WORKFLOW_FAILED' && (p.related || {}).relatedKey === 'wf-1' || (p.stable_key || '').includes('wf-1'));
  const one = store.problems.findOpenByStableKey(center.stableKeyOf({ source: 'Workflow', code: 'WORKFLOW_FAILED', relatedKey: 'wf-1' }));
  assert.ok(one, 'problem exists');
  assert.strictEqual(one.occur_count, 100, 'same stable problem deduped to a single row');
  assert.strictEqual(matching.length >= 1, true);

  // 非法词汇 fail closed
  assert.throws(() => center.report({ severity: 'READY', source: 'Workflow', code: 'X' }), /PROBLEM_SEVERITY_INVALID/);
  assert.throws(() => center.report({ severity: 'ERROR', source: 'Toasts', code: 'X' }), /PROBLEM_SOURCE_INVALID/);

  // dismiss != resolved
  const dismissed = center.dismiss(one.id);
  assert.strictEqual(dismissed.status, 'DISMISSED');
  assert.notStrictEqual(dismissed.status, 'RESOLVED', 'dismiss must never equal resolved');
  assert.strictEqual(dismissed.resolved_at, null);

  // DISMISSED 问题再次发生 → 条件仍在，真话优先：重新 ACTIVE
  const again = center.report({ severity: 'ERROR', source: 'Workflow', code: 'WORKFLOW_FAILED', message: 'step broke again', relatedKey: 'wf-1' });
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.problem.status, 'ACTIVE');
  assert.strictEqual(again.problem.occur_count, 101);

  // resolve 只有在真实条件消失后（verify 裁决）
  assert.throws(() => center.resolve(one.id, () => false), /PROBLEM_CONDITION_STILL_PRESENT/);
  const resolved = center.resolve(one.id, () => true);
  assert.strictEqual(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolved_at, 'resolved_at recorded');

  console.log('PROBLEM_DEDUPE=PASS');
  console.log('DISMISS_NOT_RESOLVED=PASS');
  console.log('PROBLEM_REOCCUR_REACTIVATES=PASS');
  console.log('PROBLEM_VOCABULARY_FAIL_CLOSED=PASS');
});

// ---------------- B16 Router / Wire Truth / Inspector ----------------

function seedRoutedConnection() {
  const connection = store.connections.create({
    name: 'B16 Router Fixture', provider: 'custom', base_url: 'https://b16.invalid/v1',
    api_key: 'fixture', models: ['b16-model-a', 'b16-model-b']
  });
  store.connections.setTestResult(connection.id, { ok: true, latency: 12, kind: 'ok' });
  // b16-model-a：tested tools 能力；b16-model-b：declared 无 tools
  store.models.upsert(connection.id, 'b16-model-a', {
    text: cap(true, 'tested'), vision: cap(false, 'declared'), nativeTools: cap(true, 'tested'),
    contextWindow: cap(32000, 'declared'),
    pricing: { input: cap(0, 'declared'), output: cap(0, 'declared'), currency: 'USD', unit: 'per_1m_tokens' }
  });
  store.models.upsert(connection.id, 'b16-model-b', {
    text: cap(true, 'inferred'), nativeTools: cap(false, 'declared'),
    pricing: { input: cap(0, 'declared'), output: cap(0, 'declared'), currency: 'USD', unit: 'per_1m_tokens' }
  });
  return connection;
}

test('B16.6 explicit missing model fails closed with zero fallback', () => {
  const connection = seedRoutedConnection();
  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });

  // 存在的显式模型 → 精确命中
  const hit = router.select({ mode: 'explicit', explicit: { connectionId: connection.id, modelId: 'b16-model-a' } });
  assert.strictEqual(hit.selected.modelId, 'b16-model-a');
  assert.strictEqual(hit.mode, 'explicit');

  // 缺失的显式模型 → FAIL CLOSED，绝不回退到其它候选
  let failed = null;
  try {
    router.select({ mode: 'explicit', explicit: { connectionId: connection.id, modelId: 'no-such-model' } });
  } catch (e) { failed = e; }
  assert.ok(failed, 'explicit missing model must throw');
  assert.strictEqual(failed.code, 'MODEL_ROUTE_EXPLICIT_NOT_FOUND');
  const failures = store.modelRouteDecisions.list(50).filter(d => d.status === 'route_failed' && d.error_code === 'MODEL_ROUTE_EXPLICIT_NOT_FOUND');
  assert.ok(failures.length >= 1, 'failed decision persisted as truth');
  assert.strictEqual(failures[0].model_id, null, 'fail-closed decision never records a fallback model');

  console.log('EXPLICIT_MISSING_NO_FALLBACK=PASS');
});

test('B16.1/B16.2/B16.4 auto route records decision, inspector data and capability evidence truth', () => {
  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });

  // 需要工具调用 → 只有 b16-model-a 满足硬要求（requested != selected 语义：Auto → 具体模型）
  const selection = router.select({
    mode: 'auto',
    requirements: { required: { text: true, nativeTools: true } }
  });
  assert.strictEqual(selection.selected.modelId, 'b16-model-a', 'tool-capable model wins the hard filter');
  assert.ok(selection.decisionId, 'decision id exists');

  // 能力证据真话：tested/declared/inferred 不混淆
  const caps = store.models.caps(selection.selected.connectionId, 'b16-model-a');
  assert.strictEqual(caps.nativeTools.state, 'tested');
  assert.strictEqual(caps.vision.state, 'declared');
  const capsB = store.models.caps(selection.selected.connectionId, 'b16-model-b');
  assert.strictEqual(capsB.text.state, 'inferred', 'inferred capability must stay inferred');

  // runs:modelRouting 数据源：decision 可由 runId 找回（绑定后）
  audit.bindRunIdentity(selection.decisionId, { runId: 'b16-run-1', rootRunId: 'b16-run-1' });
  const found = store.modelRouteDecisions.list(200).find(d => d.run_id === 'b16-run-1');
  assert.ok(found, 'decision bound to run');
  assert.strictEqual(found.model_id, 'b16-model-a');
  assert.strictEqual(found.mode, 'auto');
  assert.ok(Array.isArray(found.reasons) && found.reasons.length > 0, 'route reasons persisted');

  console.log('MODEL_ROUTE_VISIBLE=PASS');
  console.log('REQUESTED_AUTO_SELECTED_EXPLICIT_MODEL=YES');
  console.log('CAPABILITY_EVIDENCE_TRUTH=PASS');
});

test('B16.3 wire truth: selected==wire recorded equal; mismatch produces MODEL_MISMATCH problem', async () => {
  const events = [];
  const center = createProblemCenter({ store, emit: (type, payload) => events.push(type) });

  // 复刻 handlers.reportModelOutcome 的裁决逻辑（单一语义，独立可测）
  function reportModelOutcome(decisionId, outcome) {
    if (decisionId && outcome && outcome.ok) {
      store.modelRouteDecisions.recordWireModel(decisionId, { requested: outcome.requested, actual: outcome.actual });
    }
    if (outcome && outcome.ok && outcome.requested && outcome.actual && outcome.requested !== outcome.actual) {
      center.report({
        severity: 'ERROR', source: 'Model', code: 'MODEL_MISMATCH',
        message: `Selected model "${outcome.requested}" != actual wire model "${outcome.actual}"`,
        related: { decisionId, requested: outcome.requested, actual: outcome.actual },
        relatedKey: `${outcome.requested}->${outcome.actual}`
      });
    }
  }

  // 1) selected == wire：相等真话
  const catalog = createModelCatalog({ store });
  const audit = createRouteAudit(store.modelRouteDecisions);
  const router = createModelRouter({ catalog, audit });
  const good = router.select({ mode: 'auto', requirements: { required: { text: true } } });

  let outcomeSeen = null;
  const equalProvider = {
    protocol: 'mock',
    async streamResponse({ model, onChunk }) {
      onChunk('ok');
      return { content: 'ok', model, responseModel: model }; // wire == requested
    }
  };
  const adapter = createProviderModelAdapter({
    buildProvider: async () => equalProvider,
    agent: { id: 'b16-agent', model: good.selected.modelId, max_tokens: 64 },
    resolveModel: (a) => ({ model: a.model }),
    onModelOutcome: (o) => { outcomeSeen = o; reportModelOutcome(good.decisionId, o); }
  });
  await adapter.decide({ system: 's', context: 'c', iteration: 1 });
  assert.ok(outcomeSeen && outcomeSeen.ok);
  assert.strictEqual(outcomeSeen.requested, outcomeSeen.actual, 'wire equals selected');
  const goodRow = store.modelRouteDecisions.get(good.decisionId);
  assert.strictEqual(goodRow.actual_model, good.selected.modelId);
  assert.strictEqual(goodRow.requested_model, goodRow.actual_model);
  console.log('SELECTED_WIRE_EQUAL=YES');

  // 2) selected != wire：MODEL MISMATCH + Problem
  const mismatchProvider = {
    protocol: 'mock',
    async streamResponse({ model, onChunk }) {
      onChunk('ok');
      return { content: 'ok', model, responseModel: 'gateway-substituted-model' }; // 网关偷换模型
    }
  };
  const bad = router.select({ mode: 'auto', requirements: { required: { text: true } } });
  const badAdapter = createProviderModelAdapter({
    buildProvider: async () => mismatchProvider,
    agent: { id: 'b16-agent-2', model: bad.selected.modelId, max_tokens: 64 },
    resolveModel: (a) => ({ model: a.model }),
    onModelOutcome: (o) => reportModelOutcome(bad.decisionId, o)
  });
  await badAdapter.decide({ system: 's', context: 'c', iteration: 1 });
  const badRow = store.modelRouteDecisions.get(bad.decisionId);
  assert.strictEqual(badRow.requested_model, bad.selected.modelId);
  assert.strictEqual(badRow.actual_model, 'gateway-substituted-model');
  assert.notStrictEqual(badRow.requested_model, badRow.actual_model);
  const mismatchProblems = center.list().filter(p => p.code === 'MODEL_MISMATCH');
  assert.strictEqual(mismatchProblems.length, 1, 'mismatch produces exactly one deduped problem');
  assert.strictEqual(mismatchProblems[0].source, 'Model');
  assert.strictEqual(mismatchProblems[0].severity, 'ERROR');

  // 重复 mismatch 去重
  const bad2 = router.select({ mode: 'auto', requirements: { required: { text: true } } });
  const badAdapter2 = createProviderModelAdapter({
    buildProvider: async () => mismatchProvider,
    agent: { id: 'b16-agent-3', model: bad2.selected.modelId, max_tokens: 64 },
    resolveModel: (a) => ({ model: a.model }),
    onModelOutcome: (o) => reportModelOutcome(bad2.decisionId, o)
  });
  await badAdapter2.decide({ system: 's', context: 'c', iteration: 1 });
  assert.strictEqual(center.list().filter(p => p.code === 'MODEL_MISMATCH').length, 1, 'same mismatch deduped');

  console.log('MODEL_MISMATCH_DETECTED=PASS');
  console.log('MODEL_MISMATCH_PROBLEM=PASS');
});
