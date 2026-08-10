'use strict';
/**
 * v2.8.0 — 结构化流解码器（spec §60/§61/§62/§126）。
 *
 * 把外部 Agent 的 stdout 解码为结构化消息：
 *   - 支持 JSONL / NDJSON（按行分帧）
 *   - UTF-8 多字节跨 chunk 安全拼接（StringDecoder）
 *   - CRLF / LF 兼容
 *   - 单帧大小上限（默认 4 MiB）→ AGENT_PROTOCOL_FRAME_TOO_LARGE
 *   - 畸形消息：单条 warning；连续达到阈值 → AGENT_PROTOCOL_ERROR（不 crash 宿主）
 *
 * 设计为纯函数式、可注入，便于单测（无需真实子进程）。
 */

const { StringDecoder } = require('string_decoder');

const DEFAULT_FRAME_LIMIT_BYTES = 4 * 1024 * 1024; // 4 MiB
const DEFAULT_MALFORMED_THRESHOLD = 10;

/**
 * 创建结构化流解码器。
 * @param {object} [opts]
 * @param {number} [opts.frameLimitBytes=4MiB] 单帧字节上限
 * @param {number} [opts.malformedThreshold=10] 连续畸形达到此值触发 protocol error
 */
function createStructuredStreamDecoder(opts = {}) {
  const frameLimitBytes = Number(opts.frameLimitBytes) || DEFAULT_FRAME_LIMIT_BYTES;
  const malformedThreshold = Number(opts.malformedThreshold) || DEFAULT_MALFORMED_THRESHOLD;

  const decoder = new StringDecoder('utf8');
  let pending = '';
  let consecutiveMalformed = 0;
  let corrupted = false;

  const handlers = {
    message: null,
    malformed: null,
    error: null
  };

  function emit(name, payload) {
    const h = handlers[name];
    if (typeof h === 'function') {
      try { h(payload); } catch { /* listener must not break the decoder */ }
    }
  }

  /** 吞下尚未结束的半行（在 dispose / 流结束时调用，避免丢最后一行）。 */
  function flush() {
    if (pending.length) {
      const line = pending;
      pending = '';
      processLine(line);
    }
  }

  /** 处理一行（可能为空）。 */
  function processLine(rawLine) {
    if (corrupted) return;
    // 去掉 CRLF 的 \r
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) return; // 空行忽略

    const byteLen = Buffer.byteLength(line, 'utf8');
    if (byteLen > frameLimitBytes) {
      consecutiveMalformed++;
      emit('malformed', {
        error: 'FRAME_TOO_LARGE',
        byteLength: byteLen,
        limit: frameLimitBytes,
        preview: line.slice(0, 200)
      });
      checkThreshold();
      return;
    }

    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      consecutiveMalformed++;
      emit('malformed', {
        error: 'INVALID_JSON',
        message: e.message,
        preview: line.slice(0, 200)
      });
      checkThreshold();
      return;
    }

    consecutiveMalformed = 0;
    emit('message', obj);
  }

  function checkThreshold() {
    if (consecutiveMalformed >= malformedThreshold) {
      corrupted = true;
      emit('error', {
        code: 'AGENT_PROTOCOL_ERROR',
        reason: 'MALFORMED_STREAM',
        consecutiveMalformed
      });
    }
  }

  return {
    /** 喂入原始 chunk（Buffer 或 string）。 */
    push(chunk) {
      if (corrupted) return;
      const text = decoder.write(chunk);
      pending += text;
      let idx;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        processLine(line);
        if (corrupted) { pending = ''; return; }
      }
    },
    flush,
    /** 注册回调：onMessage(obj), onMalformed(info), onError(info)。 */
    on(name, cb) {
      if (name in handlers) handlers[name] = cb;
      return this;
    },
    /** 重置内部状态（复用实例时）。 */
    reset() {
      pending = '';
      consecutiveMalformed = 0;
      corrupted = false;
      return this;
    },
    isCorrupted() { return corrupted; },
    pendingBytes() { return Buffer.byteLength(pending, 'utf8'); }
  };
}

module.exports = {
  createStructuredStreamDecoder,
  DEFAULT_FRAME_LIMIT_BYTES,
  DEFAULT_MALFORMED_THRESHOLD
};
