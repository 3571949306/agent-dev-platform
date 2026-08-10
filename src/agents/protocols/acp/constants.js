'use strict';
/**
 * v2.8.0 — ACP 协议常量（spec §5/§6/§23）。
 *
 * ── 协议版本取证结论（禁止再凭猜测改动）────────────────────────────────
 * 真实 Agent 说的是 **wire protocolVersion 1**：
 *   - codex-acp@1.1.14         → deps "@agentclientprotocol/sdk": "1.3.0"
 *   - claude-agent-acp@0.66.0  → deps "@agentclientprotocol/sdk": "1.3.0"
 *   - 两者均 `import * as acp from "@agentclientprotocol/sdk"`（根命名空间）
 *   - SDK src/schema/index.ts:320 → `export const PROTOCOL_VERSION = 1;`（根 = v1）
 *   - SDK src/v2/schema/index.ts:312 → `PROTOCOL_VERSION = 2;`（v2 仅在 `/v2` 子路径导出，
 *     且 schema 版本仍为 2.0.0-alpha，未 stable）
 * 因此本运行时以 **v1 为唯一 wire 基线**实现消息形状；v2 常量仅作记录，
 * 在 v2 稳定且真实 Agent 迁移前不参与协商（fail-closed，见 MAX_SUPPORTED_PROTOCOL_VERSION）。
 *
 * 所有 method / sessionUpdate / capability 名称均逐字来自实时 ACP schema：
 *   .research/upstream/agent-client-protocol/schema/v1/meta.json    (method 清单)
 *   .research/upstream/agent-client-protocol/schema/v1/schema.json  (SessionUpdate / Capabilities / StopReason)
 *
 * 禁止在本文件之外硬编码 ACP method 字符串；统一从这里引用，保证与上游 schema 一致。
 */

/** 已知 wire 协议版本（ACP ProtocolVersion 为 uint16 整数）。 */
const PROTOCOL_VERSION = {
  V1: 1,
  V2: 2
};

/** 本客户端 initialize 时上报的版本（= 真实 Agent 使用的稳定版本）。 */
const SUPPORTED_PROTOCOL_VERSION = PROTOCOL_VERSION.V1;
/**
 * 协商结果上限。我们只实现 v1 消息形状，若 Agent 回 2 则我们无法正确编解码，
 * 必须 fail-closed 断开（ACP_PROTOCOL_UNSUPPORTED），而不是继续用 v1 形状发 v2。
 * 上游 InitializeResponse.protocolVersion 文档明确："The client should disconnect,
 * if it doesn't support this version."
 */
const MAX_SUPPORTED_PROTOCOL_VERSION = PROTOCOL_VERSION.V1;

/**
 * Agent 侧 method（client → agent）。来源：v1/meta.json agentMethods（逐字）。
 * 注意 v1 是 `authenticate` / `logout`，不是 v2 的 `auth/login` / `auth/logout`。
 */
const METHOD = {
  INITIALIZE: 'initialize',
  AUTHENTICATE: 'authenticate',
  SESSION_NEW: 'session/new',
  SESSION_LOAD: 'session/load',
  SESSION_SET_MODE: 'session/set_mode',
  SESSION_SET_CONFIG_OPTION: 'session/set_config_option',
  SESSION_PROMPT: 'session/prompt',
  SESSION_CANCEL: 'session/cancel',
  SESSION_LIST: 'session/list',
  SESSION_DELETE: 'session/delete',
  SESSION_RESUME: 'session/resume',
  SESSION_CLOSE: 'session/close',
  LOGOUT: 'logout'
};

/**
 * Agent 侧**通知**（client → agent，无响应）。
 * v1 schema：CancelNotification 的 x-method 为 session/cancel，是 notification 而非 request。
 * 误当作 request 发送会永久挂起（Agent 不会回响应）。
 */
const NOTIFICATION = {
  SESSION_CANCEL: 'session/cancel'
};

/** Client 侧 method（agent → client，需要 client 响应）。来源：v1/meta.json clientMethods（逐字）。 */
const CLIENT_METHOD = {
  SESSION_REQUEST_PERMISSION: 'session/request_permission',
  SESSION_UPDATE: 'session/update',
  FS_WRITE_TEXT_FILE: 'fs/write_text_file',
  FS_READ_TEXT_FILE: 'fs/read_text_file',
  TERMINAL_CREATE: 'terminal/create',
  TERMINAL_OUTPUT: 'terminal/output',
  TERMINAL_RELEASE: 'terminal/release',
  TERMINAL_WAIT_FOR_EXIT: 'terminal/wait_for_exit',
  TERMINAL_KILL: 'terminal/kill',
  ELICITATION_CREATE: 'elicitation/create',
  ELICITATION_COMPLETE: 'elicitation/complete'
};

/** 协议级 method。 */
const PROTOCOL_METHOD = {
  CANCEL_REQUEST: '$/cancel_request'
};

