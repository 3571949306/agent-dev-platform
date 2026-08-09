'use strict';
/**
 * AgentRegistry — Agent Provider 运行时状态的唯一真相源。
 *
 * 职责：
 *   - 维护已注册 adapter 的 Map（运行时状态，非持久化）
 *   - 提供查询 / 过滤 / 检测接口
 *   - 不拥有 SQLite — 持久化是 store 的职责
 *
 * Registry 只管运行时状态：哪些 adapter 已注册、是否可用、支持哪些能力。
 * 配置数据（adapter 配置、启用/禁用偏好）由 store 管理，通过 manifest 注入。
 */

/**
 * 创建 AgentRegistry。
 * @param {object} [opts] — 预留扩展（当前无必填项）
 * @returns {object} registry 实例
 */
function createAgentRegistry(opts = {}) {
  /** @type {Map<string, object>} id -> adapter */
  const adapters = new Map();
  /** @type {Map<string, object>} id -> { available, version, path, at } */
  const detection = new Map();

  /**
   * 注册一个 adapter。重复注册会覆盖旧实例。
   * @param {object} adapter — 必须有 id
   * @returns {object} adapter
   */
  function register(adapter) {
    if (!adapter || !adapter.id) throw new Error('register: adapter.id 必填');
    adapters.set(adapter.id, adapter);
    return adapter;
  }

  /**
   * 注销 adapter。
   * @param {string} id
   * @returns {boolean} 是否存在并已移除
   */
  function unregister(id) {
    detection.delete(id);
    return adapters.delete(id);
  }

  /**
   * 按 id 获取 adapter。
   * @param {string} id
   * @returns {object|null}
   */
  function get(id) {
    return adapters.get(id) || null;
  }

  /**
   * 列出所有已注册 adapter。
   * @returns {object[]}
   */
  function list() {
    return [...adapters.values()];
  }

  /**
   * 列出可用 adapter（已检测为可用 + 未禁用）。
   * 未执行 detectAll 时不返回任何 adapter（除非 adapter 自身标记 available=true）。
   * @returns {object[]}
   */
  function listAvailable() {
    return list().filter(a => {
      if (a.disabled) return false;
      const det = detection.get(a.id);
      if (det) return det.available !== false;
      // adapter 未被 detect 过，但自身声明可用（如 native adapter）
      return a.available === true;
    });
  }

  /**
   * 对所有 adapter 执行 detect()，返回检测结果 Map。
   * 并行执行，单个 adapter 失败不影响其他。
   * @returns {Promise<Map<string, {available, version, path}>>}
   */
  async function detectAll() {
    const entries = list();
    await Promise.all(entries.map(async (adapter) => {
      try {
        const r = await adapter.detect();
        const result = {
          available: !!(r && r.available),
          version: (r && r.version) || null,
          path: (r && r.path) || null
        };
        detection.set(adapter.id, { ...result, at: Date.now() });
      } catch (e) {
        detection.set(adapter.id, {
          available: false, version: null, path: null,
          error: e.message, at: Date.now()
        });
      }
    }));
    return new Map(detection);
  }

  /**
   * 按 required / preferred 能力过滤 adapter。
   * 只检查 required（必须全部满足）；preferred 不影响过滤，仅用于排序参考。
   * @param {string[]} [required=[]]
   * @param {string[]} [preferred=[]]
   * @returns {object[]}
   */
  function getByCapability(required = [], preferred = []) {
    const req = Array.isArray(required) ? required : [];
    if (!req.length) return list();
    return list().filter(a => {
      const caps = new Set(a.capabilities || []);
      return req.every(c => caps.has(c));
    });
  }

  /**
   * 获取所有已注册 adapter 的 manifest。
   * @returns {object[]}
   */
  function getManifests() {
    return list().map(a => a.manifest).filter(Boolean);
  }

  return {
    register,
    unregister,
    get,
    list,
    listAvailable,
    detectAll,
    getByCapability,
    getManifests
  };
}

module.exports = { createAgentRegistry };
