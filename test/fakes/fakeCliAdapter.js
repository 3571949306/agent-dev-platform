'use strict';
/**
 * Fake CLI Agent Adapter — deterministic test double simulating a CLI agent.
 *
 * Behaviour:
 *   - detect() always reports available
 *   - healthCheck() always reports healthy
 *   - startTask resolves after `delayMs` with a deterministic result;
 *     if `startFails` is true, startTask throws to simulate START_FAILED.
 *   - cancel() marks the run as cancelled
 *
 * Constructor: { manifest, resultText, delayMs, startFails }
 */
const { BaseAgentAdapter } = require('../../src/agents/adapters/baseAgentAdapter');

class FakeCliAdapter extends BaseAgentAdapter {
  constructor(opts = {}) {
    super(opts);
    this.resultText = opts.resultText || 'CLI agent completed the task';
    this.delayMs = opts.delayMs || 10;
    this.startFails = !!opts.startFails;
    this.runs = new Map();
    this.aborted = new Set();
  }
  async detect() { return { available: true, version: 'fake-cli-1.0', path: '/usr/bin/fake-cli' }; }
  async healthCheck() { return { status: 'healthy', version: 'fake-cli-1.0', latencyMs: 1 }; }
  async startTask(task, context) {
    if (this.startFails) {
      throw new Error('FakeCliAdapter: simulated start failure');
    }
    const runId = 'fake-cli-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    this.runs.set(runId, { status: 'running', startedAt: Date.now() });
    setTimeout(() => {
      const run = this.runs.get(runId);
      if (run && run.status === 'running') {
        run.status = 'completed';
        run.result = { ok: true, status: 'completed', summary: this.resultText, changedFiles: [], artifacts: [], durationMs: this.delayMs };
      }
    }, this.delayMs);
    return { runId };
  }
  async cancel(runId) {
    const run = this.runs.get(runId);
    if (run) { run.status = 'cancelled'; this.aborted.add(runId); }
  }
  async getStatus(runId) { return this.runs.get(runId)?.status || 'unknown'; }
  async getResult(runId) { return this.runs.get(runId)?.result || null; }
  async dispose() { this.runs.clear(); }
}
module.exports = { FakeCliAdapter };