/**
 * sessionUpdate 判别字段值。来源：v1/schema.json SessionUpdate.oneOf[].properties.sessionUpdate.const。
 * v1 共 11 个变体，逐字如下（v2 的 plan_update / state_update / *_chunk 变体在 v1 **不存在**）。
 */
const SESSION_UPDATE = {
  USER_MESSAGE_CHUNK: 'user_message_chunk',
  AGENT_MESSAGE_CHUNK: 'agent_message_chunk',
  AGENT_THOUGHT_CHUNK: 'agent_thought_chunk',
  TOOL_CALL: 'tool_call',
  TOOL_CALL_UPDATE: 'tool_call_update',
  PLAN: 'plan',
  AVAILABLE_COMMANDS_UPDATE: 'available_commands_update',
  CURRENT_MODE_UPDATE: 'current_mode_update',
  CONFIG_OPTION_UPDATE: 'config_option_update',
  SESSION_INFO_UPDATE: 'session_info_update',
  USAGE_UPDATE: 'usage_update'
};

/** ToolKind（v1/schema.json ToolKind.oneOf const）。 */
const TOOL_KIND = {
  READ: 'read',
  EDIT: 'edit',
  DELETE: 'delete',
  MOVE: 'move',
  SEARCH: 'search',
  EXECUTE: 'execute',
  THINK: 'think',
  FETCH: 'fetch',
  SWITCH_MODE: 'switch_mode',
  OTHER: 'other'
};

/** ToolCallStatus（v1/schema.json ToolCallStatus.oneOf const）。 */
const TOOL_CALL_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

/** StopReason（v1/schema.json StopReason.oneOf const），PromptResponse.stopReason 必填。 */
const STOP_REASON = {
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  MAX_TURN_REQUESTS: 'max_turn_requests',
  REFUSAL: 'refusal',
  CANCELLED: 'cancelled'
};

/** PermissionOptionKind（v1/schema.json PermissionOptionKind.oneOf const）。 */
const PERMISSION_OPTION_KIND = {
  ALLOW_ONCE: 'allow_once',
  ALLOW_ALWAYS: 'allow_always',
  REJECT_ONCE: 'reject_once',
  REJECT_ALWAYS: 'reject_always'
};

/** RequestPermissionOutcome 判别值（v1/schema.json RequestPermissionOutcome.discriminator=outcome）。 */
const PERMISSION_OUTCOME = {
  CANCELLED: 'cancelled',
  SELECTED: 'selected'
};

/**
 * ACP AgentCapabilities 顶层结构键（v1/schema.json AgentCapabilities.properties）。
 * 注意 v1 里 session/new、session/prompt、session/cancel、session/update 是 **baseline**，
 * 不出现在 capabilities 里；只有可选扩展才出现在 sessionCapabilities 下。
 */
const ACP_CAPABILITY = {
  LOAD_SESSION: 'loadSession',
  PROMPT_CAPABILITIES: 'promptCapabilities',
  MCP_CAPABILITIES: 'mcpCapabilities',
  SESSION_CAPABILITIES: 'sessionCapabilities',
  AUTH: 'auth'
};

/** AgentCapabilities.sessionCapabilities 下的可选扩展键（存在即支持，`{}` 也算支持）。 */
const ACP_SESSION_CAPABILITY = {
  LIST: 'list',
  DELETE: 'delete',
  ADDITIONAL_DIRECTORIES: 'additionalDirectories',
  RESUME: 'resume',
  CLOSE: 'close'
};

/**
 * v2 常量（仅记录，当前不参与协商）。保留以便 v2 stable 后快速接线，
 * 并让"为什么我们不发 v2 形状"这件事在代码里可追溯。
 */
const V2_RECORD = Object.freeze({
  PROTOCOL_VERSION: PROTOCOL_VERSION.V2,
  SCHEMA_VERSION: '2.0.0-alpha',
  METHOD: Object.freeze({
    AUTH_LOGIN: 'auth/login',
    AUTH_LOGOUT: 'auth/logout'
  }),
  SESSION_UPDATE: Object.freeze({
    USER_MESSAGE: 'user_message',
    AGENT_MESSAGE: 'agent_message',
    AGENT_THOUGHT: 'agent_thought',
    PLAN_UPDATE: 'plan_update',
    TOOL_CALL_CONTENT_CHUNK: 'tool_call_content_chunk',
    TERMINAL_UPDATE: 'terminal_update',
    TERMINAL_OUTPUT_CHUNK: 'terminal_output_chunk',
    STATE_UPDATE: 'state_update'
  })
});

/** JSON-RPC 信封常量。 */
const JSONRPC = {
  VERSION: '2.0'
};

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  MAX_SUPPORTED_PROTOCOL_VERSION,
  METHOD,
  NOTIFICATION,
  CLIENT_METHOD,
  PROTOCOL_METHOD,
  SESSION_UPDATE,
  TOOL_KIND,
  TOOL_CALL_STATUS,
  STOP_REASON,
  PERMISSION_OPTION_KIND,
  PERMISSION_OUTCOME,
  ACP_CAPABILITY,
  ACP_SESSION_CAPABILITY,
  V2_RECORD,
  JSONRPC
};
