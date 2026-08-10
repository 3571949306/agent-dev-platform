'use strict';
/**
 * v2.6.0 Agent Integration Hub — 类型常量与错误码（spec §4）。
 *
 * Hub 统一管理多 Agent（Native / Codex / WorkBuddy / MCP / 外部）的接入、
 * 健康检查、能力匹配与任务路由。本文件定义跨 Agent 共享的类型常量，
 * 避免在路由 / 适配器 / 事件层之间靠裸字符串约定语义。
 *
 * 分组：
 *   TRANSPORT      — Agent 接入通道
 *   HEALTH_STATE   — Agent 健康状态（detect / healthCheck 产出）
 *   LIFECYCLE      — 单次 Run 的生命周期状态
 *   ERROR_CODE     — Hub 路由 / 调度错误码
 *   AGENT_EVENT    — 统一 Agent 事件类型（GUI Timeline / Chat 渲染依据）
 */

/** Agent 接入通道。决定走哪个 Adapter 实现。 */
const TRANSPORT = {
  NATIVE: 'native',     // 平台内置主智能体（同进程 / IPC）
  SDK: 'sdk',           // 官方 SDK 接入（in-process）
  HTTP: 'http',         // HTTP / REST API
  CLI: 'cli',           // 命令行进程（codex 等）
  PROTOCOL: 'protocol', // 自定义协议 / 长连接
  DESKTOP: 'desktop'    // 桌面端应用桥接（WorkBuddy 等）
};

/** Agent 健康状态。unknown 为初始；disabled 表示被用户 / 策略禁用。 */
const HEALTH_STATE = {
  UNKNOWN: 'unknown',
  CHECKING: 'checking',
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNAVAILABLE: 'unavailable',
  DISABLED: 'disabled'
};

/**
 * Agent 验证等级。与 HEALTH_STATE 不同：Health 表示运行时状态，Verification 表示实际验证深度。两者禁止混用 (spec §45)。
 *
 * 7 级偏序（spec §39）——从低到高：
 *   NOT_VERIFIED              — 未验证（默认值，不可路由）
 *   IMPLEMENTATION_VERIFIED   — 实现级：已确认 Agent 实现 / 代码存在
 *   FIXTURE_VERIFIED          — Fixture 级：通过离线 fixture 测试
 *   PACKAGED_VERIFIED         — 打包级：SDK / 二进制已随应用打包
 *   LOCAL_DETECTION_VERIFIED  — 本地检测级：可执行文件 --version 成功
 *   REAL_PROTOCOL_VERIFIED    — 真实协议级：真实 initialize / session / prompt 交互成功
 *   REAL_AGENT_TASK_VERIFIED  — 真实任务级：真实 Agent 任务端到端完成
 */
const VERIFICATION_LEVEL = {
  NOT_VERIFIED: 'not_verified',
  IMPLEMENTATION_VERIFIED: 'implementation_verified',
  FIXTURE_VERIFIED: 'fixture_verified',
  PACKAGED_VERIFIED: 'packaged_verified',
  LOCAL_DETECTION_VERIFIED: 'local_detection_verified',
  REAL_PROTOCOL_VERIFIED: 'real_protocol_verified',
  REAL_AGENT_TASK_VERIFIED: 'real_agent_task_verified'
};

/** 单次 Run 生命周期状态。终态：completed / failed / cancelled / timeout / unavailable。 */
const LIFECYCLE = {
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable'
};

/**
 * Hub 错误码。路由层 / 调度器据此决定降级 / 回退策略。
 *   AGENT_NOT_FOUND       — 未知 agent id
 *   AGENT_DISABLED        — agent 被禁用
 *   AGENT_UNAVAILABLE     — detect / healthCheck 判定不可用
 *   AGENT_UNHEALTHY       — 健康检查未通过（degraded / unavailable）
 *   AGENT_BUSY            — 达到 maxConcurrency，无空闲槽位
 *   AGENT_START_FAILED    — startTask 抛错 / 启动失败
 *   AGENT_TIMEOUT         — Run 超时
 *   AGENT_CANCELLED       — Run 被取消
 *   AGENT_PROTOCOL_ERROR  — 适配器协议交互错误（消息格式 / 序列化）
 *   AGENT_RESULT_INVALID  — 返回结果不合法 / 校验失败
 *   AGENT_ROUTE_NOT_FOUND — 无 agent 能满足 required 能力
 *   AGENT_ROUTE_EXHAUSTED — 候选 agent 全部失败，路由耗尽
 *   AGENT_DELEGATION_LOOP — 检测到 Agent 委派环路
 */
