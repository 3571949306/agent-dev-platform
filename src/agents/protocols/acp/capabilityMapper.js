'use strict';
/**
 * v2.8.0 — ACP 能力映射（spec §22/§45）。
 *
 * ACP v1 的 AgentCapabilities 描述的是"协议特性"，并不直接声明任务级能力
 * （coding / terminal / git）。任务级能力由 Adapter manifest 的 expectedCapabilities 声明，
 * 协议能力在 handshake 后动态并入。
 *
 * ── v1 AgentCapabilities 真实结构（schema/v1/schema.json）───────────────
 *   {
 *     loadSession: boolean,
 *     promptCapabilities: { image, audio, embeddedContext },
 *     mcpCapabilities:    { http, sse },
 *     sessionCapabilities:{ list?, delete?, additionalDirectories?, resume?, close? },
 *     auth:               { logout? }
 *   }
 * 关键语义（schema SessionCapabilities 原文）：
 *   "As a baseline, all Agents **MUST** support session/new, session/prompt,
 *    session/cancel, and session/update."
 * 也就是说 **baseline 能力不出现在 capabilities 里**；sessionCapabilities 下
 * 只列可选扩展，且"存在即支持"——值为 `{}` 同样代表支持，`null`/缺失代表不支持。
 * 因此绝不能用 `!!caps.session` 去判断 agent 是否支持会话（那会误杀所有真实 Agent）。
 *
 * 映射结果用于 Router 的能力匹配与 GUI 展示。禁止把"全部能力"设为 true。
 */

const { ACP_CAPABILITY, ACP_SESSION_CAPABILITY } = require('./constants');

/** sessionCapabilities 的子能力"存在即支持"（`{}` 为真，null/undefined 为假）。 */
function hasSessionCap(sessionCaps, key) {
  if (!sessionCaps || typeof sessionCaps !== 'object') return false;
  const v = sessionCaps[key];
  return v !== undefined && v !== null && v !== false;
}

/**
 * 从 ACP v1 AgentCapabilities + authMethods 抽取平台可识别的协议能力标志。
 * @param {object|null} agentCapabilities ACP 握手返回的 agentCapabilities
 * @param {Array|null} authMethods initialize 返回的 authMethods
 * @returns {object} 能力标志集
 */
function extractAcpCapabilityFlags(agentCapabilities, authMethods) {
  const caps = agentCapabilities && typeof agentCapabilities === 'object' ? agentCapabilities : {};
  const sessionCaps = caps[ACP_CAPABILITY.SESSION_CAPABILITIES] || null;
  const promptCaps = caps[ACP_CAPABILITY.PROMPT_CAPABILITIES] || {};
  const mcpCaps = caps[ACP_CAPABILITY.MCP_CAPABILITIES] || {};
  const authCaps = caps[ACP_CAPABILITY.AUTH] || null;

  const mcpHttp = !!mcpCaps.http;
  const mcpSse = !!mcpCaps.sse;

  return {
    // baseline：v1 规定所有 Agent 必须支持 session/new + session/prompt +
    // session/cancel + session/update，故恒为 true（不依赖 capabilities 字段）。
    sessions: true,
    prompt: true,
    cancel: true,

    // 可选扩展
    loadSession: !!caps[ACP_CAPABILITY.LOAD_SESSION],
    resume: hasSessionCap(sessionCaps, ACP_SESSION_CAPABILITY.RESUME),
    list: hasSessionCap(sessionCaps, ACP_SESSION_CAPABILITY.LIST),
    delete: hasSessionCap(sessionCaps, ACP_SESSION_CAPABILITY.DELETE),
    close: hasSessionCap(sessionCaps, ACP_SESSION_CAPABILITY.CLOSE),
    additionalDirectories: hasSessionCap(sessionCaps, ACP_SESSION_CAPABILITY.ADDITIONAL_DIRECTORIES),

    // MCP
    mcp: mcpHttp || mcpSse,
    mcpHttp,
    mcpSse,

    // prompt 内容类型（baseline 之外的可选项）
    promptImage: !!promptCaps.image,
    promptAudio: !!promptCaps.audio,
    promptEmbeddedContext: !!promptCaps.embeddedContext,

    // 鉴权
    auth: Array.isArray(authMethods) && authMethods.length > 0,
    authLogout: !!(authCaps && authCaps.logout),
    authExtensions: !!authCaps
  };
}

/**
 * 合并 manifest 声明任务能力 + ACP 协议能力 → 最终平台能力字符串数组。
 * @param {object} manifestCaps manifest.capabilities（cap→bool）
 * @param {object} acpFlags extractAcpCapabilityFlags 的结果
 * @returns {string[]}
 */
function mergeManifestCapabilities(manifestCaps, acpFlags) {
  const set = new Set();
  const mc = manifestCaps || {};
  for (const k of Object.keys(mc)) {
    if (mc[k]) set.add(k);
  }
  const flags = acpFlags || {};
  // 协议层能力并入（只并入真实为 true 的，绝不无脑全 true）
  if (flags.sessions) set.add('sessions');
  if (flags.resume) set.add('resume');
  if (flags.loadSession) set.add('loadSession');
  if (flags.mcp) set.add('mcp');
  if (flags.auth) set.add('auth');
  if (flags.additionalDirectories) set.add('additionalDirectories');
  return [...set];
}

/**
 * 一次性协商：返回平台能力数组 + 原始 ACP 标志。
 * @param {object} manifestCaps
 * @param {object|null} agentCapabilities
 * @param {Array|null} authMethods
 */
function negotiateCapabilities(manifestCaps, agentCapabilities, authMethods) {
  const acpFlags = extractAcpCapabilityFlags(agentCapabilities, authMethods);
  const platformCaps = mergeManifestCapabilities(manifestCaps, acpFlags);
  return { platformCaps, acpFlags };
}

/**
 * 校验 ACP 握手返回的能力是否满足 Adapter 期望能力（spec §22）。
 * 只检查协议层能力（如期望 resume 但 agent 不支持 → 不满足）。
 * @param {object} expected ACP 协议层期望（如 { resume:true, mcp:true }）
 * @param {object} acpFlags extractAcpCapabilityFlags 的结果
 * @returns {{ ok:boolean, missing:string[] }}
 */
function checkExpectedAcpCapabilities(expected, acpFlags) {
  const missing = [];
  const exp = expected || {};
  const flags = acpFlags || {};
  for (const key of Object.keys(exp)) {
    if (exp[key] && !flags[key]) missing.push(key);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = {
  extractAcpCapabilityFlags,
  mergeManifestCapabilities,
  negotiateCapabilities,
  checkExpectedAcpCapabilities,
  hasSessionCap,
  ACP_CAPABILITY
};
