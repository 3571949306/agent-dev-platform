'use strict';
/**
 * v2.6.0 Agent Integration Hub — 内置 Agent manifest 定义（spec §4.1）。
 *
 * manifest 是 Agent 的静态描述：身份、接入通道、能力、并发上限等。
 * Hub 启动时加载本表，再由各 Adapter 的 detect() / healthCheck()
 * 在运行时回填 availability / version / 实际可用性。
 *
 * 字段：
 *   id             — 全局唯一 agent id
 *   displayName    — 展示名
 *   source         — 'native'（平台内置）/ 'external'（外部接入）
 *   transport      — 接入通道（见 hub/types.js TRANSPORT）
 *   capabilities   — 能力声明（键 → boolean，见 hub/capabilityRegistry.js）
 *   availability   — 静态可用性初值；运行时由 detect() 更新
 *   version        — 已知版本；未知为 null
 *   path           — 可执行路径 / 命令名；内置 / 未知为 null
 *   maxConcurrency — 最大并发 Run 数
 */

/** Native 主智能体：平台内置，编码 / 计划 / 终端 / git 全套，非沙箱。 */
const NATIVE_MAIN = {
  id: 'native-main',
  displayName: '主智能体',
  source: 'native',
  transport: 'native',
  capabilities: {
    coding: true,
    planning: true,
    research: true,
    review: true,
    filesystem: true,
    terminal: true,
    git: true,
    longRunning: true,
    streaming: true,
    diff: true,
    sandbox: false
  },
  availability: true,
  version: '2.6.0',
  path: null,
  maxConcurrency: 3
};

/** Codex：外部 CLI Agent，编码 / 终端 / git，支持并行与沙箱，不支持 resume。 */
const CODEX = {
  id: 'codex',
  displayName: 'Codex',
  source: 'external',
  transport: 'cli',
  capabilities: {
    coding: true,
    filesystem: true,
    terminal: true,
    git: true,
    longRunning: true,
    parallel: true,
    streaming: true,
    diff: true,
    resume: false,
    sandbox: true
  },
  availability: false,
  version: null,
  path: 'codex',
  maxConcurrency: 2
};

/** WorkBuddy：外部桌面端 Agent，Computer Use / 视觉，单并发，非流式非沙箱。 */
const WORKBUDDY = {
  id: 'workbuddy',
  displayName: 'WorkBuddy',
  source: 'external',
  transport: 'desktop',
  capabilities: {
    coding: true,
    computer: true,
    vision: true,
    longRunning: true,
    streaming: false,
    sandbox: false
  },
  availability: false,
  version: null,
  path: null,
  maxConcurrency: 1
};

/** Cline：外部 SDK Agent（@cline/sdk，ESM-only），编码 / 文件系统 / 终端 / MCP / 计划，支持流式与 resume，非沙箱。 */
const CLINE = {
  id: 'cline',
  displayName: 'Cline',
  source: 'external',
  transport: 'protocol',
  capabilities: {
    coding: true,
    planning: true,
    research: true,
    review: true,
    filesystem: true,
    terminal: true,
    git: false,
    browser: false,
    computer: false,
    vision: false,
    mcp: true,
    longRunning: true,
    parallel: false,
    streaming: true,
    resume: true,
    diff: true,
    sandbox: false
  },
  availability: false,
  version: null,
  path: 'cline-runtime',
  maxConcurrency: 1
};

/**
 * OpenCode：外部 HTTP Agent（opencode serve）。
 * 编码 / 计划 / 研究 / 审查 / 终端 / git / 长任务 / 流式 / diff；非沙箱。
 * 由本地受管 server（127.0.0.1）+ Basic Auth 接入，maxConcurrency=2。
 */
const OPENCODE = {
  id: 'opencode',
  displayName: 'OpenCode',
  source: 'external',
  transport: 'http',
  capabilities: {
    coding: true,
    planning: true,
    research: true,
    review: true,
    filesystem: true,
    terminal: true,
    git: true,
    browser: false,
    computer: false,
    vision: false,
    mcp: false,
    longRunning: true,
    parallel: false,
    streaming: true,
    resume: false,
    diff: true,
    sandbox: false
  },
  availability: false,
  version: null,
  path: 'opencode',
  maxConcurrency: 2
};

/**
 * OpenHands：外部 HTTP Agent（FastAPI Agent Server）。
 * 编码 / 计划 / 研究 / 审查 / 终端 / 浏览器 / 长任务 / 流式 / diff；沙箱。
 * 不自动安装；maxConcurrency=1。
 */
const OPENHANDS = {
  id: 'openhands',
  displayName: 'OpenHands',
  source: 'external',
  transport: 'http',
  capabilities: {
    coding: true,
    planning: true,
    research: true,
    review: true,
    filesystem: true,
    terminal: true,
    git: false,
    browser: true,
    computer: false,
    vision: false,
    mcp: false,
    longRunning: true,
    parallel: false,
    streaming: true,
    resume: false,
    diff: true,
    sandbox: true
  },
  availability: false,
  version: null,
  path: 'openhands-agent-server',
  maxConcurrency: 1
};

/**
 * Claude Code：外部 Agent，v2.8.0 新增（spec §49/§50/§53）。
 *
 * transport 记为 'protocol' —— 因为 production primary 是
 * @anthropic-ai/claude-agent-sdk 的 query()（进程内 SDK，不是裸 CLI 文本），
 * CLI（claude -p --output-format stream-json）只是同 schema 的 fallback。
 *
 * capabilities 是**静态保守初值**：适配器会按实际生效的运行时
 * （sdk / cli / acp）动态回填（见 claudeCodeAgentAdapter 的 RUNTIME_CAPABILITIES，spec §45）。
 * 这里 approval/resume 取"至少 CLI 也能满足"的口径，避免未探测前就吹能力。
 */
const CLAUDE_CODE = {
  id: 'claude-code',
  displayName: 'Claude Code',
  source: 'external',
  transport: 'protocol',
  capabilities: {
    coding: true,
    planning: true,
    research: true,
    review: false,
    filesystem: true,
    terminal: true,
    git: true,
    browser: false,
    computer: false,
    vision: false,
    mcp: true,
    longRunning: true,
    parallel: false,
    streaming: true,
    resume: true,
    diff: true,
    sandbox: false
  },
  availability: false,
  version: null,
  path: 'claude',
  maxConcurrency: 2
};

const BUILTIN_AGENT_MANIFESTS = [NATIVE_MAIN, CODEX, WORKBUDDY, CLINE, OPENCODE, OPENHANDS, CLAUDE_CODE];

module.exports = {
  BUILTIN_AGENT_MANIFESTS,
  NATIVE_MAIN,
  CODEX,
  WORKBUDDY,
  CLINE,
  OPENCODE,
  OPENHANDS,
  CLAUDE_CODE
};
