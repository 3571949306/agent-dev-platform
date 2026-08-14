'use strict';
/**
 * v2.8.0 — ACP 进程传输（spec §24/§25/§26/§27/§60/§64/§65）。
 *
 * 共用 CliProcessSupervisor 启动 ACP agent 进程，用 StructuredStreamDecoder 把
 * stdout 解码为一行行 JSON-RPC 对象，再交给纯 JSON-RPC 会话（acpTransport）。
 *
 * 职责边界：
 *   - 进程生命周期 / killTree / env allowlist / 超时 → CliProcessSupervisor
 *   - 行分帧 / UTF-8 / 帧上限 / 畸形 → StructuredStreamDecoder
 *   - JSON-RPC 信封收发分发 → acpTransport
 *   - ACP 业务语义（initialize / session / permission）→ acpClientRuntime
 *
 * 多个 ACP agent（codex-acp / claude-agent-acp / 未来）共用本传输，不各写 spawn。
 */

const { createCliProcessSupervisor } = require('../../runtime/cliProcessSupervisor');
const { createStructuredStreamDecoder } = require('../../runtime/structuredStreamDecoder');
const { createAcpTransport } = require('./acpTransport');
const { ACP_ERROR } = require('./errors');

/**
 * 创建 ACP 进程传输工厂。
 * @param {object} [opts]
 * @param {object} [opts.supervisor] 注入的 CliProcessSupervisor（单测用）
 * @param {number} [opts.frameLimitBytes] 默认帧上限
 */
function createAcpProcessTransport({ supervisor, frameLimitBytes } = {}) {
  const sup = supervisor || createCliProcessSupervisor();
  const listeners = { malformed: [], protocolError: [], exit: [] };

  function emit(name, payload) {
    for (const cb of listeners[name] || []) {
      try { cb(payload); } catch { /* listener must not break transport */ }
    }
  }

  /**
   * 启动并连接一个 ACP agent 进程。
   * @param {object} connectOpts
   * @param {string} connectOpts.command 可执行路径
   * @param {string[]} [connectOpts.args]
   * @param {string} [connectOpts.cwd]
   * @param {object} [connectOpts.env] 已 allowlist 构造好的 env
   * @param {number} [connectOpts.timeoutMs]
   * @param {number} [connectOpts.frameLimitBytes]
   * @returns {Promise<object>} transport handle
   */
  async function connect(connectOpts = {}) {
    const handle = await sup.spawnProcess({
      command: connectOpts.command,
      args: connectOpts.args || [],
      cwd: connectOpts.cwd,
      env: connectOpts.env,
      timeoutMs: connectOpts.timeoutMs,
      outputCapBytes: connectOpts.outputCapBytes,
      // stdout 是协议流，交给 StructuredStreamDecoder 增量消费；
      // 若同时让监督器把它累积成字符串，长会话会把整条协议流留在内存里。
      captureOutput: false,
      runId: connectOpts.runId || null
    });

    const decoder = createStructuredStreamDecoder({ frameLimitBytes: connectOpts.frameLimitBytes || frameLimitBytes });
    decoder.on('message', obj => { if (transport) transport.receive(obj); });
    decoder.on('malformed', info => emit('malformed', info));
    decoder.on('error', info => emit('protocolError', info));

    let cleanShutdown = false;

    handle.child.stdout.on('data', chunk => decoder.push(chunk));
    handle.child.on('close', (code, sig) => {
      if (!cleanShutdown && transport) {
        // 进程意外退出且仍有 pending 请求 → transport.dispose 会把它们以 CANCELLED 拒绝
        transport.dispose();
      }
      decoder.flush();
      // timedOut 由监督器在硬超时 kill 前打标。没有它，上层只能看到
      // "进程非正常退出" → 会把超时误判成 FAILED，违反 §67（超时 ≠ 失败）。
      emit('exit', { code, signal: sig, clean: cleanShutdown, timedOut: !!handle.timedOut });
    });

    const transport = createAcpTransport({
      send: (s) => {
        if (handle.child.stdin && !handle.child.stdin.destroyed) {
          try { handle.child.stdin.write(s + '\n'); } catch { /* pipe closed */ }
        }
      }
    });

    const api = {
      request: (m, p, o) => transport.request(m, p, o),
      notify: (m, p) => transport.notify(m, p),
      respond: (id, r) => transport.respond(id, r),
      respondError: (id, c, msg, d) => transport.respondError(id, c, msg, d),
      onNotification: (m, cb) => transport.onNotification(m, cb),
      onRequest: (m, cb) => transport.onRequest(m, cb),
      pid: () => (handle ? handle.pid : null),
      awaitExit: (timeoutMs) => handle.awaitExit(timeoutMs),
      isQuiesced: () => !!handle.exited,
      kill: (sig = 'SIGKILL') => { cleanShutdown = true; handle.kill(sig); },
      dispose: () => {
        cleanShutdown = true;
        try { decoder.flush(); } catch { /* noop */ }
        if (transport) transport.dispose();
        try { handle.kill('SIGKILL'); } catch { /* gone */ }
      },
      on: (name, cb) => { if (name in listeners) listeners[name].push(cb); return api; },
      _handle: () => handle,
      _isCorrupted: () => decoder.isCorrupted()
    };
    return api;
  }

  function dispose() {
    sup.dispose();
  }

  return { connect, dispose, ACP_ERROR };
}

module.exports = { createAcpProcessTransport };
