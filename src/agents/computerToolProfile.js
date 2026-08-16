'use strict';
/**
 * v2.9.9 Computer Use 2.0-A.1 — Computer Tool Profile。
 *
 * 供 ProviderModelAdapter(toolProfile) 使用：只向 Computer Agent 暴露明确的
 * Computer tools（UIA/观察/输入/截图），不暴露 terminal/filesystem/git/delete/
 * computer_click_at（deprecated raw coordinate）。
 *
 * validateToolCall 按现有 createComputerTools 的 input_schema 校验参数，
 * 模型给任意 object 不会直接传到 Runtime。
 */

const { createComputerTools } = require('../services/computer');

// §14 允许暴露给 Computer Agent 的 tool 名（不含 click_at / terminal / fs / git / delete）。
const COMPUTER_ALLOWED = new Set([
  'computer_list_windows', 'computer_focus_window', 'computer_observe',
  'computer_invoke_element', 'computer_set_element_value', 'computer_toggle_element',
  'computer_select_element', 'computer_scroll_element', 'computer_click_observed',
  'computer_type_text', 'computer_press_keys', 'computer_screenshot_window',
  'computer_get_ui_tree', 'computer_get_window_text', 'computer_ground_observation',
  'complete'
]);

let _tools = null;
function computerTools() {
  if (!_tools) {
    // createComputerTools() 只构造 manager 对象（不 spawn），安全缓存。
    // 返回 { defs, execs, manager }；schema 在 defs。
    _tools = createComputerTools().defs || [];
  }
  return _tools;
}

const COMPLETE_TOOL = {
  name: 'complete',
  description: '声明桌面任务完成（仅当用户要求已达成且已验证）。',
  input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
};

function buildTools() {
  const list = computerTools().filter(t => COMPUTER_ALLOWED.has(t.name))
    .map(t => ({ name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } }));
  list.push({ name: COMPLETE_TOOL.name, description: COMPLETE_TOOL.description, parameters: COMPLETE_TOOL.input_schema });
  return list;
}

function checkType(value, spec) {
  if (value === undefined || value === null) return false;
  const t = spec && spec.type;
  if (!t) return true;
  if (t === 'string') return typeof value === 'string';
  if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (t === 'boolean') return typeof value === 'boolean';
  if (t === 'object') return typeof value === 'object';
  if (t === 'array') return Array.isArray(value);
  return true;
}

/** 按 input_schema 校验 Computer tool call；未知 tool / 缺参 / 类型错 → ok:false。 */
function validateToolCall(name, args) {
  if (!COMPUTER_ALLOWED.has(name)) return { ok: false, error: `未知 Computer tool: ${name}` };
  const schema = name === 'complete' ? COMPLETE_TOOL.input_schema
    : (computerTools().find(t => t.name === name) || {}).input_schema || { type: 'object', properties: {} };
  const a = (args && typeof args === 'object') ? args : {};
  for (const req of (schema.required || [])) {
    if (a[req] === undefined || a[req] === null) return { ok: false, error: `${name} 缺少参数: ${req}` };
  }
  const props = schema.properties || {};
  for (const [k, v] of Object.entries(a)) {
    if (props[k] && !checkType(v, props[k])) return { ok: false, error: `${name} 参数类型错误: ${k}` };
    if (props[k] && Array.isArray(props[k].enum) && !props[k].enum.includes(v)) return { ok: false, error: `${name} 参数取值非法: ${k}` };
  }
  return { ok: true, action: { type: name, args: a } };
}

// 只读类（可用于观察/发现，不产生桌面 mutation）— 供将来并行策略参考；当前 multipleToolCallPolicy=single。
const COMPUTER_READ_ONLY = [
  'computer_list_windows', 'computer_observe', 'computer_screenshot_window',
  'computer_get_ui_tree', 'computer_get_window_text', 'computer_ground_observation'
];

const computerToolProfile = {
  buildTools,
  validateToolCall,
  readOnlyActions: COMPUTER_READ_ONLY,
  multipleToolCallPolicy: 'single' // 每轮最多一个 mutation，避免桌面状态 race
};

module.exports = { computerToolProfile, COMPUTER_ALLOWED, COMPUTER_READ_ONLY, buildTools, validateToolCall };
