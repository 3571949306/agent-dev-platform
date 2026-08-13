'use strict';
/**
 * v2.9.9 Phase B PART A — Core Workbench Closure 契约测试。
 *
 * A1 Verification Truth：completed != PASS，验证结论只来自机器证据。
 * A2 Effective Project Identity：Child Run 沿真实 root lineage 解析项目，不猜。
 * A3 Logical Event Deduplication：逻辑身份去重，bounded 缓存，合法重复不误吞。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  VERIFICATION_STATUS,
  verificationFromOutcome,
  verificationFromTestEvents,
  resolveRunVerificationStatus
} = require('../src/agent/runVerification');
const { resolveRunProjectId } = require('../src/agent/runProjectIdentity');
const { parseStatus } = require('../src/services/workbenchGit');

// ---------------- A1 — Verification Truth ----------------

test('A1 completed != PASS: verification only from machine evidence', () => {
  // Run A：completed + 真实 PASS 证据（CompletionPolicy 裁决）
  assert.strictEqual(
    verificationFromOutcome({ status: 'completed', completion: { verificationStatus: 'PASS' }, tests: [] }),
    'PASS');

  // Run B：completed + 无配置测试（CompletionPolicy 如实裁决 NOT_AVAILABLE）
  assert.strictEqual(
    verificationFromOutcome({ status: 'completed', completion: { verificationStatus: 'NOT_AVAILABLE' }, tests: [] }),
    'NOT_AVAILABLE');

  // Run C：completed + 验证从未执行（无 CompletionPolicy 裁决）
  assert.strictEqual(
    verificationFromOutcome({ status: 'completed', completion: null, tests: [] }),
    'NOT_VERIFIED');

  // Run D：failed 禁止简单映射为 FAIL —— 无证据时 NOT_VERIFIED
  assert.strictEqual(
    verificationFromOutcome({ status: 'failed', completion: null, tests: [] }),
    'NOT_VERIFIED');
  // failed + 真实测试失败证据 → FAIL
  assert.strictEqual(
    verificationFromOutcome({ status: 'failed', completion: null, tests: [{ passed: false }] }),
    'FAIL');

  // 状态机绝不直接映射为验证结论
  for (const status of ['completed', 'failed', 'cancelled', 'timeout', 'interrupted']) {
    const v = verificationFromOutcome({ status });
    assert.ok(
      Object.values(VERIFICATION_STATUS).includes(v),
      `${status} 的验证结论必须落在词汇表内，实际: ${v}`);
  }
  // completed 绝不可能在没有证据时给出 PASS
  assert.notStrictEqual(verificationFromOutcome({ status: 'completed' }), 'PASS');

  console.log('RUN_COMPLETED_WITH_VERIFICATION_PASS=PASS');
  console.log('RUN_COMPLETED_WITHOUT_VERIFICATION=NOT_AVAILABLE');
  console.log('RUN_COMPLETED_NOT_VERIFIED=NOT_VERIFIED');
  console.log('RUN_STATUS_NOT_USED_AS_VERIFICATION=YES');
});

test('A1 resolver: stored evidence wins, legacy rows use real test events, never run.status', () => {
  // 持久化证据优先
  assert.strictEqual(
    resolveRunVerificationStatus({ row: { status: 'completed', verification_status: 'NOT_AVAILABLE' }, testEvents: [] }),
    'NOT_AVAILABLE');
  assert.strictEqual(
    resolveRunVerificationStatus({ row: { status: 'failed', verification_status: 'FAIL' }, testEvents: [] }),
    'FAIL');

  // 非终态 → RUNNING（这是词汇表合法值，不是从 status 猜验证）
  assert.strictEqual(
    resolveRunVerificationStatus({ row: { status: 'executing_tool' }, testEvents: [] }),
    'RUNNING');

  // 历史数据：真实测试事件是机器证据
  assert.strictEqual(
    resolveRunVerificationStatus({ row: { status: 'completed' }, testEvents: [{ passed: true }, { passed: true }] }),
    'PASS');
  assert.strictEqual(
    resolveRunVerificationStatus({ row: { status: 'completed' }, testEvents: [{ passed: true }, { passed: false }] }),
    'FAIL');

  // 终态无任何证据 → NOT_VERIFIED（不猜）
  assert.strictEqual(
    resolveRunVerificationStatus({ row: { status: 'completed' }, testEvents: [] }),
    'NOT_VERIFIED');
  assert.strictEqual(resolveRunVerificationStatus({}), 'UNKNOWN');
});

test('A1 verificationFromTestEvents only accepts real evidence', () => {
  assert.strictEqual(verificationFromTestEvents([]), null);
  assert.strictEqual(verificationFromTestEvents(null), null);
  assert.strictEqual(verificationFromTestEvents([{ passed: true }]), 'PASS');
  assert.strictEqual(verificationFromTestEvents([{ passed: false }]), 'FAIL');
});

// ---------------- A2 — Effective Project Identity ----------------

function makeLineageStore({ runs, conversations }) {
  const runMap = new Map(runs.map(r => [r.id, r]));
  const convMap = new Map(conversations.map(c => [c.id, c]));
  return {
    getRun: (id) => runMap.get(id) || null,
    getConversationProject: (cid) => {
      const c = convMap.get(cid);
      return c ? (c.project_id || null) : null;
    }
  };
}

test('A2 child project identity resolves through real root lineage', () => {
  const store = makeLineageStore({
    conversations: [
      { id: 'conv-a', project_id: 'proj-a' },
      { id: 'conv-b', project_id: 'proj-b' }
    ],
    runs: [
      { id: 'main-a', conversation_id: 'conv-a', parent_run_id: null, root_run_id: 'main-a' },
      { id: 'child-a1', conversation_id: null, parent_run_id: 'main-a', root_run_id: 'main-a' },
      { id: 'grandchild-a1x', conversation_id: null, parent_run_id: 'child-a1', root_run_id: 'main-a' },
      { id: 'main-b', conversation_id: 'conv-b', parent_run_id: null, root_run_id: 'main-b' },
      { id: 'child-b1', conversation_id: null, parent_run_id: 'main-b', root_run_id: 'main-b' },
      { id: 'orphan', conversation_id: null, parent_run_id: 'missing-run', root_run_id: 'missing-root' },
      { id: 'cycle-x', conversation_id: null, parent_run_id: 'cycle-y', root_run_id: 'cycle-x' },
      { id: 'cycle-y', conversation_id: null, parent_run_id: 'cycle-x', root_run_id: 'cycle-x' }
    ]
  });

  const resolve = (runId) => resolveRunProjectId({
    run: store.getRun(runId),
    getConversationProject: store.getConversationProject,
    getRun: store.getRun
  });

  assert.strictEqual(resolve('main-a'), 'proj-a');
  assert.strictEqual(resolve('child-a1'), 'proj-a', 'Child 必须经 root lineage 解析到 Project A');
  assert.strictEqual(resolve('grandchild-a1x'), 'proj-a', '多级 Child 同样沿真实 lineage 解析');
  assert.strictEqual(resolve('main-b'), 'proj-b');
  assert.strictEqual(resolve('child-b1'), 'proj-b');

  // lineage broken → null，绝不猜
  assert.strictEqual(resolve('orphan'), null);
  // 环保护 → null
  assert.strictEqual(resolve('cycle-x'), null);
  assert.strictEqual(resolveRunProjectId({ run: null, getConversationProject: store.getConversationProject, getRun: store.getRun }), null);

  // Project A 视图过滤：只能出现 A / A1，绝不混入 B / B1
  const projectAView = ['main-a', 'child-a1', 'grandchild-a1x', 'main-b', 'child-b1', 'orphan']
    .map(id => ({ id, effectiveProjectId: resolve(id) }))
    .filter(r => r.effectiveProjectId === 'proj-a')
    .map(r => r.id);
  assert.deepStrictEqual(projectAView.sort(), ['child-a1', 'grandchild-a1x', 'main-a']);
  assert.ok(!projectAView.includes('main-b'), 'Project B 的 Run 不得混入 Project A');
  assert.ok(!projectAView.includes('child-b1'), 'Project B 的 Child 不得混入 Project A');
  assert.ok(!projectAView.includes('orphan'), '身份未知的 Run 不得混入任何项目视图');

  console.log('PROJECT_A_CHILD_FILTER=PASS');
  console.log('PROJECT_B_CHILD_EXCLUDED=YES');
  console.log('CHILD_PROJECT_FROM_ROOT_LINEAGE=YES');
});

// ---------------- A3 — Logical Event Deduplication ----------------

async function loadRunViewModel() {
  // runViewModel.js 是 Renderer ESM（import ./uiStatus.js）：复制到临时目录保持相对结构，
  // 用 .mjs 扩展名强制 ESM 语义，并把内部相对导入指到 .mjs 副本。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-runvm-'));
  const srcDir = path.join(__dirname, '..', 'public', 'js');
  fs.writeFileSync(path.join(dir, 'uiStatus.mjs'), fs.readFileSync(path.join(srcDir, 'uiStatus.js'), 'utf8'));
  const vmSource = fs.readFileSync(path.join(srcDir, 'runViewModel.js'), 'utf8')
    .replace(/from '\.\/uiStatus\.js'/g, "from './uiStatus.mjs'");
  fs.writeFileSync(path.join(dir, 'runViewModel.mjs'), vmSource);
  const mod = await import('file:///' + path.join(dir, 'runViewModel.mjs').split(path.sep).join('/'));
  return { mod, dir };
}

test('A3 logical event deduplication: same eventId once, different eventId preserved, bounded cache', async () => {
  const { mod, dir } = await loadRunViewModel();
  try {
    let renders = 0;
    mod.subscribeRunView(() => { renders += 1; });

    // 建立 run（run_state_changed 可创建节点）
    mod.ingestRunEvent({ type: 'run_state_changed', runId: 'run-1', eventId: 'e-0', status: 'preparing', timestamp: 1 });

    // case 1: 同一 JS 对象两次 → render 1 次
    const sameObject = { type: 'run_state_changed', runId: 'run-1', eventId: 'e-1', status: 'requesting_model', timestamp: 2 };
    renders = 0;
    mod.ingestRunEvent(sameObject);
    mod.ingestRunEvent(sameObject);
    assert.strictEqual(renders, 1, '同一对象重复投递只能渲染一次');

    // case 2: 两个不同对象、相同 eventId（克隆/重放）→ render 1 次
    renders = 0;
    mod.ingestRunEvent({ type: 'run_state_changed', runId: 'run-1', eventId: 'e-2', status: 'streaming', timestamp: 3 });
    mod.ingestRunEvent({ type: 'run_state_changed', runId: 'run-1', eventId: 'e-2', status: 'streaming', timestamp: 3 });
    assert.strictEqual(renders, 1, '相同 eventId 的克隆事件只能渲染一次');

    // case 3: 两个不同对象、不同 eventId、相同内容（合法两次 read_file）→ render 2 次
    renders = 0;
    const actionA = { type: 'mainAgent:action', runId: 'run-1', eventId: 'act-1', action: { type: 'read_file', args: { path: 'README.md' } }, timestamp: 4 };
    const actionB = { type: 'mainAgent:action', runId: 'run-1', eventId: 'act-2', action: { type: 'read_file', args: { path: 'README.md' } }, timestamp: 5 };
    mod.ingestRunEvent(actionA);
    mod.ingestRunEvent(actionB);
    assert.strictEqual(renders, 2, '两次真实的相同 action 必须都保留');
    const view = mod.getRunView('run-1');
    assert.strictEqual(view.actions.filter(a => a.type === 'read_file').length, 2);

    // case 4: terminal 重复 —— 相同 eventId 的 run_completed 只生效一次
    renders = 0;
    mod.ingestRunEvent({ type: 'run_completed', runId: 'run-1', eventId: 'e-term', status: 'completed', timestamp: 6 });
    mod.ingestRunEvent({ type: 'run_completed', runId: 'run-1', eventId: 'e-term', status: 'completed', timestamp: 6 });
    assert.strictEqual(renders, 1, 'terminal 事件重复投递只能渲染一次');
    assert.strictEqual(mod.getRunView('run-1').status, 'completed');

    console.log('DUPLICATE_EVENT_ID_RENDER=0');
    console.log('LEGITIMATE_IDENTICAL_ACTIONS_PRESERVED=YES');

    // case 5: bounded 缓存 —— 注入超过上限的唯一事件后缓存有界
    mod.resetRunViews();
    for (let i = 0; i < 5200; i++) {
      mod.ingestRunEvent({ type: 'mainAgent:timeline', runId: 'run-x', eventId: `bulk-${i}`, timestamp: i });
    }
    assert.ok(mod.seenEventCount() <= 5000, `去重缓存必须 bounded（<=5000），实际: ${mod.seenEventCount()}`);
    console.log('EVENT_DEDUPE_BOUNDED=YES');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- A4 — -z 格式解析（单元层） ----------------

test('A4 parseStatus honors real -z rename layout', () => {
  // git status --porcelain=v1 -z：rename 条目的原路径是紧随其后的独立 NUL 元素
  const raw = ['R  new.js', 'old.js', ' M mod.js', '?? untracked.txt', ' D gone.js', ''].join('\0');
  const rows = parseStatus(raw);
  const byPath = new Map(rows.map(r => [r.path, r]));

  assert.strictEqual(byPath.get('new.js').status, 'R');
  assert.strictEqual(byPath.get('new.js').oldPath, 'old.js');
  assert.ok(!byPath.has('old.js'), '原路径不得成为独立条目');
  assert.strictEqual(byPath.get('mod.js').status, 'M');
  assert.strictEqual(byPath.get('untracked.txt').status, 'A');
  assert.strictEqual(byPath.get('gone.js').status, 'D');

  // 带 " -> " 的合法文件名（真实两次场景）不得被旧字符串规则误拆
  const tricky = parseStatus([' M a -> b.txt', ''].join('\0'));
  assert.strictEqual(tricky[0].path, 'a -> b.txt');
});
