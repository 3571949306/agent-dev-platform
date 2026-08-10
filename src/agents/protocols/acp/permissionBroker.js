'use strict';
/**
 * v2.8.0 — 外部 Agent 权限代理（spec §34/§35/§36/§38/§92）。
 *
 * ExternalAgentPermissionBroker 把外部 Agent 的权限请求统一映射到
 * Agent Dev Platform 权限系统，并应用交集策略：
 *
 *   有效权限 = Parent Run Permission ∩ Platform Policy ∩ External Agent Policy
 *
 * 不得取并集。父 Run 为只读时，外部请求写文件 / 执行命令 → DENIED。
 * 危险命令不得自动允许，必须路由到 GUI 由用户决定（运行时负责弹窗）。
 *
 * 本模块只做"评估 + 协议编解码"，不弹 UI；运行时拿到 { granted, reason }
 * 后决定自动放行还是请求用户确认。
 *
 * ── ACP v1 权限请求真实形状（取证自 schema/v1/schema.json）────────────
 *   RequestPermissionRequest = {
 *     sessionId: SessionId,
 *     toolCall:  ToolCallUpdate {toolCallId, kind?, status?, title?, content?, locations?, rawInput?, rawOutput?},
 *     options:   PermissionOption[] {optionId, name, kind}   // kind ∈ allow_once|allow_always|reject_once|reject_always
 *   }                                             required: [sessionId, toolCall, options]
 *   RequestPermissionResponse = { outcome: RequestPermissionOutcome }
 *   RequestPermissionOutcome  = {outcome:'cancelled'} | {outcome:'selected', optionId}
 *
 * v1 **没有** `subject` 字段（那是 v2 alpha 的形状）；也**没有**扁平的
 * `{outcome:'approved'}`。响应必须是嵌套信封，且 optionId 必须来自 options[]。
 */

const path = require('path');
const {
  TOOL_KIND,
  PERMISSION_OPTION_KIND,
  PERMISSION_OUTCOME
} = require('./constants');

/** 规范化的外部权限操作类别。 */
const OPERATION = {
  RUN_SHELL: 'run_shell',
  WRITE_FILE: 'write_file',
  READ_FILE: 'read_file',
  READ_OUTSIDE_ROOT: 'read_outside_root',
  NETWORK: 'network',
  MCP: 'mcp',
  ADDITIONAL_DIRECTORY: 'additional_directory',
  OTHER: 'other'
};

/** 需要"写"权限的操作（只读父 Run 不允许）。 */
const WRITE_OPERATIONS = new Set([
  OPERATION.RUN_SHELL,
  OPERATION.WRITE_FILE,
  OPERATION.ADDITIONAL_DIRECTORY,
  OPERATION.NETWORK,
  OPERATION.MCP
]);

/** rawInput 中可能承载 shell 命令的键（用于 kind 缺失时的保守判定）。 */
const COMMAND_KEYS = ['command', 'cmd', 'script', 'shellCommand', 'commandLine'];
/** rawInput 中可能承载文件路径的键。 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filepath', 'target', 'destination'];
/** rawInput 中可能承载 URL 的键。 */
const URL_KEYS = ['url', 'uri', 'endpoint'];

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v.join(' ');
  }
  return '';
}

/** 从 ToolCall(.locations) 抽取受影响的绝对路径。 */
function extractLocations(toolCall) {
  const out = [];
  if (toolCall && Array.isArray(toolCall.locations)) {
    for (const loc of toolCall.locations) {
      if (loc && typeof loc.path === 'string' && loc.path) out.push(loc.path);
    }
  }
  const raw = firstString(toolCall && toolCall.rawInput, PATH_KEYS);
  if (raw) out.push(raw);
  return [...new Set(out)];
}

