'use strict';
/**
 * v2.9.9 Phase B Final（B21）— Problems Center 唯一真源。
 *
 * 语义契约：
 *   - Problem 是持久化对象（id/time/severity/source/code/message/runId/projectId/status），
 *     不再是 toast 的替代品。
 *   - Severity：INFO / WARNING / ERROR / CRITICAL。
 *   - Source：Agent / Model / Tool / Permission / Workflow / Generator /
 *             External Agent / Computer / Browser / Database / System。
 *   - 同一稳定问题（stableKey = source:code:runId:relatedKey）重复发生只累加
 *     occur_count 并刷新 last_seen —— 绝不每分钟刷 100 条。
 *   - dismiss != resolved：用户可以 dismiss，但只有真实条件消失（调用方确认）
 *     才能 RESOLVED。
 *   - DISMISSED 的问题再次发生时重新变回 ACTIVE（条件仍在，真话优先）。
 */

const SEVERITY = Object.freeze({ INFO: 'INFO', WARNING: 'WARNING', ERROR: 'ERROR', CRITICAL: 'CRITICAL' });
const SOURCES = Object.freeze(new Set([
  'Agent', 'Model', 'Tool', 'Permission', 'Workflow', 'Generator',
  'External Agent', 'Computer', 'Browser', 'Database', 'System'
]));
const STATUS = Object.freeze({ ACTIVE: 'ACTIVE', DISMISSED: 'DISMISSED', RESOLVED: 'RESOLVED' });

function createProblemCenter({ store, emit } = {}) {
  if (!store || !store.problems) throw new Error('PROBLEM_CENTER_STORE_REQUIRED');
  const notify = typeof emit === 'function' ? emit : () => {};

  function stableKeyOf({ source, code, runId = null, relatedKey = null }) {
    return [source, code, runId || '', relatedKey || ''].join(':');
  }

  /**
   * 上报一个问题。重复上报同一 stableKey 时去重（计数 + last_seen）。
   * 返回 { problem, created } —— created=false 表示命中去重。
   */
  function report({ severity, source, code, message = '', runId = null, projectId = null, related = {}, relatedKey = null }) {
    if (!SEVERITY[severity]) throw new Error('PROBLEM_SEVERITY_INVALID: ' + severity);
    if (!SOURCES.has(source)) throw new Error('PROBLEM_SOURCE_INVALID: ' + source);
    if (!code) throw new Error('PROBLEM_CODE_REQUIRED');
    const stableKey = stableKeyOf({ source, code, runId, relatedKey });
    const open = store.problems.findOpenByStableKey(stableKey);
    if (open) {
      // DISMISSED 但条件再次发生 → 真话优先：重新 ACTIVE
      if (open.status === STATUS.DISMISSED) store.problems.setStatus(open.id, STATUS.ACTIVE);
      const updated = store.problems.reoccur(open.id, message || open.message);
      notify('problem:updated', updated);
      return { problem: updated, created: false };
    }
    const created = store.problems.create({
      stableKey, severity, source, code, message, runId, projectId, related, status: STATUS.ACTIVE
    });
    notify('problem:new', created);
    return { problem: created, created: true };
  }

  /** 用户 dismiss —— 只是隐藏，不等于问题解决。 */
  function dismiss(id) {
    const problem = store.problems.get(id);
    if (!problem || problem.status === STATUS.RESOLVED) return problem;
    const updated = store.problems.setStatus(id, STATUS.DISMISSED);
    notify('problem:updated', updated);
    return updated;
  }

  /**
   * 标记 RESOLVED —— 只有调用方确认真实条件已消失才可调用。
   * verify（可选）是条件检查函数：返回 false 时拒绝 resolve（真话优先）。
   */
  function resolve(id, verify = null) {
    const problem = store.problems.get(id);
    if (!problem) return null;
    if (typeof verify === 'function' && verify(problem) === false) {
      throw new Error('PROBLEM_CONDITION_STILL_PRESENT');
    }
    const updated = store.problems.setStatus(id, STATUS.RESOLVED);
    store.problems.pruneResolved(200);
    notify('problem:updated', updated);
    return updated;
  }

  /** 按稳定条件批量 resolve（例如某连接恢复后清掉它的 UNAVAILABLE 问题）。 */
  function resolveWhere(predicate, verify = null) {
    const open = store.problems.list({ limit: 500 });
    let count = 0;
    for (const problem of open) {
      if (!predicate(problem)) continue;
      try { if (resolve(problem.id, verify)) count += 1; } catch { /* condition still present */ }
    }
    return count;
  }

  function list(options = {}) { return store.problems.list(options); }
  function countActive() { return store.problems.countActive(); }

  return { SEVERITY, STATUS, report, dismiss, resolve, resolveWhere, list, countActive, stableKeyOf };
}

module.exports = { createProblemCenter, PROBLEM_SEVERITY: SEVERITY, PROBLEM_SOURCES: SOURCES, PROBLEM_STATUS: STATUS };
