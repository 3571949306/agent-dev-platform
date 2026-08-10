'use strict';
/**
 * AgentRouter — 确定性评分路由器（可解释，无 LLM）。
 *
 * 路由 = 能力匹配 + 可用性 + 健康 + 负载 + 用户偏好 + 防环。
 * 每个候选返回 score + reasons[] + penalties[]，便于 UI 展示"为什么选了这个 Agent"。
 *
 * 硬排除规则：
 *   - adapter.disabled === true 或 preferences.disabledAgents 包含 → 不进入结果
 *   - agentId 出现在 delegationPath → 不进入结果（防止委托环路）
 *
 * 评分因子（确定性，无随机）：
 *   必需能力匹配 +40 / 缺失 -100
 *   偏好能力匹配 +10
 *   可用性：healthy +20 / degraded +5 / unavailable -200 / disabled -500
 *   健康加分：healthy +10 / degraded +0
 *   负载达上限 -30
 *   用户偏好 Agent +50
 *   手动指定 +1000
 */
const { HEALTH_STATE } = require('./types');

/** 评分权重常量（导出供测试 / 文档参考） */
const SCORES = {
  REQUIRED_MATCH: 40,
  REQUIRED_MISSING: -100,
  PREFERRED_MATCH: 10,
  HEALTHY_AVAIL: 20,
  DEGRADED_AVAIL: 5,
  UNAVAILABLE_AVAIL: -200,
  DISABLED_AVAIL: -500,
  HEALTHY_BONUS: 10,
  DEGRADED_BONUS: 0,
  BUSY_PENALTY: -30,
  PREFERRED_AGENT: 50,
  DELEGATION_LOOP: -1000,
  MANUAL_OVERRIDE: 1000
};

/**
 * 创建 AgentRouter。
 * @param {object} opts
 * @param {object} opts.registry — AgentRegistry 实例
 * @param {object} [opts.preferences] — { preferredAgent?: string, disabledAgents?: string[] }
 * @returns {{ route: (task: object) => Array<{agentId: string, score: number, reasons: string[], penalties: string[]}> }}
 */
function createAgentRouter({ registry, preferences = {} } = {}) {
  if (!registry) throw new Error('createAgentRouter: registry 必填');

  const disabledSet = new Set(preferences.disabledAgents || []);
  const preferredAgent = preferences.preferredAgent || null;

  /**
   * 路由：为 task 计算所有候选 Agent 的得分并排序。
   * @param {object} [task]
   * @param {string[]} [task.required] — 必需能力
   * @param {string[]} [task.preferred] — 偏好能力
   * @param {string|null} [task.agentId] — 手动指定 Agent id
   * @param {string[]} [task.delegationPath] — 委托路径（防环）
   * @returns {Array<{agentId: string, score: number, reasons: string[], penalties: string[]}>}
   *   按得分降序排列
   */
  function route(task = {}) {
    const required = Array.isArray(task.required) ? task.required : [];
    const preferred = Array.isArray(task.preferred) ? task.preferred : [];
    const agentIdOverride = task.agentId || null;
    const delegationPath = Array.isArray(task.delegationPath) ? task.delegationPath : [];

    // 硬排除：禁用 + 委托路径中的 Agent
    const candidates = registry.list().filter(a => {
      if (a.disabled) return false;
      if (disabledSet.has(a.id)) return false;
      if (delegationPath.includes(a.id)) return false;
      // The bundled runtime may be installed while API/workspace readiness is
      // still incomplete. Only a fully healthy Cline can be auto-routed.
      // An explicit override may still surface the concrete config error.
      if (a.id === 'cline' && a.healthStatus !== HEALTH_STATE.HEALTHY && agentIdOverride !== 'cline') return false;
      return true;
    });

    const results = candidates.map(adapter => {
      const reasons = [];
      const penalties = [];
      let score = 0;

      // 1. 能力匹配
      const caps = new Set(adapter.capabilities || []);
      for (const cap of required) {
        if (caps.has(cap)) {
          score += SCORES.REQUIRED_MATCH;
          reasons.push(`必需能力 ${cap} 匹配 (+${SCORES.REQUIRED_MATCH})`);
        } else {
          score += SCORES.REQUIRED_MISSING;
          penalties.push(`缺少必需能力 ${cap} (${SCORES.REQUIRED_MISSING})`);
        }
      }
      for (const cap of preferred) {
        if (caps.has(cap)) {
          score += SCORES.PREFERRED_MATCH;
          reasons.push(`偏好能力 ${cap} 匹配 (+${SCORES.PREFERRED_MATCH})`);
        }
      }

      // 2. 可用性（基于健康状态，由 HealthManager 写入 adapter.healthStatus）
      const healthStatus = adapter.healthStatus || HEALTH_STATE.UNKNOWN;
      switch (healthStatus) {
        case HEALTH_STATE.HEALTHY:
          score += SCORES.HEALTHY_AVAIL;
          reasons.push(`健康可用 (+${SCORES.HEALTHY_AVAIL})`);
          break;
        case HEALTH_STATE.DEGRADED:
          score += SCORES.DEGRADED_AVAIL;
          reasons.push(`降级可用 (+${SCORES.DEGRADED_AVAIL})`);
          break;
        case HEALTH_STATE.UNAVAILABLE:
          score += SCORES.UNAVAILABLE_AVAIL;
          penalties.push(`不可用 (${SCORES.UNAVAILABLE_AVAIL})`);
          break;
        case HEALTH_STATE.DISABLED:
          score += SCORES.DISABLED_AVAIL;
          penalties.push(`健康状态为已禁用 (${SCORES.DISABLED_AVAIL})`);
          break;
        default:
          // unknown / checking — 不加分也不扣分
          break;
      }

      // 3. 健康加分（与可用性分开计分，鼓励保持健康）
      if (healthStatus === HEALTH_STATE.HEALTHY) {
        score += SCORES.HEALTHY_BONUS;
        reasons.push(`健康加分 (+${SCORES.HEALTHY_BONUS})`);
      }

      // 4. 负载：达到最大并发则扣分
      const maxConcurrency = adapter.maxConcurrency != null ? adapter.maxConcurrency : 1;
      const activeCount = adapter.activeRunCount || 0;
      if (activeCount >= maxConcurrency) {
        score += SCORES.BUSY_PENALTY;
        penalties.push(`已达最大并发 ${maxConcurrency} (${SCORES.BUSY_PENALTY})`);
      }

      // 5. 用户偏好
      if (preferredAgent && adapter.id === preferredAgent) {
        score += SCORES.PREFERRED_AGENT;
        reasons.push(`用户偏好 Agent (+${SCORES.PREFERRED_AGENT})`);
      }

      // 6. 手动指定
      if (agentIdOverride && adapter.id === agentIdOverride) {
        score += SCORES.MANUAL_OVERRIDE;
        reasons.push(`手动指定 (+${SCORES.MANUAL_OVERRIDE})`);
      }

      return { agentId: adapter.id, score, reasons, penalties };
    });

    // 按得分降序排序（稳定排序：同分保持注册顺序）
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  return { route };
}

module.exports = { createAgentRouter, SCORES };
