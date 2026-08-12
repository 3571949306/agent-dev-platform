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
        const streamPromise = provider.streamResponse({
          model: modelInfo.model,
          system,
          messages,
          temperature: 0.2,        // coding agent 低温度，更确定
          maxTokens: agent.max_tokens || 4096,
          timeoutMs,
          signal: internalSignal,
          onChunk: (t) => { buf.push(t); }
        });
        // v2.9.8 R6-A — Model Hang Guard：configured timeout 必须在 adapter 层真兑现。
        // 守规矩的 provider（http 传输层）会自己按 timeoutMs/signal 结算；但若 provider
        // 永不 settle（挂死、忽略 abort），run 绝不能跟着挂死——用超时/abort 竞速强制结算。
        const result = await settleBounded(streamPromise, timeoutMs, internalController);
        text = buf.join('') || result.content || '';
      } catch (e) {
        if (abortSignal && abortSignal.aborted) throw e;
        throw e && e.timeout === true ? e : new Error('模型请求失败: ' + (e.message || e));
      } finally {
        // 尽最大努力清理内部 signal  listener，并尝试 final abort（幂等）
        try { internalController.abort(); } catch { /* noop */ }
      }
      return { text };
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
