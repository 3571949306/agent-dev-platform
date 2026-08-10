'use strict';
/**
 * v2.8.0 — ACP 运行时错误码与 JSON-RPC 错误构造（spec §23/§61/§62/§65/§90）。
 *
 * 这些是与 ACP 协议层直接相关的错误码；跨 Agent 的通用错误码仍在
 * src/agents/hub/types.js 的 ERROR_CODE 中，ACP 运行时在需要时会映射过去。
 */

/** ACP 专用错误码（与 hub/types.js ERROR_CODE 互补，不重复）。 */
const ACP_ERROR = {
  PROTOCOL_UNSUPPORTED: 'ACP_PROTOCOL_UNSUPPORTED',
  HANDSHAKE_FAILED: 'ACP_HANDSHAKE_FAILED',
  CAPABILITY_NEGOTIATION_FAILED: 'ACP_CAPABILITY_NEGOTIATION_FAILED',
  FRAME_TOO_LARGE: 'ACP_FRAME_TOO_LARGE',
  MALFORMED_MESSAGE: 'ACP_MALFORMED_MESSAGE',
  SESSION_CREATE_FAILED: 'ACP_SESSION_CREATE_FAILED',
  PROMPT_FAILED: 'ACP_PROMPT_FAILED',
  PERMISSION_DENIED: 'ACP_PERMISSION_DENIED',
  PERMISSION_REQUEST_FAILED: 'ACP_PERMISSION_REQUEST_FAILED',
  PROCESS_CRASHED: 'ACP_PROCESS_CRASHED',
  PROCESS_SPAWN_FAILED: 'ACP_PROCESS_SPAWN_FAILED',
  AUTH_REQUIRED: 'ACP_AUTH_REQUIRED',
  AUTH_FAILED: 'ACP_AUTH_FAILED',
  RESUME_UNSUPPORTED: 'ACP_RESUME_UNSUPPORTED',
  TIMEOUT: 'ACP_TIMEOUT',
  CANCELLED: 'ACP_CANCELLED',
  UNEXPECTED_EXIT: 'ACP_UNEXPECTED_EXIT',
  PROTOCOL_ERROR: 'ACP_PROTOCOL_ERROR'
};

/** JSON-RPC 标准错误码（与 ACP 一致）。 */
const JSONRPC_ERROR_CODE = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
};

class AcpError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.name = 'AcpError';
    this.code = code;
    this.data = data;
  }
}

/** 构造 JSON-RPC 2.0 error 对象。 */
function jsonRpcError(code, message, data = null) {
  const err = { code, message };
  if (data !== null && data !== undefined) err.data = data;
  return err;
}

/** 构造 JSON-RPC 2.0 error 响应。 */
function jsonRpcErrorResponse(id, code, message, data = null) {
  return {
    jsonrpc: '2.0',
    id,
    error: jsonRpcError(code, message, data)
  };
}

module.exports = {
  ACP_ERROR,
  JSONRPC_ERROR_CODE,
  AcpError,
  jsonRpcError,
  jsonRpcErrorResponse
};