const ERROR_CODE = {
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_DISABLED: 'AGENT_DISABLED',
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  AGENT_UNHEALTHY: 'AGENT_UNHEALTHY',
  AGENT_BUSY: 'AGENT_BUSY',
  AGENT_START_FAILED: 'AGENT_START_FAILED',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  AGENT_CANCELLED: 'AGENT_CANCELLED',
  AGENT_PROTOCOL_ERROR: 'AGENT_PROTOCOL_ERROR',
  AGENT_RESULT_INVALID: 'AGENT_RESULT_INVALID',
  AGENT_STREAM_ERROR: 'AGENT_STREAM_ERROR',
  AGENT_STREAM_ENDED_WITHOUT_TERMINAL: 'AGENT_STREAM_ENDED_WITHOUT_TERMINAL',
  AGENT_AUTH_FAILED: 'AGENT_AUTH_FAILED',
  AGENT_SESSION_NOT_FOUND: 'AGENT_SESSION_NOT_FOUND',
  AGENT_REMOTE_ERROR: 'AGENT_REMOTE_ERROR',
  PROJECT_LOCKED: 'PROJECT_LOCKED',
  AGENT_ROUTE_NOT_FOUND: 'AGENT_ROUTE_NOT_FOUND',
  AGENT_ROUTE_EXHAUSTED: 'AGENT_ROUTE_EXHAUSTED',
  AGENT_DELEGATION_LOOP: 'AGENT_DELEGATION_LOOP'
};

/**
 * 统一 Agent 事件类型（spec §17/§18）。
 * Hub 把各 Adapter 的原生事件归一化到这套命名，GUI 据此渲染
 * Run Timeline / Chat / Diff / 权限请求，而非逐 Adapter 适配。
 */
const AGENT_EVENT = {
  AGENT_DETECTED: 'agent.detected',
  HEALTH_CHANGED: 'agent.health.changed',
  RUN_STARTED: 'agent.run.started',
  RUN_STATUS: 'agent.run.status',
  PLAN_UPDATED: 'agent.plan.updated',
  // v2.8.0 §46：官方提供的 reasoning summary / thought 事件。
  // 只承载上游主动给出的摘要，绝不尝试提取隐藏内部思维链。
  REASONING: 'agent.reasoning',
  MESSAGE: 'agent.message',
  TOOL_STARTED: 'agent.tool.started',
  TOOL_COMPLETED: 'agent.tool.completed',
  TOOL_FAILED: 'agent.tool.failed',
  FILE_READ: 'agent.file.read',
  FILE_CHANGED: 'agent.file.changed',
  COMMAND_STARTED: 'agent.command.started',
  // v2.8.0：终端 / 命令的增量输出（ACP terminal_output_chunk、Codex outputDelta 等）
  COMMAND_OUTPUT: 'agent.command.output',
  COMMAND_COMPLETED: 'agent.command.completed',
  TEST_FAILED: 'agent.test.failed',
  TEST_PASSED: 'agent.test.passed',
  PERMISSION_REQUIRED: 'agent.permission.required',
  RUN_COMPLETED: 'agent.run.completed',
  RUN_FAILED: 'agent.run.failed',
  RUN_CANCELLED: 'agent.run.cancelled',
  RUN_TIMEOUT: 'agent.run.timeout',
  FALLBACK: 'agent.fallback'
};

module.exports = {
  TRANSPORT,
  HEALTH_STATE,
  VERIFICATION_LEVEL,
  LIFECYCLE,
  ERROR_CODE,
  AGENT_EVENT
};
