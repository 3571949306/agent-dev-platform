'use strict';
/**
 * v2.7.0 — TestAgentAdapter：可通过 JSON 配置的测试用 Adapter。
 *
 * 仅供 NODE_ENV=test 下通过 hub:testRegisterAdapter IPC 注册。
 * 不含函数属性，可被 Playwright page.evaluate 安全克隆。
 * 支持配置：启动失败 / 延迟完成 / 自定义结果文本 / 健康状态等。
 *
 * 完成时通过 context.finishRun 回调通知 Hub 更新生命周期状态，
 * 使 hub:status / hub:result 能正确返回终态。
 */
const { BaseAgentAdapter } = require('./baseAgentAdapter');

class TestAgentAdapter extends BaseAgentAdapter {
  constructor(config = {}) {
    super({ manifest: config.manifest || {}, config });
    this._id = config.id || (config.manifest && config.manifest.id) || 'test-agent';
    this._transport = config.transport || 'sdk';
    this._capabilities = Array.isArray(config.capabilities) ? config.capabilities : ['coding'];
    this._disabled = !!config.disabled;
    this._available = config.available !== false;
    this._healthStatus = config.healthStatus || 'healthy';
    this._maxConcurrency = config.maxConcurrency || 1;
    this._activeRunCount = 0;
    this._startFails = !!config.startFails;
    this._resultText = config.resultText || 'Test agent completed';
    this._delayMs = config.delayMs || 0;
    this._quiesced = config.quiesced !== false;
    this._detectResult = config.detectResult || null;
    this._runs = new Map();

    // 覆盖基类实例属性（基类构造器已从 manifest 设置初值，这里用 config 覆盖）
    this.id = this._id;
    this.transport = this._transport;
    this.adapterType = this._transport;
    this.disabled = this._disabled;
    this.available = this._available;
    this.healthStatus = this._healthStatus;
    this.maxConcurrency = this._maxConcurrency;
    this.capabilities = this._capabilities;
  }

  get activeRunCount() { return this._activeRunCount; }
  set activeRunCount(value) {
    const count = Number(value);
    this._activeRunCount = Number.isFinite(count) ? Math.max(0, count) : 0;
  }

  getManifest() {
    if (this.manifest && Object.keys(this.manifest).length > 0) {
      return {
        ...this.manifest,
        id: this._id,
        transport: this._transport,
        capabilities: this._capabilities,
        maxConcurrency: this._maxConcurrency
      };
    }
    return {
      id: this._id,
      displayName: this._id,
      source: 'test',
      transport: this._transport,
      capabilities: this._capabilities,
      availability: this._available,
      version: 'test-1.0',
      path: null,
      maxConcurrency: this._maxConcurrency
    };
  }

  async detect() {
    const result = this._detectResult || { available: this._available, installed: this._available, configured: this._available, version: 'test-1.0', path: null };
    this._detected = { ...result };
    return { ...result };
  }
  async healthCheck() { return { status: this._healthStatus, version: 'test-1.0', latencyMs: 1 }; }

  async startTask(task, context) {
    if (this._startFails) throw new Error('Test agent start failed');
    const runId = (context && context.runId) || ('test-run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    const finishRun = context && typeof context.finishRun === 'function' ? context.finishRun : null;
    this._runs.set(runId, { status: 'running', startedAt: Date.now(), result: null });

    const complete = () => {
      const run = this._runs.get(runId);
      if (run && run.status === 'running') {
        run.status = 'completed';
        run.result = {
          ok: true,
          status: 'completed',
          summary: this._resultText,
          changedFiles: [],
          artifacts: [],
          durationMs: this._delayMs
        };
        // 通知 Hub 更新生命周期状态（使 hub:status / hub:result 返回终态）
        if (finishRun) {
          try { finishRun('completed', this._resultText); } catch { /* non-fatal */ }
        }
      }
    };

    if (this._delayMs > 0) {
      setTimeout(complete, this._delayMs);
    } else {
      complete();
    }
    return { runId };
  }

  async cancel(runId) {
    const run = this._runs.get(runId);
    if (run) { run.status = 'cancelled'; }
    return { ok: this._quiesced, status: this._quiesced ? 'cancelled' : 'cancelling', quiesced: this._quiesced, residual: this._quiesced ? 0 : { runId } };
  }
  async awaitQuiescence(runId) { return { quiesced: this._quiesced, residual: this._quiesced ? 0 : { runId } }; }
  setTestQuiesced(value) { this._quiesced = value === true; return this._quiesced; }
  async getStatus(runId) {
    const run = this._runs.get(runId);
    return run ? { status: run.status } : { status: 'unknown' };
  }
  async getResult(runId) {
    const run = this._runs.get(runId);
    return run ? run.result : null;
  }
  async dispose() { this._runs.clear(); }
}

module.exports = { TestAgentAdapter };
