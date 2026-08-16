'use strict';
/**
 * v2.9.9 Computer Use 2.0-A — Permission Runtime helper。
 *
 * 这是 PermissionEngine 的 runtime helper，不是第二套 Permission Framework。
 * 统一所有 canonical permission ask 路径（Main tool / Computer target / sensitive
 * input / raw coordinate / browser / clipboard）对 permission response 的消费：
 * 之前只看 `decision === 'allow'`，没有完整消费 `range`，导致「始终允许 / 当前项目
 * 允许 / 本任务允许」没有成为真正的运行时授权策略。
 *
 * range 语义（§6）：
 *   once    — 只批准当前这一次 operation；不写入任何持久/内存 grant。
 *   task    — 只允许当前真实 Run/Task（taskPermissionId = taskId || runId）；新 Run 不继承。
 *   project — 当前项目允许；绑定真实 projectId，持久化 SQLite；跨项目 ask。
 *   always  — 全局永久允许；App 重启仍 allow。
 *   deny    — 全局永久拒绝；App 重启仍 deny。
 *
 * 未知 range → PERMISSION_RANGE_INVALID，exec=0（fail-closed）。
 */

const VALID_RANGES = ['once', 'task', 'project', 'always', 'deny'];
// v2.9.9 CU2-A.1 §4：decision+range 合法组合矩阵。
const ALLOW_RANGES = ['once', 'task', 'project', 'always'];
const DENY_RANGES = ['once', 'deny'];
function decisionRangeValid(decision, range) {
  if (decision === 'allow') return ALLOW_RANGES.includes(range);
  if (decision === 'deny') return DENY_RANGES.includes(range);
  return false;
}

/** canonical task permission identity：taskId || runId。 */
function taskPermissionIdOf(context = {}) {
  return context.taskId || context.runId || null;
}

/**
 * 统一授权入口。
 * @param {object} opts
 * @param {object} opts.engine            PermissionEngine 实例
 * @param {string} opts.scope             权限 scope
 * @param {object} [opts.context]         { taskId, runId, projectId }
 * @param {Function} [opts.requestPermission]  弹窗通道 (req) => {decision, range}
 * @param {object} [opts.requestMeta]     透传给弹窗的展示信息
 * @returns {Promise<{allowed:boolean, decision:string, range:string|null, source:string, code?:string}>}
 */
async function authorize({ engine, scope, context = {}, requestPermission, requestMeta = {} }) {
  const taskPermissionId = taskPermissionIdOf(context);
  const projectId = context.projectId || (engine && engine.projectId) || null;
  const evalCtx = { taskId: taskPermissionId, projectId };

  const verdict = engine ? engine.evaluate(scope, evalCtx) : 'ask';
  if (verdict === 'allow') return { allowed: true, decision: 'allow', range: null, source: 'policy' };
  if (verdict === 'deny') return { allowed: false, decision: 'deny', range: null, source: 'policy' };

  // ask → 需要用户决策
  if (typeof requestPermission !== 'function') {
    return { allowed: false, decision: 'ask', range: null, source: 'no-channel' };
  }
  let d = null;
  try { d = await requestPermission({ scope, ...requestMeta }); } catch { d = null; }
  const decision = d && d.decision;
  const range = (d && d.range) || (decision === 'allow' ? 'once' : 'once');

  // §4 矩阵校验：未知/非法 combination → PERMISSION_DECISION_RANGE_INVALID，exec=0。
  if (decision !== 'allow' && decision !== 'deny') {
    return { allowed: false, decision: decision || 'deny', range: d && d.range || null, source: 'user', code: 'PERMISSION_DECISION_RANGE_INVALID', persisted: false };
  }
  if (!decisionRangeValid(decision, d && d.range)) {
    // 特别：allow+deny / deny+task|project|always 均非法 → 不保存、不执行。
    return { allowed: false, decision, range: d && d.range || null, source: 'user', code: 'PERMISSION_DECISION_RANGE_INVALID', persisted: false };
  }

  if (decision === 'deny') {
    // deny+once：仅本次拒绝，不持久化；deny+deny：持久化全局拒绝。
    let persisted = false;
    if (range === 'deny' && engine) {
      const r = engine.grant(scope, 'deny');
      persisted = !!(r && r.persisted);
    }
    return { allowed: false, decision: 'deny', range, source: 'user', persisted };
  }

  // allow：消费 range；persisted 反映持久层真相（§5）。
  const applied = applyRange(engine, scope, range, { taskPermissionId, projectId });
  return { allowed: true, decision: 'allow', range, source: 'user', persisted: applied.persisted };
}

/** 把用户选择的 range 应用为运行时/持久授权。返回 {persisted}。 */
function applyRange(engine, scope, range, ids) {
  if (!engine) return { persisted: false };
  if (range === 'once') return { persisted: true }; // 当前 operation 自身即 once，无需持久
  if (range === 'task') { engine.grantTask(scope, ids.taskPermissionId); return { persisted: true }; }
  const r = engine.grant(scope, range); // project/always/deny → 持久层
  return { persisted: !!(r && r.persisted) };
}

module.exports = { authorize, applyRange, taskPermissionIdOf, VALID_RANGES, ALLOW_RANGES, DENY_RANGES, decisionRangeValid };
