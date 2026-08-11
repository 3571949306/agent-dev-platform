'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/db/store');
const {
  normalizeWorkflowDefinition,
  compileWorkflow,
  createWorkflowRegistry,
  createWorkflowEngine,
  createWorkflowAudit,
  resolveTemplates,
  boundStepOutput,
  MAX_STEP_OUTPUT_BYTES,
  MAX_CONTEXT_BYTES
} = require('../src/workflows');

const ref = pathValue => '$' + '{' + pathValue + '}';

function definition(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'workflow-a',
    name: 'Workflow A',
    description: 'fixture',
    inputs: {},
    steps: [
      {
        id: 'inspect',
        type: 'agent',
        dependsOn: [],
        config: { goal: 'Inspect ' + ref('input.target'), target: { mode: 'main' }, skillIds: [], hookIds: [] },
        timeoutMs: 1000,
        retry: { maxAttempts: 1 },
        onFailure: 'fail'
      }
    ],
    outputs: { summary: ref('steps.inspect.output.summary') },
    limits: { maxSteps: 32, maxRuntimeMs: 10000 },
    metadata: {},
    ...overrides
  };
}

async function waitFor(runtime, workflowRunId, status) {
  for (let i = 0; i < 300; i++) {
    const run = runtime.getRun(workflowRunId);
    if (run && run.status === status) return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return runtime.getRun(workflowRunId);
}

test('R1 WorkflowDefinition is strict, versioned, JSON-only, and validates the DAG', () => {
  assert.strictEqual(normalizeWorkflowDefinition(definition()).schemaVersion, 1);
  const invalid = [
    definition({ schemaVersion: 2 }),
    definition({ steps: [{ id: 'x', type: 'unknown', config: {} }] }),
    definition({ steps: [
      { id: 'x', type: 'condition', config: { source: 'input.x', operator: 'truthy' } },
      { id: 'x', type: 'condition', config: { source: 'input.x', operator: 'truthy' } }
    ] }),
    definition({ steps: [{ id: 'x', type: 'condition', dependsOn: ['missing'], config: { source: 'input.x', operator: 'truthy' } }] }),
    definition({ steps: [{ id: 'x', type: 'condition', dependsOn: ['x'], config: { source: 'input.x', operator: 'truthy' } }] }),
    definition({ steps: [
      { id: 'a', type: 'condition', dependsOn: ['b'], config: { source: 'input.x', operator: 'truthy' } },
      { id: 'b', type: 'condition', dependsOn: ['a'], config: { source: 'input.x', operator: 'truthy' } }
    ] }),
    definition({ metadata: { apiKey: 'fixture-secret-sentinel' } }),
    definition({ metadata: { note: 'sk-fixture-secret-sentinel' } }),
    definition({ metadata: { permissionEngine: {} } }),
    definition({ metadata: { script: 'return process.env' } }),
    definition({ steps: [{ id: 'x', type: 'agent', config: { goal: 'x', permissions: ['filesystem.write'] } }] }),
    definition({ metadata: { callback() {} } }),
    definition({ steps: Array.from({ length: 33 }, (_, i) => ({
      id: 's' + i, type: 'condition', config: { source: 'input.x', operator: 'truthy' }
    })) })
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeWorkflowDefinition(input), error => error.code === 'WORKFLOW_DEFINITION_INVALID');
  }
});

test('R2 WorkflowRegistry CRUD persists definitions and no runtime objects survive restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-workflow-registry-'));
  store.init(root);
  const first = createWorkflowRegistry({ store: store.workflowDefinitions });
  first.create(definition());
  first.disable('workflow-a');
  assert.strictEqual(first.get('workflow-a').enabled, false);
  store.init(root);
  const second = createWorkflowRegistry({ store: store.workflowDefinitions });
  const restored = second.get('workflow-a');
  assert.strictEqual(restored.name, 'Workflow A');
  assert.strictEqual(restored.enabled, false);
  assert.strictEqual(JSON.stringify(restored).includes('permissionEngine'), false);
  assert.strictEqual(JSON.stringify(restored).includes('abortController'), false);
  second.enable('workflow-a');
  second.update('workflow-a', { description: 'updated' });
  assert.strictEqual(second.get('workflow-a').description, 'updated');
  assert.strictEqual(second.remove('workflow-a'), true);
});

