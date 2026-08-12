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
        const streamPromise = provider.streamResponse({
          model: modelInfo.model,
          system,
          messages,
          temperature: 0.2,        // coding agent 低温度，更确定
          maxTokens: agent.max_tokens || 4096,
          timeoutMs,
          signal: abortSignal,
          onChunk: (t) => { buf.push(t); }
        });
        // v2.9.8 R6-A — Model Hang Guard：configured timeout 必须在 adapter 层真兑现。
        // 守规矩的 provider（http 传输层）会自己按 timeoutMs/signal 结算；但若 provider
        // 永不 settle（挂死、忽略 abort），run 绝不能跟着挂死——用超时/abort 竞速强制结算。
        const result = await settleBounded(streamPromise, timeoutMs, abortSignal);
        text = buf.join('') || result.content || '';
      } catch (e) {
        if (abortSignal && abortSignal.aborted) throw e;
        throw e && e.timeout === true ? e : new Error('模型请求失败: ' + (e.message || e));
      }
      return { text };
    }
  };
}

/**
 * v2.9.8 R6-A — 有界结算：provider promise 与 configured timeout / abort signal 竞速。
 * 超时抛出带 timeout=true 的错误（AgentLoop 归类为 timeout 终态）；
 * abort 抛出 AbortError（归类为 cancelled）。provider 先 settle 时计时器立即清除。
 */
function settleBounded(streamPromise, timeoutMs, abortSignal) {
  const ms = Number(timeoutMs);
  const hasTimeout = Number.isFinite(ms) && ms > 0;
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
        const e = new Error(`model request timeout (${ms}ms)`);
        e.name = 'TimeoutError';
        e.timeout = true;
        done(reject, e);
      }, ms);
      if (timer.unref) timer.unref(); // 绝不为请求超时留住事件循环
    }
    if (hasSignal) {
      if (abortSignal.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        e.aborted = true;
        done(reject, e);
        return;
      }
      onAbort = () => {
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
