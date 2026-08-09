'use strict';
/**
 * Fake @cline/sdk — 模拟 Cline SDK 的 Agent / ClineCore / createTool 接口。
 * 用于测试 ClineAgentAdapter，不消耗真实 API。
 *
 * 通过 require.cache 注入到 src/agents/integrations/cline/sdkBridge.js，
 * 使 ClineAgentAdapter 在测试中获得可控行为：
 *   - Agent.run() 发出 content_start / content_update / usage 事件
 *   - Agent.cancel() 中止运行
 *   - ClineCore.create() / start() 模拟会话级执行
 */

class FakeAgent {
  constructor(opts = {}) {
    this.providerId = opts.providerId;
    this.modelId = opts.modelId;
    this.apiKey = opts.apiKey;
    this.maxIterations = opts.maxIterations || 50;
    this._onEvent = opts.onEvent;
    this._subscribers = [];
    this._aborted = false;
    this._hasRun = false;
    this._delayMs = opts.delayMs || 0;
  }

  subscribe(cb) { this._subscribers.push(cb); }

  async run(prompt) {
    this._hasRun = true;
    // Emit content_start
    this._emit({ type: 'content_start', contentType: 'text' });
    // Emit content_update (text deltas)
    this._emit({ type: 'content_update', contentType: 'text', text: 'Processing: ' + prompt });
    // Emit usage
    this._emit({ type: 'usage', inputTokens: 100, outputTokens: 50 });

    if (this._delayMs > 0) {
      await new Promise(r => setTimeout(r, this._delayMs));
    }

    if (this._aborted) {
      return { text: '', usage: { inputTokens: 100, outputTokens: 0 }, iterations: 0, cancelled: true };
    }

    return { text: 'Task completed successfully', usage: { inputTokens: 100, outputTokens: 50 }, iterations: 3 };
  }

  async continue(prompt) {
    return this.run(prompt);
  }

  cancel() { this._aborted = true; }

  _emit(event) {
    if (this._onEvent) this._onEvent(event);
    this._subscribers.forEach(cb => cb(event));
  }

  get hasRun() { return this._hasRun; }
}

class FakeClineCore {
  constructor() { this.sessions = []; }

  static async create(opts) { return new FakeClineCore(); }

  async start(opts) {
    const sessionId = 'fake-session-' + Date.now();
    this.sessions.push(sessionId);
    return {
      sessionId,
      result: { text: 'ClineCore task completed', usage: { inputTokens: 200, outputTokens: 100 } },
      manifest: { workspaceRoot: opts.config?.cwd || '/tmp' }
    };
  }

  async stop() {}
}

function createTool(opts) {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: opts.execute
  };
}

module.exports = { Agent: FakeAgent, ClineCore: FakeClineCore, createTool };
