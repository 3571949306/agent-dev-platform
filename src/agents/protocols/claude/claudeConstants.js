'use strict';
/**
 * v2.8.0 — Claude Code / Claude Agent SDK 协议常量（spec §49/§50/§53/§54）。
 *
 * 关键事实（决定了本目录的结构）：
 *   Claude Agent SDK 的 `SDKMessage` 与 Claude Code CLI
 *   `--output-format stream-json` 每行输出的对象是**同一套 schema**
 *   （SDK 本质是对 CLI 控制协议的封装）。
 *   → 因此 SDK 路径与 CLI 路径共用同一个 eventMapper，不需要两套映射。
 *
 * 来源（官方文档，逐字核对，未臆造）：
 *   docs.claude.com/en/api/agent-sdk/typescript
 *     - SDKMessage 联合：assistant / user / result / system / stream_event / ...
 *     - SDKResultMessage.subtype：success | error_max_turns | error_during_execution
 *                                 | error_max_budget_usd | error_max_structured_output_retries
 *     - SDKResultMessage：is_error / num_turns / result / session_id
 *                         / total_cost_usd / usage / permission_denials
 *     - SDKSystemMessage(subtype:'init')：session_id / cwd / tools / model
 *                         / permissionMode / mcp_servers / claude_code_version / capabilities
 *     - PermissionMode：default | acceptEdits | bypassPermissions | plan | dontAsk | auto
 *   docs.claude.com/en/docs/claude-code/cli-reference
 *     - -p/--print、--output-format、--input-format、--verbose、--resume/-r、--continue/-c
 *       --permission-mode、--allowedTools、--disallowedTools、--max-turns、--model
 *       --add-dir、--session-id、--include-partial-messages
 *
 * 安全红线：
 *   `--dangerously-skip-permissions` / permissionMode='bypassPermissions'
 *   在本平台**禁止使用**（spec §36：危险操作不得自动放行）。
 */

/** SDKMessage.type（同时也是 CLI stream-json 每行的 type）。 */
const MESSAGE_TYPE = {
  SYSTEM: 'system',
  ASSISTANT: 'assistant',
  USER: 'user',
  RESULT: 'result',
  STREAM_EVENT: 'stream_event'
};

/** system 消息的 subtype。 */
const SYSTEM_SUBTYPE = {
  INIT: 'init',
  API_RETRY: 'api_retry',
  PLUGIN_INSTALL: 'plugin_install'
};

/** result 消息的 subtype。只有 success 代表成功完成。 */
const RESULT_SUBTYPE = {
  SUCCESS: 'success',
  ERROR_MAX_TURNS: 'error_max_turns',
  ERROR_DURING_EXECUTION: 'error_during_execution',
  ERROR_MAX_BUDGET_USD: 'error_max_budget_usd',
  ERROR_MAX_STRUCTURED_OUTPUT_RETRIES: 'error_max_structured_output_retries'
};

/** Anthropic Messages API 内容块类型（assistant.message.content / user.message.content）。 */
const CONTENT_BLOCK = {
  TEXT: 'text',
  THINKING: 'thinking',
  REDACTED_THINKING: 'redacted_thinking',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result'
};

/**
 * 权限模式。
 * ⚠️ BYPASS 仅为"识别并拒绝"而列出 —— 平台不得主动设置它（spec §36）。
 */
const PERMISSION_MODE = {
  DEFAULT: 'default',
  ACCEPT_EDITS: 'acceptEdits',
  PLAN: 'plan',
  DONT_ASK: 'dontAsk',
  AUTO: 'auto',
  BYPASS: 'bypassPermissions'
};

/** 平台允许下发给 Claude 的权限模式白名单（其余一律回落到 default）。 */
const ALLOWED_PERMISSION_MODES = new Set([
  PERMISSION_MODE.DEFAULT,
  PERMISSION_MODE.PLAN,
  PERMISSION_MODE.ACCEPT_EDITS
]);

/**
 * Claude Code 内置工具名 → 平台语义分类。
 * 用于把 tool_use 归到 命令 / 文件读 / 文件写 / 计划 / 通用工具 事件。
 */
const TOOL_KIND = {
  COMMAND: 'command',
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  PLAN: 'plan',
  TOOL: 'tool'
};

const TOOL_CLASSIFICATION = {
  Bash: TOOL_KIND.COMMAND,
  BashOutput: TOOL_KIND.COMMAND,
  KillShell: TOOL_KIND.COMMAND,
  Read: TOOL_KIND.FILE_READ,
  Glob: TOOL_KIND.FILE_READ,
  Grep: TOOL_KIND.FILE_READ,
  NotebookRead: TOOL_KIND.FILE_READ,
  Write: TOOL_KIND.FILE_WRITE,
  Edit: TOOL_KIND.FILE_WRITE,
  MultiEdit: TOOL_KIND.FILE_WRITE,
  NotebookEdit: TOOL_KIND.FILE_WRITE,
  TodoWrite: TOOL_KIND.PLAN
};

/** 判断一个工具名属于哪类（未知工具归为通用 tool）。 */
function classifyTool(name) {
  return TOOL_CLASSIFICATION[name] || TOOL_KIND.TOOL;
}

/** npm 包名（Anthropic 商业条款，非 OSS → 只做可选依赖，绝不 vendor 进仓库）。 */
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** CLI 可执行名。 */
const CLI_COMMAND = 'claude';

module.exports = {
  MESSAGE_TYPE,
  SYSTEM_SUBTYPE,
  RESULT_SUBTYPE,
  CONTENT_BLOCK,
  PERMISSION_MODE,
  ALLOWED_PERMISSION_MODES,
  TOOL_KIND,
  TOOL_CLASSIFICATION,
  classifyTool,
  SDK_PACKAGE,
  CLI_COMMAND
};
