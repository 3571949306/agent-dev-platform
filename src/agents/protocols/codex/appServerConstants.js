'use strict';
/**
 * v2.8.0 — Codex App Server 线协议常量（spec §10/§42/§43/§44）。
 *
 * 唯一真相源：openai/codex @ 21aa552e
 *   codex-rs/app-server-protocol/src/protocol/common.rs  （方法/通知注册宏）
 *   codex-rs/app-server-protocol/src/protocol/v1.rs      （initialize）
 *   codex-rs/app-server-protocol/src/protocol/v2/*.rs    （thread / turn / item）
 *
 * ⚠️ 两个必须记住的上游事实（不是我们的设计选择，是上游行为）：
 *
 * 1) App Server **不是** 标准 JSON-RPC 2.0。
 *    rpc.rs:1-2 原文：
 *      "We do not do true JSON-RPC 2.0, as we neither send nor expect
 *       the \"jsonrpc\": \"2.0\" field."
 *    → 发送必须删掉 jsonrpc 字段；接收也不会有该字段。
 *    → 帧格式是换行分隔 JSON（app-server-transport/src/transport/stdio.rs:46 `reader.lines()`），
 *      不是 LSP 的 Content-Length 头。
 *
 * 2) initialize 响应里 **没有 protocolVersion**（v1.rs:70-80 只有 userAgent /
 *    codexHome / platformFamily / platformOs）→ 无法做数字版本协商。
 *    我们只能：pin codex 版本 + 启动时做方法探测（见 codexAppServerClient.probeMethods）。
 *
 * 线上字段一律 camelCase（各 struct 上 `#[serde(rename_all = "camelCase")]`）。
 */

/** 客户端 → 服务端 请求方法（只列本平台实际使用的子集；上游共 137 个）。 */
const METHOD = {
  INITIALIZE: 'initialize',

  THREAD_START: 'thread/start',
  THREAD_RESUME: 'thread/resume',
  THREAD_LIST: 'thread/list',
  THREAD_READ: 'thread/read',

  TURN_START: 'turn/start',
  TURN_INTERRUPT: 'turn/interrupt',
  TURN_STEER: 'turn/steer',

  REVIEW_START: 'review/start',

  GIT_DIFF_TO_REMOTE: 'gitDiffToRemote',
  GET_AUTH_STATUS: 'getAuthStatus'
};

/** 客户端 → 服务端 通知（common.rs:1816，仅一个）。 */
const CLIENT_NOTIFICATION = {
  INITIALIZED: 'initialized'
};

/** 服务端 → 客户端 通知（事件流）。common.rs:1692 起。 */
const NOTIFICATION = {
  THREAD_STARTED: 'thread/started',
  TURN_STARTED: 'turn/started',
  TURN_COMPLETED: 'turn/completed',
  TURN_DIFF_UPDATED: 'turn/diff/updated',
  TURN_PLAN_UPDATED: 'turn/plan/updated',
  ITEM_STARTED: 'item/started',
  ITEM_COMPLETED: 'item/completed',
  AGENT_MESSAGE_DELTA: 'item/agentMessage/delta',
  COMMAND_OUTPUT_DELTA: 'item/commandExecution/outputDelta'
};

/** 服务端 → 客户端 请求（需要我们回响应）。common.rs:1537 起。 */
const SERVER_REQUEST = {
  COMMAND_EXECUTION_REQUEST_APPROVAL: 'item/commandExecution/requestApproval',
  FILE_CHANGE_REQUEST_APPROVAL: 'item/fileChange/requestApproval',
  PERMISSIONS_REQUEST_APPROVAL: 'item/permissions/requestApproval',
  TOOL_REQUEST_USER_INPUT: 'item/tool/requestUserInput'
};

/**
 * 命令执行审批决策（v2/item.rs:59-78，camelCase）。
 * 注意：我们**只使用** accept / decline，绝不使用 acceptForSession —— 那等于
 * 把后续同类命令永久自动放行，违反 spec §36「不得自动批准危险命令」。
 */
const COMMAND_APPROVAL_DECISION = {
  ACCEPT: 'accept',
  DECLINE: 'decline',
  CANCEL: 'cancel'
};

/** 文件变更审批决策（v2/item.rs:105-114）。同样不使用 acceptForSession。 */
const FILE_CHANGE_APPROVAL_DECISION = {
  ACCEPT: 'accept',
  DECLINE: 'decline',
  CANCEL: 'cancel'
};

/** Turn 终态（v2/turn.rs:30-35，camelCase）。 */
const TURN_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  FAILED: 'failed',
  IN_PROGRESS: 'inProgress'
};

/**
 * ThreadItem 判别值（v2/item.rs，`#[serde(tag="type")]`）。
 * 与 `codex exec --json` 的 ThreadItemDetails（snake_case）不同，App Server 侧是 camelCase。
 */
const ITEM_TYPE = {
  AGENT_MESSAGE: 'agentMessage',
  REASONING: 'reasoning',
  COMMAND_EXECUTION: 'commandExecution',
  FILE_CHANGE: 'fileChange',
  MCP_TOOL_CALL: 'mcpToolCall',
  WEB_SEARCH: 'webSearch',
  TODO_LIST: 'todoList',
  ERROR: 'error'
};

/** UserInput 判别值（v2/turn.rs:289-292，`#[serde(tag="type", rename_all="camelCase")]`）。 */
const USER_INPUT_TYPE = {
  TEXT: 'text',
  IMAGE: 'image',
  LOCAL_IMAGE: 'localImage'
};

/**
 * `codex exec --json` 的事件类型（exec/src/exec_events.rs:9-37）。
 * 注意这里是 **点号分隔的 snake 风格**，与 App Server 的斜杠路径不同，别混用。
 */
const EXEC_EVENT = {
  THREAD_STARTED: 'thread.started',
  TURN_STARTED: 'turn.started',
  TURN_COMPLETED: 'turn.completed',
  TURN_FAILED: 'turn.failed',
  ITEM_STARTED: 'item.started',
  ITEM_UPDATED: 'item.updated',
  ITEM_COMPLETED: 'item.completed',
  ERROR: 'error'
};

/** `codex exec --json` 的 item 判别值（exec_events.rs:105-133，snake_case）。 */
const EXEC_ITEM_TYPE = {
  AGENT_MESSAGE: 'agent_message',
  REASONING: 'reasoning',
  COMMAND_EXECUTION: 'command_execution',
  FILE_CHANGE: 'file_change',
  MCP_TOOL_CALL: 'mcp_tool_call',
  COLLAB_TOOL_CALL: 'collab_tool_call',
  WEB_SEARCH: 'web_search',
  TODO_LIST: 'todo_list',
  ERROR: 'error'
};

/** 本平台声明的客户端信息（initialize.clientInfo，v1.rs:36-41）。 */
const CLIENT_INFO = {
  name: 'agent-dev-platform',
  title: 'Agent Dev Platform',
  version: '2.8.0'
};

module.exports = {
  METHOD,
  CLIENT_NOTIFICATION,
  NOTIFICATION,
  SERVER_REQUEST,
  COMMAND_APPROVAL_DECISION,
  FILE_CHANGE_APPROVAL_DECISION,
  TURN_STATUS,
  ITEM_TYPE,
  USER_INPUT_TYPE,
  EXEC_EVENT,
  EXEC_ITEM_TYPE,
  CLIENT_INFO
};