/** 判定 p 是否位于 root 之内（不解析符号链接，仅做词法判定）。 */
function isInsideRoot(p, root) {
  if (!p || !root) return false;
  try {
    const rel = path.relative(path.resolve(root), path.resolve(p));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

/**
 * 把 ACP v1 `RequestPermissionRequest.toolCall`（ToolCallUpdate）映射为规范化请求。
 *
 * 判别依据是官方 ToolKind 枚举，而非猜测的 `subject.kind`。
 * kind 缺失/为 other 时采取**保守升级**：能看出命令就按 RUN_SHELL、
 * 能看出路径就按 WRITE_FILE —— 宁可多一次门禁，也不放过危险操作（§36）。
 *
 * @param {object} toolCall ACP ToolCallUpdate
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] 用于判定 read 是否越界
 * @returns {{ operation:string, scope:string, detail:string, toolCallId:string|null, toolKind:string, locations:string[] }}
 */
function mapAcpToolCall(toolCall, opts = {}) {
  const base = {
    operation: OPERATION.OTHER,
    scope: 'unknown',
    detail: '',
    toolCallId: null,
    toolKind: TOOL_KIND.OTHER,
    locations: []
  };
  if (!toolCall || typeof toolCall !== 'object') return base;

  const toolCallId = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
  const toolKind = typeof toolCall.kind === 'string' ? toolCall.kind : TOOL_KIND.OTHER;
  const title = typeof toolCall.title === 'string' ? toolCall.title : '';
  const locations = extractLocations(toolCall);
  const command = firstString(toolCall.rawInput, COMMAND_KEYS);
  const url = firstString(toolCall.rawInput, URL_KEYS);
  const detail = title || command || locations[0] || url || '';
  const meta = { detail: String(detail), toolCallId, toolKind, locations };

  switch (toolKind) {
    case TOOL_KIND.EXECUTE:
      return { ...meta, operation: OPERATION.RUN_SHELL, scope: command || title || 'shell' };
    case TOOL_KIND.EDIT:
    case TOOL_KIND.DELETE:
    case TOOL_KIND.MOVE:
      return { ...meta, operation: OPERATION.WRITE_FILE, scope: locations[0] || title || 'file' };
    case TOOL_KIND.FETCH:
      return { ...meta, operation: OPERATION.NETWORK, scope: url || title || 'network' };
    case TOOL_KIND.READ: {
      const root = opts.projectRoot;
      // 无 root 可比对，或存在任一越界路径 → 按越界处理（fail-closed）。
      const outside = !root || locations.length === 0
        ? !root
        : locations.some(p => !isInsideRoot(p, root));
      return {
        ...meta,
        operation: outside ? OPERATION.READ_OUTSIDE_ROOT : OPERATION.READ_FILE,
        scope: locations[0] || title || 'file'
      };
    }
    case TOOL_KIND.SEARCH:
    case TOOL_KIND.THINK:
    case TOOL_KIND.SWITCH_MODE:
      return { ...meta, operation: OPERATION.OTHER, scope: title || toolKind };
    default: {
      // kind 未知 / other：保守升级，避免危险操作被降级成 OTHER 而自动放行。
      if (command) return { ...meta, operation: OPERATION.RUN_SHELL, scope: command };
      if (locations.length) return { ...meta, operation: OPERATION.WRITE_FILE, scope: locations[0] };
      if (url) return { ...meta, operation: OPERATION.NETWORK, scope: url };
      return { ...meta, operation: OPERATION.OTHER, scope: title || toolKind || 'unknown' };
    }
  }
}

/**
 * 映射一整个 ACP v1 RequestPermissionRequest。
 * @param {object} request {sessionId, toolCall, options}
 * @param {object} [opts] {projectRoot}
 */
function mapAcpPermissionRequest(request, opts = {}) {
  const req = request && typeof request === 'object' ? request : {};
  return {
    sessionId: typeof req.sessionId === 'string' ? req.sessionId : null,
    options: Array.isArray(req.options) ? req.options : [],
    ...mapAcpToolCall(req.toolCall, opts)
  };
}

function requiresWrite(operation) {
  return WRITE_OPERATIONS.has(operation);
}

/**
 * 评估一个外部权限请求。
 * @param {{operation:string, scope?:string, detail?:string}} request
 * @param {object} ctx
 * @param {'read'|'write'} [ctx.parentRunPermission='write'] 父 Run 授权（只读/读写）
 * @param {string[]} [ctx.platformPolicy] 平台允许的操作白名单（缺省允许全部）
 * @param {string[]} [ctx.externalAgentPolicy] 外部 Agent 自身策略允许的操作（缺省允许全部）
 * @returns {{ granted:boolean, reason:string, effectivePermission:string }}
 */
function evaluate(request, ctx = {}) {
  const operation = request && request.operation;
  const parentRunPermission = ctx.parentRunPermission || 'write';
  const platformPolicy = ctx.platformPolicy ? new Set(ctx.platformPolicy) : null;
  const externalAgentPolicy = ctx.externalAgentPolicy ? new Set(ctx.externalAgentPolicy) : null;

  // 1. 父 Run 只读 → 写操作 DENIED
  if (parentRunPermission === 'read' && requiresWrite(operation)) {
    return { granted: false, reason: 'PARENT_READ_ONLY', effectivePermission: 'read' };
  }
  // 2. 平台策略
  if (platformPolicy && !platformPolicy.has(operation)) {
    return { granted: false, reason: 'PLATFORM_POLICY_DENIED', effectivePermission: parentRunPermission };
  }
  // 3. 外部 Agent 策略
  if (externalAgentPolicy && !externalAgentPolicy.has(operation)) {
    return { granted: false, reason: 'EXTERNAL_AGENT_POLICY_DENIED', effectivePermission: parentRunPermission };
  }
  return { granted: true, reason: 'OK', effectivePermission: parentRunPermission };
}

function pickOption(options, kinds) {
  for (const kind of kinds) {
    const hit = options.find(o => o && typeof o.optionId === 'string' && o.kind === kind);
    if (hit) return hit;
  }
  return null;
}

/**
 * 从 Agent 提供的 options[] 中挑选一个 optionId。
 *
 * 允许时优先 `allow_once`：绝不代替用户选择 `allow_always`（那等于把一次性
 * 授权升级为永久授权，违反 §36）。仅当 Agent 只给了 allow_always 时才退让。
 * 拒绝时优先 `reject_once`。
 *
 * fail-closed：请求"允许"但没有任何 allow 选项时，回退到 reject 选项；
 * 二者皆无则返回 null，调用方必须改发 cancelled。
 *
 * @param {Array} options PermissionOption[]
 * @param {boolean} granted
 * @returns {{optionId:string, kind:string, fallback:boolean}|null}
 */
function selectPermissionOption(options, granted) {
  const list = Array.isArray(options) ? options : [];
  const allowKinds = [PERMISSION_OPTION_KIND.ALLOW_ONCE, PERMISSION_OPTION_KIND.ALLOW_ALWAYS];
  const rejectKinds = [PERMISSION_OPTION_KIND.REJECT_ONCE, PERMISSION_OPTION_KIND.REJECT_ALWAYS];

  const primary = pickOption(list, granted ? allowKinds : rejectKinds);
  if (primary) return { optionId: primary.optionId, kind: primary.kind, fallback: false };

  // fail-closed：拿不到期望的选项时，只允许向"更严格"的方向回退。
  if (granted) {
    const fallback = pickOption(list, rejectKinds);
    if (fallback) return { optionId: fallback.optionId, kind: fallback.kind, fallback: true };
  }
  return null;
}

/** 构造 ACP v1 `{outcome:{outcome:'cancelled'}}`。 */
function buildCancelledResponse() {
  return { outcome: { outcome: PERMISSION_OUTCOME.CANCELLED } };
}

/** 构造 ACP v1 `{outcome:{outcome:'selected', optionId}}`。 */
function buildSelectedResponse(optionId) {
  return { outcome: { outcome: PERMISSION_OUTCOME.SELECTED, optionId } };
}

/**
 * 依据评估结果直接构造 RequestPermissionResponse。
 * 选不出合法 optionId 时返回 cancelled（fail-closed，绝不伪造 optionId）。
 * @param {{granted:boolean, options:Array}} args
 * @returns {{response:object, selected:{optionId:string,kind:string,fallback:boolean}|null}}
 */
function buildResponse({ granted, options } = {}) {
  const selected = selectPermissionOption(options, Boolean(granted));
  if (!selected) return { response: buildCancelledResponse(), selected: null };
  return { response: buildSelectedResponse(selected.optionId), selected };
}

module.exports = {
  OPERATION,
  WRITE_OPERATIONS,
  mapAcpToolCall,
  mapAcpPermissionRequest,
  isInsideRoot,
  requiresWrite,
  evaluate,
  selectPermissionOption,
  buildCancelledResponse,
  buildSelectedResponse,
  buildResponse
};
