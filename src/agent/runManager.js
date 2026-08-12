'use strict';
/**
 * RunManager — 全应用唯一的 Run 状态机。
 *
 * v2.3.1 (P0-2 / P0-3 / P0-4):
 *  - Promise resolve ≠ 业务成功。runChatTurn 返回正式业务结果 { status, result, error, taskId }，
 *    agent:send 根据真实 status 决定终态。
 *  - 一个 Run 只能进入一次终态：终态一旦确定，后续任何 finishRun / 状态变更都会被忽略。
 *  - assistant_message / task_complete / tool_result 等事件无权完成 Run。
 *  - External Agent 的 completed / failed / cancelled / timeout 统一进入状态机。
 *
 * 状态迁移（合法表见 TRANSITIONS）：
 *   preparing → requesting_model → streaming → executing_tool → … → completed
 *   任意非终态 → failed / cancelled / timeout / interrupted
 *   禁止：failed → completed / cancelled → completed / timeout → completed / completed → failed
 */
const crypto = require('crypto');

const NON_TERMINAL = ['preparing', 'requesting_model', 'streaming', 'executing_tool', 'waiting_permission', 'waiting_subagent', 'waiting_external_agent', 'testing'];
const TERMINAL = ['completed', 'failed', 'cancelled', 'timeout', 'interrupted'];
const ALL = [...NON_TERMINAL, ...TERMINAL];

function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** 合法非终态迁移表（同一状态重复允许，终态只能由 finishRun 进入）。 */
const TRANSITIONS = {
  preparing: ['requesting_model', 'waiting_external_agent'],
  requesting_model: ['streaming', 'executing_tool', 'waiting_subagent', 'waiting_external_agent'],
  streaming: ['executing_tool', 'requesting_model'],
  executing_tool: ['requesting_model', 'streaming', 'waiting_subagent', 'waiting_external_agent', 'waiting_permission'],
  waiting_permission: ['executing_tool', 'requesting_model'],
  waiting_subagent: ['requesting_model', 'streaming', 'executing_tool'],
  waiting_external_agent: ['requesting_model', 'streaming', 'executing_tool'],
  testing: ['requesting_model', 'executing_tool', 'completed']
};

class RunManager {
  /**
   * @param opts { store?, emit? } — store 可选（有 runs 表时持久化）；emit 事件发射器。
   */
  constructor({ store, emit } = {}) {
    this.store = store || null;
    this.emit = emit || (() => {});
    this.runs = new Map();          // runId -> run
    this.byConversation = new Map(); // conversationId -> runId（当前活跃 Run）
  }

  /** 创建 Run（status=preparing），立即发 preparing 事件。 */
  createRun({ conversationId, agentId, taskId = null, runId = null,
              parentRunId = null, rootRunId = null, depth = 0, adapterId = null }) {
    const id = runId || crypto.randomUUID();
    const now = Date.now();
    const run = {
      id,
      conversationId: conversationId || null,
      agentId: agentId || null,
      taskId: taskId || null,
      status: 'preparing',
      stage: 'preparing',
      startedAt: now,
      updatedAt: now,
      lastActivityAt: now,
      terminalAt: null,
      error: null,
      message: null,
      // v2.9.0 §21/§116 — Run Tree
      parentRunId: parentRunId || null,
      rootRunId: rootRunId || parentRunId || id,   // 无 parent 则自身为 root
      depth: depth || 0,
      adapterId: adapterId || '',
      log: [{ t: now, status: 'preparing', previousStatus: null, source: 'create' }]
    };
    this.runs.set(id, run);
    if (conversationId) this.byConversation.set(conversationId, id);
    this._persist(run);
    // v2.9.0 §21/§60-61 — 携带 Run Tree 字段，供 GUI 构建 Main Agent → Delegate → Child 树
    this._emit('run_state_changed', {
      conversationId, runId: id, agentId, adapterId,
      parentRunId: run.parentRunId, rootRunId: run.rootRunId, depth: run.depth,
      status: 'preparing', stage: 'preparing', timestamp: now
    });
    return run;
  }

  /** 更新非终态阶段（preparing → requesting_model 等）。终态后一律忽略。 */
  updateRun(runId, status, { conversationId, message, source = 'runtime' } = {}) {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (isTerminal(run.status)) {
      this._debug(`忽略状态变更：${run.status} → ${status}（Run 已终态）`, run);
      return run;
    }
    if (!ALL.includes(status)) {
      this._debug(`忽略未知状态：${status}`, run);
      return run;
    }
    if (isTerminal(status)) {
      // 非终态 → 终态必须走 finishRun（那里会落库 + 发专用事件）
      this._debug(`updateRun 收到终态 ${status}，请使用 finishRun`, run);
      return run;
    }
    const from = run.status;
    if (from === status) return run; // 同状态幂等
    const allowed = TRANSITIONS[from] || [];
    if (!allowed.includes(status)) {
      this._debug(`忽略非法状态迁移：${from} → ${status}`, run);
      return run;
    }
    run.status = status;
    run.stage = status;
    run.updatedAt = Date.now();
    run.lastActivityAt = Date.now();
    run.log.push({ t: Date.now(), status, previousStatus: from, source: source || 'runtime' });
    this._persist(run);
    this._emit('run_state_changed', {
      conversationId: run.conversationId, runId, status, stage: status,
      previousStatus: from, message: message || null, timestamp: Date.now()
    });
    return run;
  }

