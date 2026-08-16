'use strict';
/**
 * v2.6.0 Main Agent Runtime — Provider Model Adapter。
 *
 * 把现有 provider.streamResponse 包装成 Main Agent Loop 需要的 model 接口：
 *   { decide({ system, context, iteration, abortSignal }) -> { text, action? } }
 *
 * v2.9.9 体验对标 Phase 1：原生 Tool Calling。
 *   - 支持 tools 的 provider（anthropic / openai-chat / openai-responses）会收到
 *     buildActionTools() 生成的 tool 定义，返回的 toolCalls 优先转成结构化 action；
 *   - toolCalls 为空或 provider 不支持 tools 时，fallback 到现有纯文本 parseActionJson 路径，
 *     保证 Ollama / 自定义兼容接口行为与现状完全一致（回归保护）。
 *
 * 生产环境用这个；测试 / E2E 用 FakeCodingModel（直接注入，不经网络）。
 */

const { buildActionTools } = require('./actionToolSchema');
const { validateAction, READ_ONLY_ACTIONS } = require('./actionSchema');

const MAX_PARALLEL_READ = 8; // 一轮并发只读上限，防 context 爆

/** 已知支持原生 tool calling 的 provider protocol。不在此列一律走纯文本路径，不盲发 tools。 */
const TOOL_CAPABLE_PROTOCOLS = ['anthropic', 'openai-chat', 'openai-responses'];
function providerSupportsTools(provider, agent) {
  if (!provider) return false;
  if (provider.supportsTools === false) return false;
  // 允许 agent 配置显式关闭（自定义网关报错时的一键回退）
  if (agent && agent.workspace && agent.workspace.toolCalling === false) return false;
  return TOOL_CAPABLE_PROTOCOLS.includes(provider.protocol);
}

/**
 * 把 provider 返回的 toolCalls（第一个）转成 {type, args}。
 * arguments 为 JSON 字符串，解析失败返回 null（由调用方按 AGENT_RESPONSE_INVALID 语义回退文本路径）。
 */
function toolCallToAction(toolCalls, validateFn) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const tc = toolCalls[0];
  if (!tc || !tc.name) return null;
  let args = {};
  try { args = JSON.parse(tc.arguments || '{}'); } catch { return null; }
  const v = (validateFn || ((n, a) => validateAction({ type: n, args: a })))(tc.name, args);
  return v.ok ? v.action : null;
}

/**
 * Phase 2：把全部 toolCalls 转成 action 数组。
 * 仅当「≥2 个且全部为只读 action」时返回数组（一轮并发只读）；
 * 否则返回 null（调用方回退单 action 语义，写类仍单轮单个）。
 */
function toolCallsToParallelReadActions(toolCalls, validateFn, readOnlySet) {
  if (!Array.isArray(toolCalls) || toolCalls.length < 2) return null;
  const ro = readOnlySet || READ_ONLY_ACTIONS;
  const vf = validateFn || ((n, a) => validateAction({ type: n, args: a }));
  const actions = [];
  for (const tc of toolCalls) {
    if (!tc || !tc.name) return null;
    let args = {};
    try { args = JSON.parse(tc.arguments || '{}'); } catch { return null; }
    const v = vf(tc.name, args);
    if (!v.ok) return null;
    if (!ro.includes(v.action.type)) return null; // 含非只读 → 不并发
    actions.push(v.action);
  }
  return actions.length >= 2 ? actions.slice(0, MAX_PARALLEL_READ) : null;
}

/**
 * 创建一个 ProviderModelAdapter。
 * @param {object} opts {
 *   buildProvider,  // (agent) => provider
 *   agent,          // agent 对象（含 model / provider / api_connection_id）
 *   resolveModel,   // (agent) => { model, ... } 可选
 *   timeoutMs?,
 *   onModelOutcome? // v2.9.9 Phase B Final（B16.3）— Wire Truth 回调：
 *                   // ({ requested, actual, ok, latencyMs, error })，只报告真实上线模型
 * }
 */
