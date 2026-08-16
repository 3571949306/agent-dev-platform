'use strict';
/**
 * v2.9.9 体验对标 Phase 1 — Action → 原生 Tool Schema 映射。
 *
 * 把 actionSchema.js 的 ACTION_TYPES 逐一转换成 provider 可消费的
 * `{ name, description, parameters: {type, properties, required} }` tool 定义，
 * 使 Main Agent Loop 能用原生 tool calling（Anthropic tool_use / OpenAI tool_calls）
 * 而非从自由文本里正则抠 JSON（parseActionJson 仅作 fallback）。
 *
 * 参数字段与 actionExecutor.js / 各工具 exec 实际读取的 `action.args.*` 严格对齐，
 * 不凭空造字段：tool name 即 action.type，tool_calls.arguments 解析后即 action.args。
 */

const { ACTION_TYPES } = require('./actionSchema');

const S = (description) => ({ type: 'string', description });
const OBJ = (description) => ({ type: 'object', description });
const ARR = (description) => ({ type: 'array', items: { type: 'string' }, description });

/** 每个 action 的 tool 定义（name 必须等于 action.type）。 */
const ACTION_TOOL_DEFS = {
  read_file: {
    description: '读取项目内单个文件的完整内容。',
    parameters: { type: 'object', properties: { path: S('相对项目根的文件路径') }, required: ['path'] }
  },
  read_files: {
    description: '一次读取多个文件（只读，可并行）。',
    parameters: { type: 'object', properties: { paths: ARR('相对项目根的文件路径列表') }, required: ['paths'] }
  },
  list_directory: {
    description: '列出目录下的文件与子目录。',
    parameters: { type: 'object', properties: { path: S('相对项目根的目录路径，默认 .') }, required: ['path'] }
  },
  search: {
    description: '在项目内做文本/符号搜索，返回匹配行。',
    parameters: { type: 'object', properties: { query: S('搜索关键词或正则'), pattern: S('同 query 的别名') }, required: ['query'] }
  },
  find_text: {
    description: '在文件内容中查找文本片段。',
    parameters: { type: 'object', properties: { query: S('要查找的文本'), pattern: S('正则形式'), text: S('同 query 的别名') }, required: ['query'] }
  },
  write_file: {
    description: '覆盖写入一个文件的全部内容（会修改工作区）。',
    parameters: { type: 'object', properties: { path: S('相对项目根的文件路径'), content: S('完整新内容') }, required: ['path', 'content'] }
  },
  patch_file: {
    description: '对文件应用结构化 patch（hunks/operations），会修改工作区。',
    parameters: { type: 'object', properties: { path: S('相对项目根的文件路径'), patch: OBJ('patch 结构（hunks/operations），与 apply_patch 工具一致') }, required: ['path', 'patch'] }
  },
  create_file: {
    description: '创建新文件（已存在则失败），会修改工作区。',
    parameters: { type: 'object', properties: { path: S('相对项目根的新文件路径'), content: S('初始内容') }, required: ['path', 'content'] }
  },
  delete_file: {
    description: '删除一个文件或空目录，会修改工作区。',
    parameters: { type: 'object', properties: { path: S('相对项目根的路径') }, required: ['path'] }
  },
  run_command: {
    description: '在项目内执行 shell 命令（高权限，可能被权限门控）。',
    parameters: { type: 'object', properties: { command: S('要执行的命令'), cwd: S('相对工作目录，默认 .'), timeout_ms: { type: 'number', description: '超时毫秒' } }, required: ['command'] }
  },
  run_tests: {
    description: '运行测试命令，结果进入 Test→Repair Loop。',
    parameters: { type: 'object', properties: { command: S('测试命令，如 npm test') }, required: ['command'] }
  },
  git_status: {
    description: '查看项目 git 状态（只读）。',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  git_diff: {
    description: '查看项目 git diff（只读）。',
    parameters: { type: 'object', properties: { path: S('可选，限定单个文件') }, required: [] }
  },
  complete: {
    description: '声明任务完成，触发完成策略评估。',
    parameters: { type: 'object', properties: { summary: S('完成摘要') }, required: ['summary'] }
  },
  ask_permission: {
    description: '向用户请求额外权限。',
    parameters: { type: 'object', properties: { scope: S('权限 scope'), tool: S('相关工具名') }, required: ['scope'] }
  },
  delegate: {
    description: '把子任务委派给其它 Agent（经 AgentHub 路由）。',
    parameters: { type: 'object', properties: { task: S('子任务描述或 {goal}'), requiredCapabilities: ARR('所需能力，如 coding/terminal/research'), agentId: S('可选，指定 Agent') }, required: ['task'] }
  }
};

/**
 * 生成传给 provider.streamResponse 的 tools 数组。
 * 仅包含 ACTION_TYPES 中存在且有定义的 action，保证 name 与 Loop 校验一致。
 * @returns {Array<{name, description, parameters}>}
 */
function buildActionTools() {
  return ACTION_TYPES
    .filter(t => ACTION_TOOL_DEFS[t])
    .map(t => ({ name: t, description: ACTION_TOOL_DEFS[t].description, parameters: ACTION_TOOL_DEFS[t].parameters }));
}

module.exports = { buildActionTools, ACTION_TOOL_DEFS };
