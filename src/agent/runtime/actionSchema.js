'use strict';
/**
 * v2.6.0 Main Agent Runtime — 结构化 Action Schema 与校验（spec §25）。
 *
 * 不靠自然语言猜 Agent Action；要求模型输出结构化 Action 并 schema validate。
 * Malformed Action 自动 repair JSON（有限次数后失败 → AGENT_RESPONSE_INVALID）。
 */

// 支持的 Action 类型（spec §25）
const ACTION_TYPES = [
  'read_file', 'read_files', 'list_directory', 'search', 'find_text',
  'write_file', 'patch_file', 'create_file', 'delete_file',
  'run_command', 'run_tests', 'git_status', 'git_diff',
  'complete', 'ask_permission', 'delegate'
];

// 终结性 Action（执行后需评估完成策略）
const TERMINAL_ACTIONS = ['complete'];

// v2.9.9 体验对标 Phase 2 — 只读 Action：允许一轮并发执行多个（不产生副作用）。
// 写类 / 命令类 / delegate 仍强制单轮单个，避免并发写/并发跑测试的状态竞争。
const READ_ONLY_ACTIONS = [
  'read_file', 'read_files', 'list_directory', 'search', 'find_text', 'git_status', 'git_diff'
];

/**
 * 校验 Action 结构。
 * @param {any} raw 模型返回的原始对象
 * @returns {{ ok: true, action: {type, args, thought?} } | { ok: false, error: string, retryable: boolean }}
 */
function validateAction(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Action 不是对象', retryable: true };
  }
  const action = raw.action || raw; // 兼容 { thought_summary, action:{...} } 与裸 {...}
  if (!action || typeof action !== 'object') {
    return { ok: false, error: '缺少 action 字段', retryable: true };
  }
  const type = action.type;
  if (!type || typeof type !== 'string') {
    return { ok: false, error: '缺少 action.type', retryable: true };
  }
  if (!ACTION_TYPES.includes(type)) {
    return { ok: false, error: `未知 action 类型: ${type}`, retryable: true };
  }
  const args = action.args && typeof action.args === 'object' ? action.args : {};
  const thought = raw.thought_summary || raw.thought || action.thought || '';
  return { ok: true, action: { type, args, thought: String(thought || '').slice(0, 500) } };
}

/**
 * 尝试从模型文本响应中解析出 Action JSON。
 * 模型可能返回纯 JSON、带 ```json 代码块、或前后带说明文字。
 * @param {string} text 模型返回文本
 * @returns {{ ok: true, raw: object } | { ok: false, error: string }}
 */
function parseActionJson(text) {
  if (!text || typeof text !== 'string') {
    return { ok: false, error: '模型返回为空' };
  }
  const s = text.trim();

  // 1. 直接是 JSON
  const direct = tryJson(s);
  if (direct.ok) return direct;

  // 2. ```json ... ``` 代码块
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const r = tryJson(fence[1].trim());
    if (r.ok) return r;
  }

  // 3. 第一个 { 到最后一个 } 之间的内容
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const r = tryJson(s.slice(first, last + 1));
    if (r.ok) return r;
  }

  return { ok: false, error: '无法从模型响应中解析 JSON' };
}

function tryJson(s) {
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object') return { ok: true, raw: obj };
  } catch { /* ignore */ }
  return { ok: false, error: 'JSON 解析失败' };
}

/**
 * 组合：解析 + 校验。
 * @returns {{ ok: true, action } | { ok: false, error, retryable }}
 */
function parseAndValidate(text) {
  const parsed = parseActionJson(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, retryable: true };
  const v = validateAction(parsed.raw);
  if (!v.ok) return { ok: false, error: v.error, retryable: true };
  return { ok: true, action: v.action };
}

module.exports = { ACTION_TYPES, TERMINAL_ACTIONS, READ_ONLY_ACTIONS, validateAction, parseActionJson, parseAndValidate };
