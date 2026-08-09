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

const BUILTIN_AGENT_MANIFESTS = [NATIVE_MAIN, CODEX, WORKBUDDY];

module.exports = {
  BUILTIN_AGENT_MANIFESTS,
  NATIVE_MAIN,
  CODEX,
  WORKBUDDY
};
