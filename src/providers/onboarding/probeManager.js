'use strict';
/**
 * v2.4.1 Smart API Onboarding — ProbeManager。
 *
 * §3-§9: 真正的 GUI Probe Cancel 机制。
 *
 * 职责：
 *   - startProbe(candidate, opts) → 立即返回 probeId，后台执行 probe()
 *   - cancelProbe(probeId) → AbortController.abort()，fetch 真正立即结束
 *   - getProbe(probeId) → 安全 diagnostics（不含 apiKey）
 *   - listActiveProbes() → 供 E2E / Advanced Diagnostics 读取
 *   - finishProbe / cleanupProbe → 生命周期清理，不残留
 *
 * §6: 生命周期 —— completed / failed / cancelled / timeout 后从 Map 清理。
 * §47: Late Result Guard —— cancel 后迟到的 result 不覆盖 cancelled 状态。
 * §48: Renderer 绑定 currentProbeId，只接受匹配的事件。
 * §50: Cancel ≠ Timeout —— cancelProbe 设 'cancelled'，timeout 设 'timeout'。
 * §43: Probe Diagnostics —— 记录 probeId/startTime/endTime/state/probeCount 等，禁止记录 apiKey。
 */
const crypto = require('crypto');
const { probe } = require('./probe');
const { sanitizeCandidate } = require('./candidate');

const PROBE_RETENTION_MS = 5000; // 终态后保留 5s 供迟到事件读取，然后清理

class ProbeManager {
  /**
   * @param {object} ctx { emit: (type, payload) => void, sec? }
   */
  constructor(ctx = {}) {
    this.probes = new Map();
    this.emit = ctx.emit || (() => {});
    this.sec = ctx.sec || null;
  }

  /**
   * 启动一个 Probe，立即返回 probeId。probe() 在后台执行。
   * §8: 不要让 probe:start 等待 Probe 完成。
   *
   * @param {object} candidate ImportCandidate
   * @param {object} opts { timeoutMs? }
   * @returns {string} probeId
   */
  startProbe(candidate, opts = {}) {
    const probeId = crypto.randomUUID();
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || 15000;

    const entry = {
      probeId,
      controller,
      startedAt: Date.now(),
      finishedAt: null,
      cancelledAt: null,
      state: 'running', // running | completed | cancelled | timeout | failed
      timeoutMs,
      // §43: 安全 diagnostics —— sanitize 后的 candidate（不含明文 apiKey）
      candidate: this.sec ? sanitizeCandidate(candidate, this.sec) : { baseUrl: candidate && candidate.baseUrl },
      probeCount: 0,
      protocolsAttempted: [],
      modelEndpointAttempted: false,
      report: null,
      error: null
    };
    this.probes.set(probeId, entry);

    // 后台执行 probe()，不阻塞 startProbe 返回
    probe(candidate, {
      signal: controller.signal,
      timeoutMs,
      probeId,
      onProgress: (info) => {
        const e = this.probes.get(probeId);
        if (!e || e.state !== 'running') return;
        e.probeCount = info.probeCount || e.probeCount;
        if (info.protocolAttempted) e.protocolsAttempted.push(info.protocolAttempted);
        if (info.modelEndpointAttempted) e.modelEndpointAttempted = true;
      }
    })
      .then(report => {
        const e = this.probes.get(probeId);
        if (!e) return; // 已被 cleanupProbe 清理
        // §47: Late Result Guard —— cancel 后迟到的 result 不覆盖 cancelled 状态
        if (e.state === 'cancelled') {
          // 用户已取消，不 emit result，只安排清理
          e.finishedAt = Date.now();
          setTimeout(() => this.probes.delete(probeId), 1000);
          return;
        }
        e.finishedAt = Date.now();
        e.report = report;
        e.state = report.state || 'completed';
        e.probeCount = report.probeCount || e.probeCount;
        // emit result 事件
        this.emit('onboarding:probe:event', {
          probeId,
          type: 'result',
          state: e.state,
          report
        });
        // §6: 终态后延迟清理
        setTimeout(() => this.probes.delete(probeId), PROBE_RETENTION_MS);
      })
      .catch(err => {
        const e = this.probes.get(probeId);
        if (!e) return;
        if (e.state === 'cancelled') {
          e.finishedAt = Date.now();
          setTimeout(() => this.probes.delete(probeId), 1000);
          return;
        }
        e.finishedAt = Date.now();
        e.state = 'failed';
        e.error = err.message || String(err);
        this.emit('onboarding:probe:event', {
          probeId,
          type: 'result',
          state: 'failed',
          error: e.error
        });
        setTimeout(() => this.probes.delete(probeId), PROBE_RETENTION_MS);
      });

    return probeId;
  }

  /**
   * 取消 Probe —— 真正 abort fetch。
   * §9: cancel 后 < 2s fetch reject，state = cancelled，cleanup。
   * §50: cancel 设 'cancelled'，不与 timeout 混淆。
   *
   * @param {string} probeId
   * @returns {boolean} 是否成功取消
   */
  cancelProbe(probeId) {
    const e = this.probes.get(probeId);
    if (!e) return false;
    if (e.state !== 'running') return false;
    e.state = 'cancelled';
    e.cancelledAt = Date.now();
    try { e.controller.abort(); } catch { /* noop */ }
    // 立即 emit cancelled 事件，不等 probe resolve
    this.emit('onboarding:probe:event', {
      probeId,
      type: 'cancelled',
      state: 'cancelled'
    });
    return true;
  }

  /**
   * 获取 Probe 安全 diagnostics（不含 apiKey）。
   * §43: 禁止记录 apiKey / Authorization / x-api-key。
   */
  getProbe(probeId) {
    const e = this.probes.get(probeId);
    if (!e) return null;
    return {
      probeId: e.probeId,
      state: e.state,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      cancelledAt: e.cancelledAt,
      timeoutMs: e.timeoutMs,
      candidate: e.candidate,
      probeCount: e.probeCount,
      protocolsAttempted: e.protocolsAttempted,
      modelEndpointAttempted: e.modelEndpointAttempted,
      error: e.error
    };
  }

  /**
   * §44: 列出所有活跃 Probe（state = running），供 E2E / Diagnostics 读取。
   */
  listActiveProbes() {
    return [...this.probes.values()]
      .filter(e => e.state === 'running')
      .map(e => ({
        probeId: e.probeId,
        startedAt: e.startedAt,
        candidate: e.candidate
      }));
  }

  /**
   * 立即清理 Probe（供测试使用）。
   */
  cleanupProbe(probeId) {
    this.probes.delete(probeId);
  }

  /**
   * 清理所有 Probe（供测试 teardown 使用）。
   */
  cleanupAll() {
    for (const [, e] of this.probes) {
      if (e.state === 'running') {
        try { e.controller.abort(); } catch { /* noop */ }
      }
    }
    this.probes.clear();
  }
}

module.exports = { ProbeManager };