test('R3 compiler is stable by topological level then stepId ASC x100 and shuffle x100', () => {
  const steps = [
    { id: 'root', type: 'condition', config: { source: 'input.ok', operator: 'truthy' } },
    { id: 'zeta', type: 'condition', dependsOn: ['root'], config: { source: 'input.ok', operator: 'truthy' } },
    { id: 'alpha', type: 'condition', dependsOn: ['root'], config: { source: 'input.ok', operator: 'truthy' } },
    { id: 'final', type: 'condition', dependsOn: ['alpha', 'zeta'], config: { source: 'input.ok', operator: 'truthy' } }
  ];
  const expected = ['root', 'alpha', 'zeta', 'final'];
  for (let i = 0; i < 100; i++) {
    assert.deepStrictEqual(compileWorkflow(definition({ steps })).order, expected);
  }
  for (let i = 0; i < 100; i++) {
    const shuffled = steps.slice().sort(() => Math.random() - 0.5);
    assert.deepStrictEqual(compileWorkflow(definition({ steps: shuffled })).order, expected);
  }
});

test('R5 references fail closed and step/context bounds are enforced', () => {
  assert.deepStrictEqual(
    resolveTemplates({ value: ref('steps.a.output.value') }, {
      input: {},
      steps: { a: { status: 'completed', output: { value: 7 } } }
    }),
    { value: 7 }
  );
  assert.throws(
    () => resolveTemplates(ref('steps.missing.output.value'), { input: {}, steps: {} }),
    error => error.code === 'WORKFLOW_REFERENCE_NOT_FOUND'
  );
  const bounded = boundStepOutput({ value: 'x'.repeat(MAX_STEP_OUTPUT_BYTES * 2) });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MAX_STEP_OUTPUT_BYTES);
  assert.ok(String(bounded.value || bounded.preview).length <= 1000);
  assert.strictEqual(MAX_CONTEXT_BYTES, 256 * 1024);
});

test('R5 missing runtime reference fails closed before a step executor is called', async () => {
  let calls = 0;
  const engine = createWorkflowEngine({
    executors: { tool: async () => { calls++; return { output: {} }; } }
  });
  engine.registry.create(definition({
    steps: [{
      id: 'missing',
      type: 'tool',
      config: { toolName: 'fixture', args: { value: ref('steps.never.output.value') } }
    }],
    outputs: {}
  }));
  const started = await engine.runtime.run('workflow-a');
  const run = await engine.runtime.wait(started.workflowRunId);
  assert.strictEqual(run.status, 'FAILED');
  assert.strictEqual(run.errorCode, 'WORKFLOW_REFERENCE_NOT_FOUND');
  assert.strictEqual(calls, 0);
});

test('R4/R7 WorkflowExecution, StepExecution, and sanitized audit persist independently of Agent Runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-workflow-execution-'));
  store.init(root);
  const engine = createWorkflowEngine({
    definitionStore: store.workflowDefinitions,
    executionStore: store.workflowExecutions,
    stepStore: store.workflowStepExecutions,
    auditStore: store.workflowAudit,
    executors: {
      condition: async () => ({ output: { result: true } })
    }
  });
  engine.registry.create(definition({
    steps: [{ id: 'check', type: 'condition', config: { source: 'input.ok', operator: 'truthy' } }],
    outputs: { result: ref('steps.check.output.result') }
  }));
  const started = await engine.runtime.run('workflow-a', { input: { ok: true } });
  const completed = await engine.runtime.wait(started.workflowRunId);
  assert.strictEqual(completed.status, 'COMPLETED');
  store.init(root);
  const restored = store.workflowExecutions.get(started.workflowRunId);
  const restoredSteps = store.workflowStepExecutions.listByRun(started.workflowRunId);
  assert.strictEqual(restored.status, 'COMPLETED');
  assert.strictEqual(restoredSteps[0].status, 'COMPLETED');
  assert.strictEqual(restoredSteps[0].runId, null);

  const audit = createWorkflowAudit({ store: store.workflowAudit });
  audit.record({
    workflowRunId: started.workflowRunId,
    workflowId: 'workflow-a',
    stepId: 'check',
    stepType: 'condition',
    status: 'COMPLETED',
    attempt: 1,
    durationMs: 2,
    detail: {
      nested: { Authorization: 'Bearer fixture-value', fileContent: 'private source' },
      note: 'sk-123456789'
    }
  });
  const rows = store.workflowAudit.listByRun(started.workflowRunId);
  const json = JSON.stringify(rows);
  assert.ok(rows.length >= 2);
  assert.doesNotMatch(json, /Bearer fixture-value|private source|sk-123456789/);
});

