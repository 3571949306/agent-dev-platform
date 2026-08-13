'use strict';
/**
 * v2.9.9 Phase B PART A（A2）— Effective Project Identity。
 *
 * Child Run 通常无 conversation（projectId = null），直接按 projectId 过滤会
 * 让其他项目的 Run 混入，或让本项目的 Child 丢失。
 *
 * 有效项目身份解析链（只用持久化记录，绝不猜测）：
 *   Run → rootRunId → root Run → conversation → project
 *
 * 具体策略：
 *   1. 自身有 conversation → 直接取 conversation.project_id
 *   2. 无 conversation → 沿真实 parent_run_id 链上行到 root（环保护 + bounded）
 *   3. parent 链断裂（记录缺失）→ 最后尝试持久化的 root_run_id 指针
 *   4. 仍无法解析 → null（lineage broken，宁可缺省也不猜）
 */

/**
 * @param {object} p {
 *   run,                       // runs 行（需含 id / conversation_id / parent_run_id / root_run_id）
 *   getConversationProject,    // (conversationId) => projectId | null
 *   getRun,                    // (runId) => runs 行 | null
 *   maxHops?                   // 链上行最大跳数（默认 32，防环/防深）
 * }
 * @returns {string|null} effectiveProjectId
 */
function resolveRunProjectId({ run, getConversationProject, getRun, maxHops = 32 } = {}) {
  if (!run || typeof getConversationProject !== 'function' || typeof getRun !== 'function') return null;

  // 1. 自身 conversation → 直接项目
  if (run.conversation_id) {
    return getConversationProject(run.conversation_id) || null;
  }

  // 2. 沿真实 parent lineage 上行（带环保护）
  const seen = new Set([run.id]);
  let current = run;
  let hops = 0;
  let chainBroken = false;
  while (current && !current.conversation_id && current.parent_run_id && hops < maxHops) {
    if (seen.has(current.parent_run_id)) return null; // 环：lineage broken
    const parent = getRun(current.parent_run_id);
    if (!parent) { chainBroken = true; break; } // 记录缺失：链断裂
    seen.add(parent.id);
    hops += 1;
    current = parent;
  }
  if (current && current.conversation_id) {
    return getConversationProject(current.conversation_id) || null;
  }

  // 3. parent 链断裂时，root_run_id 仍是持久化 lineage 记录（不是猜测）
  if ((chainBroken || !current || !current.parent_run_id) && run.root_run_id && run.root_run_id !== run.id && !seen.has(run.root_run_id)) {
    const rootRow = getRun(run.root_run_id);
    if (rootRow && rootRow.conversation_id) {
      return getConversationProject(rootRow.conversation_id) || null;
    }
  }

  // 4. lineage broken → null，绝不猜
  return null;
}

module.exports = { resolveRunProjectId };