  /**
   * 唯一终态入口。任何非终态 → 终态都合法；终态已定则忽略（含 failed → completed）。
   * 只在这里发 run_completed / run_failed / run_cancelled / run_timeout / run_interrupted。
   */
  finishRun(runId, status, { error, message, conversationId, source = 'finish' } = {}) {
    const run = this.runs.get(runId);
    if (!run) return null;
    if (isTerminal(run.status)) {
      this._debug(`忽略非法终态变更：${run.status} → ${status}`, run);
      return run;
    }
    if (!TERMINAL.includes(status)) {
      this._debug(`finishRun 只接受终态，收到 ${status}`, run);
      return run;
    }
    const from = run.status;
    run.status = status;
    run.stage = status;
    run.terminalAt = Date.now();
    // v2.9.8 R8 — Terminal Audit Truth：每个终态必须可审计——谁终结了它
    // （source）以及从创建到终态的真实时长（durationMs），不允许静默消失。
    run.terminalSource = source || 'finish';
    run.durationMs = run.terminalAt - run.startedAt;
    run.updatedAt = Date.now();
    run.lastActivityAt = Date.now();
    if (error) run.error = String(error);
    if (message) run.message = String(message);
    run.log.push({ t: Date.now(), status, previousStatus: from, source: source || 'finish' });
    if (run.conversationId) this.byConversation.delete(run.conversationId);
    this._persist(run);
    this._emit('run_state_changed', {
      conversationId: run.conversationId, runId, status, stage: status,
      previousStatus: from, error: run.error, message: run.message, timestamp: Date.now()
    });
    const base = { conversationId: run.conversationId, runId, timestamp: Date.now() };
    if (status === 'completed') this._emit('run_completed', base);
    else if (status === 'failed') this._emit('run_failed', { ...base, message: run.error || run.message });
    else if (status === 'cancelled') this._emit('run_cancelled', base);
    else if (status === 'timeout') this._emit('run_timeout', { ...base, message: run.error || run.message });
    else if (status === 'interrupted') this._emit('run_interrupted', { ...base, message: run.message || '运行已中断' });
    return run;
  }

  /** 按对话取消当前活跃 Run（agent:stop 路径）。 */
  cancelByConversation(conversationId, { message = '用户已停止' } = {}) {
    const runId = this.byConversation.get(conversationId);
    if (!runId) return null;
    return this.finishRun(runId, 'cancelled', { message, source: 'stop' });
  }

  getRun(runId) { return this.runs.get(runId) || null; }
  getRunByConversation(conversationId) {
    const runId = this.byConversation.get(conversationId);
    return runId ? this.runs.get(runId) || null : null;
  }
  list() { return [...this.runs.values()]; }

  /** 启动时把数据库里所有非终态 Run 标记为 interrupted（应用上次被关闭）。 */
  interruptStale({ conversationIds = [] } = {}) {
    let stale = [];
    if (this.store && this.store.runs) {
      try { stale = this.store.runs.listNonTerminal(); } catch { stale = []; }
    }
    for (const r of stale) {
      if (!this.runs.has(r.id)) {
        const run = {
          ...r, status: 'interrupted', stage: 'interrupted', terminalAt: Date.now(),
          updatedAt: Date.now(), lastActivityAt: Date.now(), error: null,
          message: '应用上次运行时被关闭', log: []
        };
        this.runs.set(r.id, run);
        if (run.conversationId) this.byConversation.delete(run.conversationId);
        this._persist(run);
        this._emit('run_state_changed', {
          conversationId: run.conversationId, runId: r.id, status: 'interrupted',
          stage: 'interrupted', message: '应用上次运行时被关闭', timestamp: Date.now()
        });
        this._emit('run_interrupted', { conversationId: run.conversationId, runId: r.id, message: '应用上次运行时被关闭', timestamp: Date.now() });
      }
    }
    return stale.length;
  }

  _persist(run) {
    if (!this.store || !this.store.runs) return;
    try { this.store.runs.upsert(run); } catch (e) { this._debug('runs 持久化失败: ' + e.message, run); }
  }

  _emit(type, payload) { try { this.emit(type, payload); } catch (e) { this._debug('emit 失败: ' + e.message); } }

  _debug(msg, run) {
    try {
      console.log(`[RunManager] ${msg}${run ? ` (run=${run.id} conv=${run.conversationId || '-'})` : ''}`);
    } catch { /* never break a run for logging */ }
  }
}

module.exports = { RunManager, isTerminal, NON_TERMINAL, TERMINAL, ALL, TRANSITIONS };
