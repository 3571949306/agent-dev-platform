'use strict';
/**
 * v2.8.0 — ACP JSON-RPC 传输会话（spec §24/§94）。
 *
 * ACP 是**严格** JSON-RPC 2.0：报文必须带 "jsonrpc":"2.0"，收到不带的一律丢弃。
 * 通用信封逻辑已抽到 ../jsonRpcSession.js（Codex App Server 复用同一实现但走
 * 裸信封模式，见该文件头注释），此处只做 ACP 特化封装：
 *   - 固定 envelopeVersion = '2.0'
 *   - dispose 时 reject 带 ACP_ERROR.CANCELLED
 *
 * 与具体 I/O 解耦（便于单测）：send 由上层注入（如写 child.stdin），
 * receive 由上层喂入已解码的对象。进程管理见 acpProcessTransport，
 * ACP 业务语义见 acpClientRuntime。
 */

const { JSONRPC } = require('./constants');
const { ACP_ERROR } = require('./errors');
const { createJsonRpcSession, DEFAULT_REQUEST_TIMEOUT_MS } = require('../jsonRpcSession');

/**
 * 创建 ACP JSON-RPC 会话。
 * @param {object} opts
 * @param {Function} opts.send (serializedJsonString) => void 把消息发给 Agent
 * @param {number} [opts.requestTimeoutMs]
 */
function createAcpTransport({ send, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return createJsonRpcSession({
    send,
    envelopeVersion: JSONRPC.VERSION,
    requestTimeoutMs,
    disposeErrorCode: ACP_ERROR.CANCELLED,
    timeoutErrorCode: ACP_ERROR.TIMEOUT
  });
}

module.exports = { createAcpTransport, DEFAULT_REQUEST_TIMEOUT_MS };
