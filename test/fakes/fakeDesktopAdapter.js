'use strict';
/**
 * Fake Desktop Agent Adapter — deterministic test double simulating a
 * desktop-bridged agent (e.g. WorkBuddy).
 *
 * Behaviour:
 *   - detect() availability driven by `windowFound`
 *   - healthCheck() reports healthy when windowFound, unavailable otherwise
 *   - startTask resolves after `delayMs` with a deterministic result
 *   - cancel() marks the run as cancelled
 *
 * Constructor: { manifest, resultText, delayMs, windowFound }
 */
const { BaseAgentAdapter } = require('../../src/agents/adapters/baseAgentAdapter');

class FakeDesktopAdapter extends BaseAgentAdapter {
  constructor(opts = {}) {
    super(opts);
    this.resultText = opts.resultText || 'Desktop agent completed the task';
    this.delayMs = opts.delayMs || 10;
    this.windowFound = opts.windowFound !== false;
    this.runs = new Map();
    this.aborted = new Set();
  }
  async detect() { return { available: this.windowFound, version: 'fake-desktop-1.0', path: null }; }
  async healthCheck() {
    if (!this.windowFound) {
      return { status: 'unavailable', version: null, latencyMs: 0 };
    }
    return { status: 'healthy', version: 'fake-desktop-1.0', latencyMs: 1 };
  }
  async startTask(task, context) {
    const runId = 'fake-desktop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
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
module.exports = { FakeDesktopAdapter };