test('R3/R5 serial runtime executes agent, tool, condition, and approval without starting the next step early', async () => {
  const calls = [];
  const engine = createWorkflowEngine({
    executors: {
      agent: async ({ config }) => {
        calls.push('agent');
        return { runId: 'real-agent-run', output: { summary: config.goal, status: 'completed' } };
      },
      tool: async ({ config }) => {
        calls.push('tool');
        return { output: { value: config.args.value } };
      },
      condition: async ({ config, context }) => {
        calls.push('condition');
        return { output: { result: context.steps.tool.output.toolResult.value === config.value } };
      }
    }
  });
  const workflow = definition({
    steps: [
      { id: 'agent', type: 'agent', config: { goal: 'Review ' + ref('input.name'), target: { mode: 'main' } } },
      { id: 'tool', type: 'tool', dependsOn: ['agent'], config: { toolName: 'fixture', args: { value: ref('input.value') }, resultKey: 'toolResult' } },
      { id: 'condition', type: 'condition', dependsOn: ['tool'], config: { source: 'steps.tool.output.toolResult.value', operator: 'eq', value: 7 } },
      { id: 'approval', type: 'approval', dependsOn: ['condition'], config: { message: 'Continue?' } },
      { id: 'after', type: 'tool', dependsOn: ['approval'], config: { toolName: 'fixture', args: { value: 9 } } }
    ],
    outputs: { approved: ref('steps.approval.output.approved'), final: ref('steps.after.output.value') }
  });
  engine.registry.create(workflow);
  const started = await engine.runtime.run('workflow-a', { input: { name: 'repo', value: 7 } });
  const waiting = await waitFor(engine.runtime, started.workflowRunId, 'WAITING_APPROVAL');
  assert.strictEqual(waiting.status, 'WAITING_APPROVAL');
  assert.deepStrictEqual(calls, ['agent', 'tool', 'condition']);
  assert.strictEqual(waiting.steps.find(step => step.stepId === 'after').status, 'PENDING');
  await engine.runtime.approve(started.workflowRunId);
  const completed = await engine.runtime.wait(started.workflowRunId);
  assert.strictEqual(completed.status, 'COMPLETED');
  assert.deepStrictEqual(completed.output, { approved: true, final: 9 });
  assert.deepStrictEqual(calls, ['agent', 'tool', 'condition', 'tool']);
});

