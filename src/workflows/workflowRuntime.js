'use strict';

const crypto = require('crypto');
const { compileWorkflow } = require('./workflowCompiler');
const { transitionStep, STEP_TERMINAL } = require('./workflowStates');
const {
  workflowError,
  boundStepOutput,
  getReference,
  resolveTemplates,
  addStepResult
} = require('./workflowContext');

const WORKFLOW_TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const NO_RETRY = new Set([
  'PERMISSION_DENIED',
  'PATH_OUTSIDE_WORKSPACE',
  'HOOK_BLOCKED',
  'WORKFLOW_DEFINITION_INVALID',
  'WORKFLOW_REFERENCE_NOT_FOUND',
  'USER_REJECTED'
]);
const RETRYABLE = new Set(['TOOL_ERROR', 'MODEL_TIMEOUT', 'AGENT_TIMEOUT']);

function now() {
  return new Date().toISOString();
}

function codeFrom(error, fallback = 'WORKFLOW_STEP_FAILED') {
  if (error && error.code) return error.code;
  const message = String(error && error.message || error || '');
  const match = message.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return match ? match[1] : fallback;
}

function createMemoryRuntimeStores() {
  const executions = new Map();
  const steps = new Map();
  const executionStore = {
    create(input) { executions.set(input.workflowRunId, structuredClone(input)); return this.get(input.workflowRunId); },
    get(id) { return executions.has(id) ? structuredClone(executions.get(id)) : null; },
    list(limit = 100) { return [...executions.values()].slice(-limit).reverse().map(value => structuredClone(value)); },
    update(id, patch) {
      if (!executions.has(id)) return null;
      executions.set(id, { ...executions.get(id), ...structuredClone(patch), updatedAt: patch.updatedAt || now() });
      return this.get(id);
    }
  };
  const stepStore = {
    create(input) {
      steps.set(input.workflowRunId + ':' + input.stepId, structuredClone(input));
      return this.get(input.workflowRunId, input.stepId);
    },
    get(runId, stepId) {
      const value = steps.get(runId + ':' + stepId);
      return value ? structuredClone(value) : null;
    },
    listByRun(runId) {
      return [...steps.values()].filter(step => step.workflowRunId === runId).map(value => structuredClone(value));
    },
    update(runId, stepId, patch) {
      const key = runId + ':' + stepId;
      if (!steps.has(key)) return null;
      steps.set(key, { ...steps.get(key), ...structuredClone(patch), updatedAt: patch.updatedAt || now() });
      return this.get(runId, stepId);
    }
  };
  return { executionStore, stepStore };
}