function createProviderModelAdapter(opts) {
  const { buildProvider, agent, resolveModel, timeoutMs = 120000, onModelOutcome, toolProfile } = opts;
  if (typeof buildProvider !== 'function') throw new Error('buildProvider 必填');
  const reportOutcome = typeof onModelOutcome === 'function' ? onModelOutcome : null;
  // v2.9.9 CU2-A §17：可选 toolProfile（{buildTools, validateToolCall, readOnlyActions,
  // multipleToolCallPolicy}）。默认 undefined → 完全保持 Coding Agent 现有行为
  // （buildActionTools / validateAction / 并行只读）。Computer Agent 注入 Computer profile。
  const profile = toolProfile || null;
  const profileValidate = profile && typeof profile.validateToolCall === 'function' ? profile.validateToolCall : null;
  const profileReadOnly = profile && Array.isArray(profile.readOnlyActions) ? profile.readOnlyActions : null;
  const profileSingle = !!(profile && profile.multipleToolCallPolicy === 'single');

  return {
    name: 'ProviderModelAdapter',
    async decide({ system, context, iteration, abortSignal, history }) {
      const provider = await buildProvider(agent);
      const modelInfo = resolveModel ? resolveModel(agent) : { model: agent.model };
      const supportsTools = providerSupportsTools(provider, agent);
      const tools = supportsTools ? (profile && typeof profile.buildTools === 'function' ? profile.buildTools() : buildActionTools()) : null;
      // v2.9.9 Phase 5：真实多轮历史（assistant tool_use → user tool_result）仅在 tools 路径启用；
      // 纯文本 fallback provider 仍用单条 context 拼接（两条路径并存，supportsTools 区分）。
      const messages = (supportsTools && Array.isArray(history) && history.length)
        ? history
        : [{ role: 'user', content: context }];

      let text = '';
      let action = null;
      let parallelActions = null;
      const buf = [];
      const t0 = Date.now();
      // v2.9.8 R5 — 内部 AbortController：合并 caller abort 与 adapter timeout，
      // 超时发生时能真正 abort 底层 provider request（只要 provider 遵守 signal），
      // 同时绝不去 mutate caller 的 AbortSignal。
      const internalController = new AbortController();
      const { signal: internalSignal } = internalController;
      let mergedSignal = internalSignal;
      if (abortSignal) {
        if (abortSignal.aborted) {
          internalController.abort();
        } else {
          abortSignal.addEventListener('abort', () => internalController.abort(), { once: true });
        }
      }
      try {
        const streamOpts = {
          model: modelInfo.model,
          system,
          messages,
          temperature: 0.2,        // coding agent 低温度，更确定
          // v2.9.9 Phase 5：默认 8192（大 patch 不易被截断），可经 agent.max_tokens 覆盖
          maxTokens: agent.max_tokens || 8192,
          timeoutMs,
          signal: internalSignal,
          onChunk: (t) => { buf.push(t); }
        };
        // 仅在确有 tools 时才附加该键：避免给不需要 tool calling 的调用方（如 Generator）
        // 注入空 tools 键（hasOwnProperty 仍为 true），保持其纯文本语义（回归保护）。
        if (tools) streamOpts.tools = tools;
        const streamPromise = provider.streamResponse(streamOpts);
        // v2.9.8 R6-A — Model Hang Guard：configured timeout 必须在 adapter 层真兑现。
        // 守规矩的 provider（http 传输层）会自己按 timeoutMs/signal 结算；但若 provider
        // 永不 settle（挂死、忽略 abort），run 绝不能跟着挂死——用超时/abort 竞速强制结算。
        const result = await settleBounded(streamPromise, timeoutMs, internalController);
        text = buf.join('') || result.content || '';
        // Phase 1：原生 tool calling 优先。toolCalls 非空且能解析出合法 action 时直接带出；
        // 解析失败（非法 JSON / 未知 type）返回 action=null，Loop 会回退 parseAndValidate(text)。
        action = supportsTools ? toolCallToAction(result.toolCalls, profileValidate) : null;
        // Phase 2：一轮多个只读 action 时带出 actions 数组，Loop 并发执行。
        // CU2-A：single 策略（Computer）不并发；默认 Coding 保持并行只读。
        parallelActions = (supportsTools && !profileSingle) ? toolCallsToParallelReadActions(result.toolCalls, profileValidate, profileReadOnly) : null;
        // B16.3 — Wire Truth：provider 回报的真实上线模型（responseModel）与请求模型对照
        if (reportOutcome) {
          try {
            reportOutcome({
              requested: modelInfo.model || null,
              actual: result.responseModel || modelInfo.model || null,
              ok: true,
              latencyMs: Date.now() - t0,
              error: null
            });
          } catch { /* 观测回调绝不得影响主链路 */ }
        }
      } catch (e) {
        if (reportOutcome) {
          try {
            reportOutcome({ requested: modelInfo.model || null, actual: null, ok: false, latencyMs: Date.now() - t0, error: String(e && e.message || e) });
          } catch { /* noop */ }
        }
        if (abortSignal && abortSignal.aborted) throw e;
        throw e && e.timeout === true ? e : new Error('模型请求失败: ' + (e.message || e));
      } finally {
        // 尽最大努力清理内部 signal  listener，并尝试 final abort（幂等）
        try { internalController.abort(); } catch { /* noop */ }
      }
      // { text, action?, actions? }：action 存在时 Loop 直接用；actions 为一轮并发只读；
      // 都缺失时 Loop 回退 parseAndValidate(text)
      if (parallelActions) return { text, actions: parallelActions, action: parallelActions[0] };
      return action ? { text, action } : { text };
    }
  };
}