test('R7 transient errors retry within maxAttempts while permission denial never retries', async () => {
  let transient = 0;
  let denied = 0;
  const transientEngine = createWorkflowEngine({
    executors: {
      tool: async () => {
        transient++;
        if (transient === 1) {
          const error = new Error('transient');
          error.code = 'TOOL_ERROR';
          throw error;
        }
        return { output: { ok: true } };
      }
    }
  });
  transientEngine.registry.create(definition({
    steps: [{ id: 'retry', type: 'tool', config: { toolName: 'fixture', args: {} }, retry: { maxAttempts: 2 } }],
    outputs: {}
  }));
  const transientRun = await transientEngine.runtime.run('workflow-a');
  assert.strictEqual((await transientEngine.runtime.wait(transientRun.workflowRunId)).status, 'COMPLETED');
  assert.strictEqual(transient, 2);

  const deniedEngine = createWorkflowEngine({
    executors: {
      tool: async () => {
        denied++;
        const error = new Error('denied');
        error.code = 'PERMISSION_DENIED';
        throw error;
      }
    }
  });
  deniedEngine.registry.create(definition({
    steps: [{ id: 'denied', type: 'tool', config: { toolName: 'fixture', args: {} }, retry: { maxAttempts: 3 } }],
    outputs: {}
  }));
  const deniedRun = await deniedEngine.runtime.run('workflow-a');
  const failed = await deniedEngine.runtime.wait(deniedRun.workflowRunId);
  assert.strictEqual(failed.status, 'FAILED');
  assert.strictEqual(failed.errorCode, 'PERMISSION_DENIED');
  assert.strictEqual(denied, 1);
});

test('R7 onFailure continue preserves FAILED truth and allows dependent work to continue', async () => {
  const engine = createWorkflowEngine({
    executors: {
      tool: async ({ step }) => {
        if (step.id === 'bad') {
          const error = new Error('fixture failure');
          error.code = 'TOOL_ERROR';
          throw error;
        }
        return { output: { continued: true } };
      }
    }
  });
  engine.registry.create(definition({
    steps: [
      { id: 'bad', type: 'tool', config: { toolName: 'fixture', args: {} }, onFailure: 'continue' },
      { id: 'next', type: 'tool', dependsOn: ['bad'], config: { toolName: 'fixture', args: {} } }
    ],
    outputs: { continued: ref('steps.next.output.continued') }
  }));
  const started = await engine.runtime.run('workflow-a');
  const run = await engine.runtime.wait(started.workflowRunId);
  assert.strictEqual(run.status, 'COMPLETED');
  assert.strictEqual(run.steps.find(step => step.stepId === 'bad').status, 'FAILED');
  assert.strictEqual(run.output.continued, true);
});

test('R7 cancellation aborts active work, starts zero pending steps, and late result cannot revive workflow', async () => {
  let resolveAgent;
  let pendingStarts = 0;
  const engine = createWorkflowEngine({
    executors: {
      agent: async () => new Promise(resolve => { resolveAgent = resolve; }),
      tool: async () => { pendingStarts++; return { output: {} }; }
    }
  });
  engine.registry.create(definition({
    steps: [
      { id: 'long', type: 'agent', config: { goal: 'Long', target: { mode: 'main' } } },
      { id: 'never', type: 'tool', dependsOn: ['long'], config: { toolName: 'fixture', args: {} } }
    ],
    outputs: {}
  }));
  const started = await engine.runtime.run('workflow-a');
  await new Promise(resolve => setTimeout(resolve, 10));
  await engine.runtime.cancel(started.workflowRunId);
  resolveAgent({ runId: 'late-real-run', output: { late: true } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const run = engine.runtime.getRun(started.workflowRunId);
  assert.strictEqual(run.status, 'CANCELLED');
  assert.strictEqual(pendingStarts, 0);
  assert.strictEqual(run.steps.find(step => step.stepId === 'never').status, 'CANCELLED');
});

test('R7 approval rejection is USER_REJECTED and later steps never start', async () => {
  let calls = 0;
  const engine = createWorkflowEngine({ executors: { tool: async () => { calls++; return { output: {} }; } } });
  engine.registry.create(definition({
    steps: [
      { id: 'approval', type: 'approval', config: { message: 'Approve?' } },
      { id: 'never', type: 'tool', dependsOn: ['approval'], config: { toolName: 'fixture', args: {} } }
    ],
    outputs: {}
  }));
  const started = await engine.runtime.run('workflow-a');
  await waitFor(engine.runtime, started.workflowRunId, 'WAITING_APPROVAL');
  await engine.runtime.reject(started.workflowRunId);
  const run = await engine.runtime.wait(started.workflowRunId);
  assert.strictEqual(run.status, 'FAILED');
  assert.strictEqual(run.errorCode, 'USER_REJECTED');
  assert.strictEqual(calls, 0);
});
