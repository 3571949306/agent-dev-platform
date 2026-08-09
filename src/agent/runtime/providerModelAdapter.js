'use strict';
/**
 * v2.6.0 Main Agent Runtime — Provider Model Adapter。
 *
 * 把现有 provider.streamResponse 包装成 Main Agent Loop 需要的 model 接口：
 *   { decide({ system, context, iteration, abortSignal }) -> { text } }
 *
 * 生产环境用这个；测试 / E2E 用 FakeCodingModel（直接注入，不经网络）。
 */

/**
 * 创建一个 ProviderModelAdapter。
 * @param {object} opts {
 *   buildProvider,  // (agent) => provider
 *   agent,          // agent 对象（含 model / provider / api_connection_id）
 *   resolveModel,   // (agent) => { model, ... } 可选
 *   timeoutMs?
 * }
 */
function createProviderModelAdapter(opts) {
  const { buildProvider, agent, resolveModel, timeoutMs = 120000 } = opts;
  if (typeof buildProvider !== 'function') throw new Error('buildProvider 必填');

  return {
    name: 'ProviderModelAdapter',
    async decide({ system, context, iteration, abortSignal }) {
      const provider = await buildProvider(agent);
      const modelInfo = resolveModel ? resolveModel(agent) : { model: agent.model };
      const messages = [{ role: 'user', content: context }];

      let text = '';
      const buf = [];
      try {
        const result = await provider.streamResponse({
          model: modelInfo.model,
          system,
          messages,
          temperature: 0.2,        // coding agent 低温度，更确定
          maxTokens: agent.max_tokens || 4096,
          timeoutMs,
          signal: abortSignal,
          onChunk: (t) => { buf.push(t); }
        });
        text = buf.join('') || result.content || '';
      } catch (e) {
        if (abortSignal && abortSignal.aborted) throw e;
        throw new Error('模型请求失败: ' + (e.message || e));
      }
      return { text };
    }
  };
}

module.exports = { createProviderModelAdapter };
