'use strict';
/**
 * HealthManager — 统一健康检查（有界超时 + 缓存）。
 *
 * 设计原则：
 *   - 每次检查都有超时上限（Promise.race），不会因为某个 Agent 卡住而阻塞 checkAll
 *   - 结果缓存（默认 30s TTL），避免频繁探测
 *   - 并行检查所有 Agent（bounded concurrency）
 *   - 检查完成后更新 adapter.healthStatus，供 Router / Hub 读取
 *
 * 健康状态（HEALTH_STATE）：
 *   unknown / checking / healthy / degraded / unavailable / disabled
 */
const { HEALTH_STATE } = require('./types');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 30000;
const MAX_CONCURRENCY = 8;

/**
 * 创建 HealthManager。
 * @param {object} opts
 * @param {object} opts.registry — AgentRegistry 实例
 * @param {number} [opts.timeoutMs=5000] — 单个 Agent 健康检查超时
 * @param {number} [opts.cacheTtlMs=30000] — 缓存 TTL
 * @returns {object} healthManager 实例
 */
function createHealthManager({ registry, timeoutMs = DEFAULT_TIMEOUT_MS, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
  if (!registry) throw new Error('createHealthManager: registry 必填');

  /** @type {Map<string, {status, version, latencyMs, detail, error, at}>} */
  const cache = new Map();
  /** @type {Map<string, Promise<object>>} 进行中的检查，避免重复并发 */
  const inflight = new Map();

  /**
   * 带超时执行 Promise。
   * @template T
   * @param {Promise<T>} promise
   * @param {number} ms
   * @param {string} label
   * @returns {Promise<T>}
   */
  function raceTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 健康检查超过 ${ms}ms`)), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  /** 从缓存条目中剥离 `at` 字段，返回纯结果。 */
  function stripAt(cached) {
    if (!cached) return null;
    const { at, ...rest } = cached;
    return rest;
  }

  /**
   * 检查单个 Agent 健康。
   * @param {string} agentId
   * @param {object} [opts2] { force?: boolean } — force=true 跳过缓存
   * @returns {Promise<{status: string, version: string|null, latencyMs: number, detail: string|null, error: string|null}>}
   */
  async function check(agentId, opts2 = {}) {
    const { force = false, ...context } = opts2;
    const adapter = registry.get(agentId);
    if (!adapter) {
      return { status: HEALTH_STATE.UNAVAILABLE, version: null, latencyMs: 0, detail: null, error: 'Agent 未注册' };
    }
    if (adapter.disabled) {
      const result = { status: HEALTH_STATE.DISABLED, version: null, latencyMs: 0, detail: null, error: null };
      cache.set(agentId, { ...result, at: Date.now() });
      adapter.healthStatus = HEALTH_STATE.DISABLED;
      return result;
    }

    // 缓存命中（非 force 模式）
    if (!force) {
      const cached = cache.get(agentId);
      if (cached && (Date.now() - cached.at) < cacheTtlMs) {
        return stripAt(cached);
      }
    }

    // 避免对同一 Agent 重复发起检查（非 force 模式复用 inflight）
    if (!force) {
      const existing = inflight.get(agentId);
      if (existing) return stripAt(await existing);
    }

    const promise = (async () => {
      const started = Date.now();
      adapter.healthStatus = HEALTH_STATE.CHECKING;
      try {
        const raw = await raceTimeout(
          adapter.healthCheck({ timeoutMs, ...context }),
          timeoutMs,
          adapter.id
        );
        const latencyMs = Date.now() - started;
        const status = (raw && raw.status) || HEALTH_STATE.UNKNOWN;
        const result = {
          ...(raw && typeof raw === 'object' ? raw : {}),
          status,
          version: (raw && raw.version) || null,
          latencyMs,
          detail: (raw && raw.detail) || null,
          error: (raw && raw.error) || null
        };
        cache.set(agentId, { ...result, at: Date.now() });
        adapter.healthStatus = status;
        return { ...result, at: Date.now() };
      } catch (e) {
        const latencyMs = Date.now() - started;
        const result = {
          status: HEALTH_STATE.UNAVAILABLE,
          version: null,
          latencyMs,
          detail: null,
          error: e.message
        };
        cache.set(agentId, { ...result, at: Date.now() });
        adapter.healthStatus = HEALTH_STATE.UNAVAILABLE;
        return { ...result, at: Date.now() };
      }
    })();

    inflight.set(agentId, promise);
    try {
      return stripAt(await promise);
    } finally {
      inflight.delete(agentId);
    }
  }

  /**
   * 并行检查所有 Agent（bounded concurrency）。
   * @param {object} [opts2] { force?: boolean }
   * @returns {Promise<Map<string, object>>} agentId -> health result
   */
  async function checkAll(opts2 = {}) {
    const { force = false, ...context } = opts2;
    const agents = registry.list();
    const results = new Map();

    // 分批执行，控制并发上限
    for (let i = 0; i < agents.length; i += MAX_CONCURRENCY) {
      const batch = agents.slice(i, i + MAX_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(a => check(a.id, { force, ...context }).then(r => [a.id, r]))
      );
      for (const [id, r] of batchResults) results.set(id, r);
    }
    return results;
  }

  /**
   * 获取缓存的健康状态（不触发检查）。
   * @param {string} agentId
   * @returns {object|null} 已过期或不存在返回 null
   */
  function getStatus(agentId) {
    const cached = cache.get(agentId);
    if (!cached) return null;
    if (Date.now() - cached.at >= cacheTtlMs) return null;
    return stripAt(cached);
  }

  /**
   * 使单个 Agent 的缓存失效。
   * @param {string} agentId
   */
  function invalidate(agentId) {
    cache.delete(agentId);
  }

  /**
   * 清除所有缓存。
   */
  function invalidateAll() {
    cache.clear();
  }

  return {
    check,
    checkAll,
    getStatus,
    invalidate,
    invalidateAll
  };
}

module.exports = { createHealthManager, DEFAULT_TIMEOUT_MS, DEFAULT_CACHE_TTL_MS };
