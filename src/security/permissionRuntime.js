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
  if (!d || d.decision !== 'allow') {
    // 用户拒绝：若带 always/deny range 则持久化 deny
    const range = d && d.range;
    if (engine && (range === 'always' || range === 'deny')) {
      try { engine.grant(scope, 'deny'); } catch { /* non-fatal */ }
    }
    return { allowed: false, decision: (d && d.decision) || 'deny', range: range || null, source: 'user' };
  }

  // 用户允许：消费 range
  const range = d.range || 'once';
  if (!VALID_RANGES.includes(range)) {
    // 后端必须 validate enum；未知 range fail-closed，exec=0
    return { allowed: false, decision: 'allow', range, source: 'user', code: 'PERMISSION_RANGE_INVALID' };
  }
  applyRange(engine, scope, range, { taskPermissionId, projectId });
  return { allowed: true, decision: 'allow', range, source: 'user' };
}

/** 把用户选择的 range 应用为运行时/持久授权。 */
function applyRange(engine, scope, range, ids) {
  if (!engine) return;
  if (range === 'once') return; // 当前 operation 自身即 once，无持久权限
  if (range === 'task') { engine.grantTask(scope, ids.taskPermissionId); return; }
  if (range === 'project') { try { engine.grant(scope, 'project'); } catch { /* non-fatal */ } return; }
  if (range === 'always') { try { engine.grant(scope, 'always'); } catch { /* non-fatal */ } return; }
  if (range === 'deny') { try { engine.grant(scope, 'deny'); } catch { /* non-fatal */ } return; }
}

module.exports = { authorize, applyRange, taskPermissionIdOf, VALID_RANGES };
