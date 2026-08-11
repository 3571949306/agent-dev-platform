'use strict';

const { NativeAgentAdapter } = require('../adapters/nativeAgentAdapter');
const { DynamicPermissionEngine } = require('./permissionPolicy');

const MUTATION_TOOLS = new Set([
  'write_file', 'apply_patch', 'patch_file', 'create_file', 'delete_file',
  'terminal_run', 'run_command', 'run_tests'
]);
const TOOL_ALIASES = Object.freeze({
  patch_file: 'apply_patch',
  run_command: 'terminal_run',
  run_tests: 'terminal_run'
});
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout', 'interrupted']);

function actualToolNames(names) {
  const values = new Set();
  for (const name of names || []) {
    values.add(name);
    if (TOOL_ALIASES[name]) values.add(TOOL_ALIASES[name]);
  }
  return values;
}

class DynamicNativeAgentAdapter extends NativeAgentAdapter {
  constructor(options) {
    const definition = options.definition;
    const adapterId = options.adapterId;
    const capabilities = Object.fromEntries((definition.capabilities || []).map(name => [name, true]));
    super({
      manifest: {
        id: adapterId,
        displayName: definition.name,
        source: 'dynamic',
        transport: 'native',
        capabilities,
        availability: true,
        version: '1',
        path: null,
        maxConcurrency: 1
      },
      runMainAgentFn: options.runMainAgentFn,
      emit: options.emit
    });
    this.dynamicAgent = true;
    this.definition = definition;
    this.instanceId = options.instanceId;
    this.rootRunId = options.rootRunId;
    this.modelAdapter = options.modelAdapter;
    this._baseGetTool = options.getTool;
    this._parentPermissionEngine = options.parentPermissionEngine || null;
    this._onState = typeof options.onState === 'function' ? options.onState : () => {};
    this._hubRuns = new Map();
    this._monitors = new Map();
    this._allowedTools = actualToolNames(definition.toolPolicy.allow);
    this._deniedTools = actualToolNames(definition.toolPolicy.deny);
  }

  getTool(name) {
    if (!this._allowedTools.has(name) || this._deniedTools.has(name)) return null;
    if (this.definition.permissionPolicy.readOnly && MUTATION_TOOLS.has(name)) return null;
    const tool = typeof this._baseGetTool === 'function' ? this._baseGetTool(name) : null;
    if (!tool) return null;
    const scope = tool.permission || null;
    if (scope && this._parentPermissionEngine && this._parentPermissionEngine.evaluate(scope, {}) !== 'allow') return null;
    return tool;
  }

  async startTask(task, context = {}) {
    const hubRunId = context.runId;
    const permissionEngine = new DynamicPermissionEngine({
      policy: this.definition.permissionPolicy,
      parent: this._parentPermissionEngine || context.permissionEngine || null
    });
    const scopedContext = Object.assign({}, context, {
      conversationId: `dynamic-${hubRunId}`,
      model: this.modelAdapter,
      modelAdapter: this.modelAdapter,
      getTool: name => this.getTool(name),
      permissionEngine,
      canDelegate: this.definition.canDelegate === true,
      delegationPath: [...(task.delegationPath || []), this.id],
      rootRunId: this.rootRunId
    });
    const scopedTask = Object.assign({}, task, {
      limits: Object.assign({}, task.limits || {}, this.definition.budgets),
      timeoutMs: Math.min(task.timeoutMs || this.definition.budgets.maxRuntimeMs, this.definition.budgets.maxRuntimeMs),
      dynamicSystemPrompt: this.definition.systemPrompt,
      dynamicRole: this.definition.role,
      canDelegate: this.definition.canDelegate === true,
      rootRunId: this.rootRunId
    });
    this._onState('RUNNING');
    const started = await super.startTask(scopedTask, scopedContext);
    const innerRunId = started.runId;
    this._hubRuns.set(hubRunId, innerRunId);
    this._monitor(hubRunId, innerRunId, context);
    return { runId: hubRunId };
  }

  _monitor(hubRunId, innerRunId, context) {
    const poll = async () => {
      const mapping = this._hubRuns.get(hubRunId);
      if (!mapping) return;
      const run = context.runManager && context.runManager.getRun(innerRunId);
      if (!run || !TERMINAL.has(run.status)) return;
      this._clearMonitor(hubRunId);
      const status = run.status === 'interrupted' ? 'failed' : run.status;
      const result = await super.getResult(innerRunId) || { status, summary: run.message || '', error: run.error || null };
      if (typeof context.finishRun === 'function') context.finishRun(status, result);
      this._onState(status.toUpperCase(), { terminalAt: Date.now(), runId: hubRunId });
    };
    const timer = setInterval(() => { void poll(); }, 10);
    if (timer.unref) timer.unref();
    this._monitors.set(hubRunId, timer);
    void poll();
  }

  _clearMonitor(hubRunId) {
    const timer = this._monitors.get(hubRunId);
    if (timer) clearInterval(timer);
    this._monitors.delete(hubRunId);
  }

  async cancel(runId) {
    const innerRunId = this._hubRuns.get(runId) || runId;
    const result = await super.cancel(innerRunId);
    return result;
  }

  async getStatus(runId) {
    return super.getStatus(this._hubRuns.get(runId) || runId);
  }

  async getResult(runId) {
    return super.getResult(this._hubRuns.get(runId) || runId);
  }

  async dispose() {
    for (const hubRunId of [...this._hubRuns.keys()]) {
      try { await this.cancel(hubRunId); } catch { /* best effort */ }
    }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      let running = false;
      for (const innerRunId of this._hubRuns.values()) {
        const status = await super.getStatus(innerRunId);
        if (status && !TERMINAL.has(status.status)) running = true;
      }
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    for (const hubRunId of [...this._monitors.keys()]) this._clearMonitor(hubRunId);
    this._hubRuns.clear();
    await super.dispose();
  }

  activeTimerCount() {
    return this._monitors.size;
  }
}

module.exports = { DynamicNativeAgentAdapter, MUTATION_TOOLS, TOOL_ALIASES };