/**
 * v2.9.8 R5/R6-A — 有界结算：provider promise 与 configured timeout / abort signal 竞速。
 * 超时抛出带 timeout=true 的错误（AgentLoop 归类为 timeout 终态）并 abort 底层 provider；
 * caller abort 时同样 abort 底层 provider。provider 先 settle 时计时器立即清除。
 * @param {AbortController|null} abortController — 内部 AbortController，超时/取消时用来 abort provider。
 */
function settleBounded(streamPromise, timeoutMs, abortController) {
  const ms = Number(timeoutMs);
  const hasTimeout = Number.isFinite(ms) && ms > 0;
  const abortSignal = abortController ? abortController.signal : null;
  const hasSignal = abortSignal && typeof abortSignal.addEventListener === 'function';
  if (!hasTimeout && !hasSignal) return streamPromise;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (onAbort && hasSignal) {
        try { abortSignal.removeEventListener('abort', onAbort); } catch { /* noop */ }
      }
    };
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    streamPromise.then(
      value => done(resolve, value),
      err => done(reject, err)
    );
    if (hasTimeout) {
      timer = setTimeout(() => {
        // v2.9.8 R5 — adapter 超时时尽最大努力 abort 底层 provider request，
        // 然后 reject timeout error。timeout 路径必须先清空 timer，
        // 让同步触发的 onAbort 能区分这是 timeout 而非 caller cancel。
        timer = null;
        try { if (abortController) abortController.abort(); } catch { /* noop */ }
        const e = new Error(`model request timeout (${ms}ms)`);
        e.name = 'TimeoutError';
        e.timeout = true;
        done(reject, e);
      }, ms);
      if (timer.unref) timer.unref(); // 绝不为请求超时留住事件循环
    }
    if (hasSignal) {
      // internal abort 只有是 caller 触发时才 reject AbortError；
      // timeout 也会触发 internal abort，但由上面的 timer 负责 reject timeout error。
      onAbort = () => {
        if (timer) {
          // abort 发生在 timeout 之前：这是 caller cancel。
          clearTimeout(timer);
          timer = null;
        } else {
          // timer 已被清空：这是 timeout 导致的 internal abort，忽略。
          return;
        }
        const e = new Error('aborted');
        e.name = 'AbortError';
        e.aborted = true;
        done(reject, e);
      };
      try { abortSignal.addEventListener('abort', onAbort, { once: true }); } catch { onAbort = null; }
    }
  });
}

module.exports = { createProviderModelAdapter };
