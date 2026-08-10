'use strict';
/**
 * v2.9.0 Framework Closure Patch — Native Runtime Model Resolution（spec §5-17）。
 *
 * 问题：AgentHub.start('native-main') 经 ExecutionContextFactory 构建 NativeAgentAdapter
 * 的 context 时，旧逻辑把 AgentTask 当 DB agent 喂给 resolveModel(task)，得到 model=null，
 * 随后 buildProvider(null) 抛错 / 或 NativeAgentAdapter 因 context.model 缺失而 FAIL。
 *
 * 修复：建立明确的 Native Runtime Model Resolution Contract，产出**真实**的
 * ProviderModelAdapter（带 decide()），而不是 ModelInfo 元数据。
 *
 * 复用 mainAgent:run 同一个创建逻辑（createProviderModelAdapter），
 * 不造第二套 ProviderModelAdapter（§14）。禁止硬编码具体 DeepSeek 型号，
 * 禁止静默取第一个 Connection（§7/§9）。
 *
 * Native Child Agent 的 Model 来源优先级（§9）：
 *   1. task.modelOverride          显式 ProviderModelAdapter / connection 描述
 *   2. task.context.model          继承 model policy
 *   3. Native Agent 配置的 model   agent.api_connection_id / agent.model
 *   4. Native Agent 配置的 default connection/model
 *   5. Main Agent 当前 Model Context parentModelContext
 *   6. 明确失败
 */

const { createProviderModelAdapter } = require('../runtime/providerModelAdapter');

function createNativeModelContextResolver(deps) {
  const { buildProvider, resolveModel, defaultTimeoutMs = 120000 } = deps || {};
  if (typeof buildProvider !== 'function') {
    throw new Error('createNativeModelContextResolver: buildProvider 必填');
  }

  /** 是否是一个可用的 Model Adapter（MainAgentRuntime / NativeAgentAdapter 需要 {decide}）。 */
  function isModelAdapter(x) {
    return !!x && typeof x.decide === 'function';
  }

  /** 来自直接可用的 ProviderModelAdapter（override / inherited / parent）。 */
  function adapterResult(adapterLike, providerModelAdapter, label) {
    return {
      agent: adapterLike,
      connection: null,
      modelInfo: { model: providerModelAdapter && providerModelAdapter.name ? providerModelAdapter.name : label, provider: null, connectionId: null },
      providerModelAdapter
    };
  }

  /** 来自 Native Agent 配置（api_connection_id / model）→ 走生产 ProviderModelAdapter。 */
  function buildFromAgent(agentLike) {
    const providerModelAdapter = createProviderModelAdapter({
      buildProvider,
      agent: agentLike,
      resolveModel,
      timeoutMs: defaultTimeoutMs
    });
    const info = (typeof resolveModel === 'function')
      ? resolveModel(agentLike)
      : { model: agentLike && agentLike.model };
    return {
      agent: agentLike,
      connection: (info && info.connectionId) || null,
      modelInfo: info || { model: null },
      providerModelAdapter
    };
  }

  /**
   * 解析 Native Child Agent 的 Model Runtime。
   * @param {object} agentLike  adapter 实例 / manifest（可能携带 api_connection_id / model）
   * @param {object} [opts]
   *   { modelOverride, contextModel(task.context.model), parentModelContext }
   * @returns {{ agent, connection, modelInfo, providerModelAdapter }}
   */
  function resolveNativeModelContext(agentLike, opts) {
    const o = opts || {};

    // 1. 显式 modelOverride（直接 ProviderModelAdapter 复用；否则视为 connection 描述交给 buildFromAgent）
    if (isModelAdapter(o.modelOverride)) {
      return adapterResult(agentLike, o.modelOverride, 'override');
    }

    // 2. 继承 model policy（task.context.model）
    if (isModelAdapter(o.contextModel)) {
      return adapterResult(agentLike, o.contextModel, 'inherited');
    }

    // 3-4. 从 Native Agent 配置（api_connection_id / model）构建真实 ProviderModelAdapter
    if (agentLike && (agentLike.api_connection_id || agentLike.model)) {
      return buildFromAgent(agentLike);
    }

    // 5. Main Agent 当前 Model Context（直接 ProviderModelAdapter）
    if (isModelAdapter(o.parentModelContext)) {
      return adapterResult(agentLike, o.parentModelContext, 'parent');
    }

    // 6. 明确失败（禁止静默 fallback 到第一个 Connection）
    throw new Error(
      'NATIVE_MODEL_CONTEXT_UNRESOLVED: native agent 缺少 modelOverride / context.model / ' +
      'api_connection_id 或 model / parentModelContext（禁止静默 fallback 到第一个 Connection）'
    );
  }

  return { resolveNativeModelContext };
}

module.exports = { createNativeModelContextResolver };
