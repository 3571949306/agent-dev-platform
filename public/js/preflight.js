// Preflight — 发送前检查。纯函数，便于单元测试与 GUI 回归测试。
// 内部模型列表可能来自不同存储形态：string[] 或对象数组 [{id, source, favorite, addedAt}]，
// 这里统一归一化为 id 数组，避免调用方各写一份解析逻辑再次出 Bug。

/** 把任意形态的模型列表归一化为模型 id 数组 */
export function modelIdsOf(models) {
  return (models || []).map(m => (typeof m === 'string' ? m : (m && m.id) || '')).filter(Boolean);
}

/**
 * Agent Preflight 决策。
 * @param agent 智能体记录（可能无 api_connection_id / model）
 * @param conn 对应 API 连接（可能不存在 / models 为空）
 * @returns { ok:boolean, code?:'no_conn'|'no_model'|'no_models_in_conn', hint?:'model_not_in_list', modelIds:string[] }
 *
 * Case A: agent.model 为空            → no_model（即使连接里有模型）
 * Case B: agent.model 有值，连接无模型 → no_models_in_conn
 * Case C: 都齐备且模型在列表中        → ok
 * Case D: 模型不在最新列表            → ok + hint（允许继续，仅提示）
 */
export function preflightCheck(agent, conn) {
  const modelIds = modelIdsOf(conn && conn.models);
  if (!agent || !agent.api_connection_id || !conn) {
    return { ok: false, code: 'no_conn', modelIds };
  }
  if (!agent.model || !agent.model.trim()) {
    return { ok: false, code: 'no_model', modelIds };
  }
  if (!modelIds.length) {
    return { ok: false, code: 'no_models_in_conn', modelIds };
  }
  if (!modelIds.includes(agent.model)) {
    return { ok: true, hint: 'model_not_in_list', modelIds };
  }
  return { ok: true, modelIds };
}