function createWorkflowRuntime(options = {}) {
  const memory = createMemoryRuntimeStores();
  const executionStore = options.executionStore || memory.executionStore;
  const stepStore = options.stepStore || memory.stepStore;
  const active = new Map();

  function getDefinition(input) {
    if (typeof input !== 'string') return input;
    const definition = options.registry && options.registry.get(input);
    if (!definition) throw workflowError('WORKFLOW_NOT_FOUND', input);
    if (definition.enabled === false) throw workflowError('WORKFLOW_DISABLED', input);
    const { enabled: _enabled, ...plain } = definition;
    return plain;
  }

  function getRun(workflowRunId) {
    const execution = executionStore.get(workflowRunId);
    if (!execution) return null;
    return { ...execution, steps: stepStore.listByRun(workflowRunId) };
  }

  function listRuns(limit = 100) {
    return executionStore.list(limit).map(execution => ({
      ...execution,
      steps: stepStore.listByRun(execution.workflowRunId)
    }));
  }

  function emit(type, payload) {
    try { if (typeof options.emit === 'function') options.emit(type, payload); } catch { /* audit UI cannot break runtime */ }
  }

  function audit(control, step, status, patch = {}) {
    if (!options.audit || typeof options.audit.record !== 'function') return;
    options.audit.record({
      workflowRunId: control.workflowRunId,
      workflowId: control.compiled.workflowId,
      stepId: step && step.id,
      stepType: step && step.type,
      status,
      attempt: patch.attempt || 0,
      runId: patch.runId || null,
      childRunId: patch.childRunId || null,
      errorCode: patch.errorCode || null,
      durationMs: patch.durationMs || 0,
      detail: patch.detail || {}
    });
  }

  function transition(control, step, status, patch = {}) {
    const currentRun = executionStore.get(control.workflowRunId);
    if (!currentRun) throw workflowError('WORKFLOW_RUN_NOT_FOUND', control.workflowRunId);
    if (WORKFLOW_TERMINAL.has(currentRun.status) && status !== 'CANCELLED') {
      return stepStore.get(control.workflowRunId, step.id);
    }
    const result = transitionStep(stepStore, control.workflowRunId, step.id, status, {
      ...patch,
      updatedAt: now()
    });
    emit('workflow:step', { workflowRunId: control.workflowRunId, step: result });
    return result;
  }

  function markRemaining(control, status) {
    for (const step of control.compiled.steps) {
      const current = stepStore.get(control.workflowRunId, step.id);
      if (current && !STEP_TERMINAL.has(current.status)) {
        try { transition(control, step, status, { terminalAt: now() }); } catch { /* terminal gate */ }
      }
    }
  }

  function terminalWorkflow(control, status, patch = {}) {
    const current = executionStore.get(control.workflowRunId);
    if (!current || WORKFLOW_TERMINAL.has(current.status)) return current;
    const result = executionStore.update(control.workflowRunId, {
      ...patch,
      status,
      currentStepId: null,
      terminalAt: now(),
      updatedAt: now()
    });
    emit('workflow:state', result);
    return result;
  }

  async function run(workflow, runOptions = {}) {
    const compiled = compileWorkflow(getDefinition(workflow));
    const workflowRunId = runOptions.workflowRunId || crypto.randomUUID();
    const input = boundStepOutput(runOptions.input || {});
    const execution = executionStore.create({
      workflowRunId,
      workflowId: compiled.workflowId,
      status: 'RUNNING',
      projectId: runOptions.projectId || null,
      projectRoot: runOptions.projectRoot || null,
      conversationId: runOptions.conversationId || null,
      currentStepId: null,
      input,
      output: {},
      errorCode: null,
      error: null,
      startedAt: now(),
      updatedAt: now(),
      terminalAt: null
    });
    for (const step of compiled.steps) {
      stepStore.create({
        workflowRunId,
        stepId: step.id,
        stepType: step.type,
        status: 'PENDING',
        attempt: 0,
        runId: null,
        childRunId: null,
        startedAt: null,
        updatedAt: now(),
        terminalAt: null,
        result: {},
        errorCode: null,
        error: null
      });
    }
    const control = {
      workflowRunId,
      compiled,
      runOptions,
      context: { input, steps: {} },
      abortController: new AbortController(),
      cancelled: false,
      activeAgentRunId: null,
      activeDynamicInstanceId: null,
      approval: null,
      permissionEngine: runOptions.permissionEngine ||
        (typeof options.createPermissionEngine === 'function'
          ? options.createPermissionEngine({ projectId: runOptions.projectId || null })
          : null),
      promise: null
    };
    active.set(workflowRunId, control);
    audit(control, null, 'RUNNING');
    control.promise = executeWorkflow(control).finally(() => {
      if (!control.approval) active.delete(workflowRunId);
    });
    emit('workflow:state', execution);
    return execution;
  }

  async function wait(workflowRunId) {
    const control = active.get(workflowRunId);
    if (control && control.promise) await control.promise;
    return getRun(workflowRunId);
  }

  async function executeWorkflow(control) {
    const timer = setTimeout(() => {
      if (!control.cancelled) cancel(control.workflowRunId, {
        status: 'FAILED',
        errorCode: 'WORKFLOW_TIMEOUT',
        error: 'workflow maximum runtime exceeded'
      }).catch(() => {});
    }, control.compiled.definition.limits.maxRuntimeMs);
    try {
      for (const step of control.compiled.steps) {
        if (control.cancelled || WORKFLOW_TERMINAL.has(executionStore.get(control.workflowRunId).status)) break;
        transition(control, step, 'READY');
        executionStore.update(control.workflowRunId, {
          currentStepId: step.id,
          status: 'RUNNING',
          updatedAt: now()
        });
        const outcome = await runStepWithRetry(control, step);
        if (control.cancelled) break;
        if (!outcome.ok && step.onFailure === 'fail') {
          markRemaining(control, 'SKIPPED');
          terminalWorkflow(control, 'FAILED', {
            errorCode: outcome.errorCode,
            error: outcome.error
          });
          audit(control, step, 'FAILED', outcome);
          return getRun(control.workflowRunId);
        }
      }
      if (!WORKFLOW_TERMINAL.has(executionStore.get(control.workflowRunId).status)) {
        const output = resolveTemplates(control.compiled.definition.outputs, control.context);
        terminalWorkflow(control, 'COMPLETED', { output: boundStepOutput(output) });
        audit(control, null, 'COMPLETED');
      }
      return getRun(control.workflowRunId);
    } catch (error) {
      if (!control.cancelled && !WORKFLOW_TERMINAL.has(executionStore.get(control.workflowRunId).status)) {
        markRemaining(control, 'SKIPPED');
        terminalWorkflow(control, 'FAILED', {
          errorCode: codeFrom(error),
          error: error.message
        });
        audit(control, null, 'FAILED', { errorCode: codeFrom(error) });
      }
      return getRun(control.workflowRunId);
    } finally {
      clearTimeout(timer);
    }
  }

  function shouldRetry(errorCode) {
    if (NO_RETRY.has(errorCode)) return false;
    return RETRYABLE.has(errorCode);
  }

  async function runStepWithRetry(control, step) {
    let last = null;
    for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt++) {
      if (control.cancelled) return { ok: false, errorCode: 'WORKFLOW_CANCELLED', error: 'cancelled' };
      const startedAt = Date.now();
      transition(control, step, 'RUNNING', {
        attempt,
        startedAt: now(),
        errorCode: null,
        error: null
      });
      try {
        const value = await withStepTimeout(control, step, executeStep(control, step));
        if (control.cancelled || WORKFLOW_TERMINAL.has(executionStore.get(control.workflowRunId).status)) {
          return { ok: false, errorCode: 'WORKFLOW_CANCELLED', error: 'cancelled' };
        }
        const rawOutput = value.output === undefined ? value : value.output;
        const output = boundStepOutput(step.config.resultKey
          ? { [step.config.resultKey]: rawOutput }
          : rawOutput);
        control.context = addStepResult(control.context, step.id, 'completed', output);
        const record = transition(control, step, 'COMPLETED', {
          attempt,
          runId: value.runId || null,
          childRunId: value.childRunId || null,
          result: output,
          terminalAt: now()
        });
        audit(control, step, 'COMPLETED', {
          attempt,
          runId: record.runId,
          childRunId: record.childRunId,
          durationMs: Date.now() - startedAt
        });
        return { ok: true, output, runId: record.runId, childRunId: record.childRunId };
      } catch (error) {
        const errorCode = codeFrom(error);
        last = { ok: false, errorCode, error: error.message, attempt };
        if (attempt < step.retry.maxAttempts && shouldRetry(errorCode)) {
          audit(control, step, 'RETRY', {
            attempt,
            errorCode,
            durationMs: Date.now() - startedAt
          });
          continue;
        }
        if (!control.cancelled) {
          control.context = addStepResult(control.context, step.id, 'failed', {
            errorCode,
            error: String(error.message || error).slice(0, 1000)
          });
          transition(control, step, 'FAILED', {
            attempt,
            errorCode,
            error: String(error.message || error).slice(0, 1000),
            terminalAt: now()
          });
          audit(control, step, 'FAILED', {
            attempt,
            errorCode,
            durationMs: Date.now() - startedAt
          });
        }
        return last;
      }
    }
    return last;
  }

  async function withStepTimeout(control, step, promise) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(async () => {
            if (control.activeAgentRunId && options.agentHub) {
              try { await options.agentHub.cancel(control.activeAgentRunId); } catch { /* best effort */ }
            }
            reject(workflowError(step.type === 'agent' ? 'AGENT_TIMEOUT' : 'TOOL_ERROR', 'step timeout'));
          }, step.timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function executeStep(control, step) {
    if (options.executors && typeof options.executors[step.type] === 'function') {
      return options.executors[step.type]({
        step,
        config: resolveTemplates(step.config, control.context),
        context: structuredClone(control.context),
        signal: control.abortController.signal,
        workflowRunId: control.workflowRunId,
        control
      });
    }
    if (step.type === 'agent') return executeAgentStep(control, step);
    if (step.type === 'tool') return executeToolStep(control, step);
    if (step.type === 'condition') return executeConditionStep(control, step);
    if (step.type === 'approval') return executeApprovalStep(control, step);
    throw workflowError('WORKFLOW_DEFINITION_INVALID', 'unknown step type');
  }

  async function executeAgentStep(control, step) {
    const config = resolveTemplates(step.config, control.context);
    const hub = options.agentHub;
    if (!hub) throw workflowError('AGENT_RUNTIME_UNAVAILABLE', 'AgentHub is required');
    const target = config.target || { mode: 'main' };
    const task = {
      goal: config.goal,
      projectRoot: control.runOptions.projectRoot,
      projectId: control.runOptions.projectId,
      conversationId: control.runOptions.conversationId,
      timeoutMs: step.timeoutMs,
      skillIds: config.skillIds || [],
      hookIds: config.hookIds || [],
      abortSignal: control.abortController.signal,
      readOnly: config.readOnly === true
    };
    let start;
    let dynamicInstance = null;
    if (target.mode === 'dynamic') {
      if (!options.dynamicAgentFactory || !options.agentDefinitionStore) {
        throw workflowError('DYNAMIC_AGENT_RUNTIME_UNAVAILABLE', 'Dynamic AgentFactory is required');
      }
      const stored = options.agentDefinitionStore.get(target.agentDefinitionId);
      if (!stored) throw workflowError('AGENT_DEFINITION_NOT_FOUND', target.agentDefinitionId);
      const definition = structuredClone(stored);
      definition.skills = definition.skills || { required: [], optional: [] };
      definition.hooks = definition.hooks || { required: [], optional: [] };
      definition.skills.required = [...new Set([...(definition.skills.required || []), ...(config.skillIds || [])])];
      definition.hooks.required = [...new Set([...(definition.hooks.required || []), ...(config.hookIds || [])])];
      dynamicInstance = options.dynamicAgentFactory.createInstance(definition, {
        parentPermissionEngine: control.permissionEngine,
        projectContext: {
          projectRoot: control.runOptions.projectRoot,
          projectId: control.runOptions.projectId
        },
        getTool: options.getTool,
        emit: options.emit
      });
      options.dynamicAgentFactory.registerInstance(dynamicInstance.instanceId, hub);
      control.activeDynamicInstanceId = dynamicInstance.instanceId;
      start = await hub.start(dynamicInstance.adapterId, task);
    } else if (target.mode === 'hub') {
      start = target.agentId ? await hub.start(target.agentId, task) : await hub.startAuto(task);
    } else {
      start = await hub.start('native-main', task);
    }
    if (!start || !start.runId || start.error) {
      if (dynamicInstance) await options.dynamicAgentFactory.disposeInstance(dynamicInstance.instanceId);
      throw workflowError(start && start.errorCode || 'AGENT_START_FAILED', start && start.error || 'agent start failed');
    }
    const actualRunId = start.runId;
    control.activeAgentRunId = actualRunId;
    const stepRecord = stepStore.get(control.workflowRunId, step.id);
    stepStore.update(control.workflowRunId, step.id, {
      runId: target.mode === 'dynamic' ? null : actualRunId,
      childRunId: target.mode === 'dynamic' ? actualRunId : null
    });
    try {
      const result = await waitForAgent(control, actualRunId);
      const status = String(result && result.status || '').toLowerCase();
      if (!['completed', 'complete'].includes(status)) {
        throw workflowError(codeFrom(result && (result.error || result.result), 'AGENT_FAILED'),
          String(result && (result.error || result.result) || 'agent failed'));
      }
      return {
        runId: target.mode === 'dynamic' ? null : actualRunId,
        childRunId: target.mode === 'dynamic' ? actualRunId : null,
        output: {
          status: 'completed',
          summary: result && result.result && result.result.summary
            ? result.result.summary
            : (result && result.result) || ''
        }
      };
    } finally {
      control.activeAgentRunId = null;
      if (dynamicInstance) {
        await options.dynamicAgentFactory.disposeInstance(dynamicInstance.instanceId);
        control.activeDynamicInstanceId = null;
      }
      if (stepRecord && control.cancelled) {
        stepStore.update(control.workflowRunId, step.id, { status: 'CANCELLED', terminalAt: now() });
      }
    }
  }

  async function waitForAgent(control, runId) {
    for (;;) {
      if (control.cancelled) throw workflowError('WORKFLOW_CANCELLED', 'workflow cancelled');
      const status = await options.agentHub.status(runId);
      const normalized = String(status && status.status || '').toLowerCase();
      if (['completed', 'failed', 'cancelled', 'timeout'].includes(normalized)) {
        return options.agentHub.result(runId);
      }
      await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs || 10));
    }
  }

  function latestAgentRunId(control) {
    let linked = control.runOptions.parentRunId || null;
    for (const step of control.compiled.steps) {
      const record = stepStore.get(control.workflowRunId, step.id);
      if (record && (record.runId || record.childRunId)) linked = record.runId || record.childRunId;
    }
    return linked;
  }

  async function executeToolStep(control, step) {
    const config = resolveTemplates(step.config, control.context);
    const { executeTool } = require('../agent/runtime/actionExecutor');
    if (typeof options.getTool !== 'function') throw workflowError('TOOL_RUNTIME_UNAVAILABLE', 'Tool Registry is required');
    let hookIds = [];
    if (config.hookIds && config.hookIds.length) {
      if (!options.hookEngine || !options.hookEngine.resolver) {
        throw workflowError('HOOK_ENGINE_UNAVAILABLE', 'Hook Engine is required');
      }
      const selection = options.hookEngine.resolver.resolveSelection({ hookIds: config.hookIds });
      if (!selection.ok) throw workflowError(selection.errorCode, selection.error);
      hookIds = selection.hookIds;
    }
    const runId = latestAgentRunId(control);
    const ctx = {
      runId,
      rootRunId: runId,
      parentRunId: null,
      workflowRunId: control.workflowRunId,
      workflowStepId: step.id,
      projectRoot: control.runOptions.projectRoot,
      projectId: control.runOptions.projectId,
      conversationId: control.runOptions.conversationId,
      taskId: null,
      agentId: 'workflow-tool',
      agentType: 'workflow',
      skillIds: [],
      hookIds,
      hookEngine: options.hookEngine || null,
      permissionEngine: control.permissionEngine,
      requestPermission: control.runOptions.requestPermission || null,
      pathSecurity: options.pathSecurity || null,
      abortSignal: control.abortController.signal,
      store: options.store || null,
      emit: options.emit
    };
    const tool = options.getTool(config.toolName);
    if (!tool) throw workflowError('TOOL_NOT_FOUND', config.toolName);
    let lockHolder = null;
    if (options.projectLock && control.runOptions.projectRoot) {
      lockHolder = control.workflowRunId + ':' + step.id;
      const permission = tool.permissionFor ? tool.permissionFor(config.args) : tool.permission;
      const mutating = /write|terminal/i.test(String(permission || '')) ||
        ['write_file', 'create_file', 'apply_patch', 'delete_file', 'terminal_run'].includes(config.toolName);
      const lock = mutating
        ? options.projectLock.acquireWrite(control.runOptions.projectRoot, lockHolder, 'workflow')
        : options.projectLock.acquireRead(control.runOptions.projectRoot, lockHolder, 'workflow');
      if (!lock.ok) throw workflowError('PROJECT_LOCKED', 'project is locked');
    }
    try {
      const result = await executeTool(ctx, config.toolName, config.args, options.getTool);
      if (!result.ok) {
        const error = result.error || {};
        throw workflowError(error.code || 'TOOL_ERROR', error.message || 'tool failed');
      }
      return { output: result };
    } finally {
      if (lockHolder && options.projectLock) {
        try { options.projectLock.release(lockHolder); } catch { /* best effort */ }
      }
    }
  }

  async function executeConditionStep(control, step) {
    const config = resolveTemplates(step.config, control.context);
    let value;
    try { value = getReference(control.context, config.source); }
    catch (error) { throw error; }
    let result;
    if (config.operator === 'eq') result = value === config.value;
    else if (config.operator === 'neq') result = value !== config.value;
    else if (config.operator === 'exists') result = value !== undefined && value !== null;
    else if (config.operator === 'truthy') result = !!value;
    else if (config.operator === 'falsy') result = !value;
    else throw workflowError('WORKFLOW_DEFINITION_INVALID', 'unknown condition operator');
    return { output: { result, value } };
  }

  async function executeApprovalStep(control, step) {
    const config = resolveTemplates(step.config, control.context);
    transition(control, step, 'WAITING_APPROVAL');
    executionStore.update(control.workflowRunId, {
      status: 'WAITING_APPROVAL',
      currentStepId: step.id,
      updatedAt: now()
    });
    emit('workflow:approval', {
      workflowRunId: control.workflowRunId,
      stepId: step.id,
      message: config.message
    });
    const decision = await new Promise(resolve => {
      control.approval = { stepId: step.id, resolve };
    });
    control.approval = null;
    if (decision.cancelled) throw workflowError('WORKFLOW_CANCELLED', 'workflow cancelled');
    if (!decision.approved) throw workflowError('USER_REJECTED', 'workflow approval rejected');
    transition(control, step, 'RUNNING');
    executionStore.update(control.workflowRunId, { status: 'RUNNING', updatedAt: now() });
    return { output: { approved: true } };
  }

  async function approve(workflowRunId) {
    const control = active.get(workflowRunId);
    if (!control || !control.approval) throw workflowError('WORKFLOW_NOT_WAITING_APPROVAL', workflowRunId);
    control.approval.resolve({ approved: true });
    return getRun(workflowRunId);
  }

  async function reject(workflowRunId) {
    const control = active.get(workflowRunId);
    if (!control || !control.approval) throw workflowError('WORKFLOW_NOT_WAITING_APPROVAL', workflowRunId);
    control.approval.resolve({ approved: false });
    return getRun(workflowRunId);
  }

  async function cancel(workflowRunId, override = {}) {
    const execution = executionStore.get(workflowRunId);
    if (!execution) throw workflowError('WORKFLOW_RUN_NOT_FOUND', workflowRunId);
    if (WORKFLOW_TERMINAL.has(execution.status)) return getRun(workflowRunId);
    const control = active.get(workflowRunId);
    if (control) {
      control.cancelled = true;
      control.abortController.abort();
      if (control.activeAgentRunId && options.agentHub) {
        try { await options.agentHub.cancel(control.activeAgentRunId); } catch { /* best effort */ }
      }
      if (control.approval) control.approval.resolve({ approved: false, cancelled: true });
      markRemaining(control, 'CANCELLED');
      terminalWorkflow(control, override.status || 'CANCELLED', {
        errorCode: override.errorCode || null,
        error: override.error || null
      });
      audit(control, null, override.status || 'CANCELLED', { errorCode: override.errorCode || null });
    } else {
      executionStore.update(workflowRunId, {
        status: override.status || 'CANCELLED',
        errorCode: override.errorCode || null,
        error: override.error || null,
        currentStepId: null,
        terminalAt: now(),
        updatedAt: now()
      });
    }
    return getRun(workflowRunId);
  }

  return { run, wait, getRun, listRuns, cancel, approve, reject, active };
}

module.exports = {
  WORKFLOW_TERMINAL,
  NO_RETRY,
  RETRYABLE,
  codeFrom,
  createMemoryRuntimeStores,
  createWorkflowRuntime
};
