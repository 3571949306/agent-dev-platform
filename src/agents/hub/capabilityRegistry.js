'use strict';
/**
 * v2.6.0 Agent Integration Hub — 统一能力系统（spec §4.2）。
 *
 * 不同 Agent 的能力描述各异（Native 内置全套、Codex CLI 偏编码、
 * WorkBuddy 偏 Computer Use），Hub 用一套规范化的能力键做匹配，
 * 路由器据此为任务挑选合适 Agent，而非硬编码 agent id。
 *
 * 能力键约定：值为 true 表示该 Agent 声明支持此能力；
 * 缺省 / false 表示不支持。match() 只做布尔判定，不衡量强弱。
 */

/**
 * 规范化能力键。新增 Agent 能力时在此登记，避免散落字符串。
 *   coding        — 代码生成 / 编辑 / 重构
 *   planning      — 任务分解 / 执行计划
 *   research      — 检索 / 调研 / 阅读
 *   review        — 代码审查 / 评估
 *   filesystem    — 文件读写
 *   terminal      — 命令行执行
 *   git           — git 操作
 *   browser       — 浏览器自动化
 *   computer      — Computer Use（键鼠 / 桌面操作）
 *   vision        — 视觉 / 截图理解
 *   mcp           — MCP 工具接入
 *   longRunning   — 支持长时运行任务
 *   parallel      — 支持并行子任务
 *   streaming     — 支持流式输出
 *   resume        — 支持断点续跑
 *   diff          — 产出结构化 diff
 *   sandbox       — 沙箱隔离执行
 */
const CAPABILITIES = {
  CODING: 'coding',
  PLANNING: 'planning',
  RESEARCH: 'research',
  REVIEW: 'review',
  FILESYSTEM: 'filesystem',
  TERMINAL: 'terminal',
  GIT: 'git',
  BROWSER: 'browser',
  COMPUTER: 'computer',
  VISION: 'vision',
  MCP: 'mcp',
  LONG_RUNNING: 'longRunning',
  PARALLEL: 'parallel',
  STREAMING: 'streaming',
  RESUME: 'resume',
  DIFF: 'diff',
  SANDBOX: 'sandbox'
};

/** 全部合法能力键（值数组）。 */
const ALL_CAPABILITIES = Object.values(CAPABILITIES);

/**
 * 创建一个能力注册表实例。
 * 注册表本身无状态，封装能力集合的查询与匹配逻辑。
 * @returns {{ all: () => string[], has: (cap: string) => boolean, match: (agentCaps: object, required?: string[], preferred?: string[]) => { matched: string[], missing: string[], preferredMatched: string[] } }}
 */
function createCapabilityRegistry() {
  const valid = new Set(ALL_CAPABILITIES);

  return {
    /** 返回全部能力键。 */
    all() {
      return ALL_CAPABILITIES.slice();
    },

    /** 判断 cap 是否为合法能力键。 */
    has(cap) {
      return valid.has(cap);
    },

    /**
     * 将 Agent 声明的能力与任务需求做匹配。
     * @param {object} agentCaps   Agent manifest.capabilities（键 → boolean）
     * @param {string[]} [required]  必须满足的能力；缺失即视为不匹配
     * @param {string[]} [preferred] 优选能力；缺失不影响匹配，仅用于排序 / 打分
     * @returns {{ matched: string[], missing: string[], preferredMatched: string[] }}
     *   matched           — agent 实际支持的 required 能力
     *   missing           — agent 不支持的 required 能力（非空表示不满足）
     *   preferredMatched  — agent 实际支持的 preferred 能力
     */
    match(agentCaps, required = [], preferred = []) {
      const caps = agentCaps || {};
      const matched = [];
      const missing = [];

      for (const cap of required) {
        if (caps[cap] === true) {
          matched.push(cap);
        } else {
          missing.push(cap);
        }
      }

      const preferredMatched = [];
      for (const cap of preferred) {
        if (caps[cap] === true) {
          preferredMatched.push(cap);
        }
      }

      return { matched, missing, preferredMatched };
    }
  };
}

module.exports = {
  CAPABILITIES,
  createCapabilityRegistry
};
