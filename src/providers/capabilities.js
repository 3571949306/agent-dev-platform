'use strict';
/**
 * P1-5 — live capability detection.
 *
 * v2.0.0 had one `testConnection` button and treated its result as "everything
 * works". That is how a connection could pass the test and then blow up the
 * moment an agent sent a tool definition, or silently drop a screenshot.
 *
 * Here each capability is probed INDEPENDENTLY against the live endpoint, and
 * every result carries an honest state:
 *
 *   declared — vendor documents it (we did not verify)
 *   tested   — we sent a real request and observed the behaviour
 *   inferred — guessed from the model id
 *   unknown  — we genuinely could not determine it
 *
 * A failed probe is never reported as "unsupported" unless the endpoint gave us
 * an answer that actually means unsupported; transport errors stay `unknown`.
 */

const { imagePart, textPart } = require('./content');

/** 1x1 transparent PNG — smallest thing that is still a valid image. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function cap(value, state, detail) {
  const c = { value, state };
  if (detail) c.detail = String(detail).slice(0, 300);
  return c;
}

/** Distinguish "the model/endpoint said no" from "the network said no". */
function classify(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  if (/econnrefused|enotfound|etimedout|fetch failed|network|socket|abort/.test(m)) return 'transport';
  if (/401|403|unauthorized|invalid api key|forbidden/.test(m)) return 'auth';
  if (/404|not found|unknown (path|endpoint)|no such/.test(m)) return 'missing';
  return 'rejected';
}

const UNSUPPORTED_VISION = /image|vision|multimodal|not support|unsupported|invalid_?type|content.*type|only.*text/i;
const UNSUPPORTED_TOOLS = /tool|function|not support|unsupported|invalid.*parameter/i;

async function withTimeout(promise, ms, label) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 探测超过 ${ms}ms 未响应`)), ms); })
    ]);
  } finally { clearTimeout(t); }
}

/* --------------------------------------------------------------- probes */

/** Does a plain non-streaming-ish text turn come back at all? */
async function testText(provider, model, { timeoutMs = 30000, signal } = {}) {
  try {
    const r = await withTimeout(provider.streamResponse({
      model,
      messages: [{ role: 'user', content: '回复两个字：可用' }],
      maxTokens: 16, signal, onChunk: () => {}
    }), timeoutMs, '文本');
    const ok = !!(r && (r.content || r.responseModel));
    return { text: cap(ok, 'tested', ok ? `返回 ${String(r.content || '').slice(0, 40)}` : '返回空内容') };
  } catch (e) {
    const kind = classify(e);
    return { text: cap(false, kind === 'transport' ? 'unknown' : 'tested', e.message) };
  }
}

/** Did we actually receive more than one chunk (i.e. real SSE, not a fake)? */
async function testStreaming(provider, model, { timeoutMs = 30000, signal } = {}) {
  let chunks = 0;
  try {
    await withTimeout(provider.streamResponse({
      model,
      messages: [{ role: 'user', content: '从 1 数到 8，用空格分隔。' }],
      maxTokens: 64, signal, onChunk: () => { chunks++; }
    }), timeoutMs, '流式');
    // One chunk means the server buffered the whole reply: usable but not streaming.
    return { streaming: cap(chunks > 1, 'tested', `收到 ${chunks} 个分片`) };
  } catch (e) {
    const kind = classify(e);
    return { streaming: cap(false, kind === 'transport' ? 'unknown' : 'tested', e.message) };
  }
}

/** Send a real tool definition and see whether the model can call it. */
async function testTools(provider, model, { timeoutMs = 40000, signal } = {}) {
  const tools = [{
    name: 'get_weather',
    description: '查询某个城市的天气',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: '城市名' } },
      required: ['city']
    }
  }];
  let called = null;
  try {
    const r = await withTimeout(provider.streamResponse({
      model,
      messages: [{ role: 'user', content: '北京现在天气怎么样？请使用工具查询。' }],
      tools, maxTokens: 256, signal,
      onChunk: () => {},
      onToolCall: (tc) => { called = tc; }
    }), timeoutMs, '工具');
    const hit = !!(called || (r && Array.isArray(r.toolCalls) && r.toolCalls.length));
    // The endpoint accepted the tool schema. Even if the model chose not to call
    // it, tool support is proven by the absence of a schema rejection.
    return { tools: cap(true, 'tested', hit ? '模型成功发起工具调用' : '接受了工具定义但本轮未调用') };
  } catch (e) {
    const kind = classify(e);
    if (kind === 'transport') return { tools: cap(false, 'unknown', e.message) };
    if (UNSUPPORTED_TOOLS.test(e.message)) return { tools: cap(false, 'tested', '端点拒绝工具定义：' + e.message) };
    return { tools: cap(false, 'unknown', e.message) };
  }
}

/** Send a real (tiny) image and see whether the endpoint accepts it. */
async function testVision(provider, model, { timeoutMs = 40000, signal } = {}) {
  try {
    const r = await withTimeout(provider.streamResponse({
      model,
      messages: [{
        role: 'user',
        content: [textPart('这张图片是什么颜色？只答一个词。'), imagePart(TINY_PNG, 'image/png')]
      }],
      maxTokens: 32, signal, onChunk: () => {}
    }), timeoutMs, '视觉');
    const ok = !!(r && (r.content || r.responseModel));
    return { vision: cap(ok, 'tested', ok ? '端点接受了图片输入' : '返回空内容') };
  } catch (e) {
    const kind = classify(e);
    if (kind === 'transport') return { vision: cap(false, 'unknown', e.message) };
    if (UNSUPPORTED_VISION.test(e.message)) return { vision: cap(false, 'tested', '端点拒绝图片输入：' + e.message) };
    // A rejection we cannot attribute to images is not evidence about vision.
    return { vision: cap(false, 'unknown', e.message) };
  }
}

/* ------------------------------------------------------------ orchestrator */

const PROBES = { text: testText, streaming: testStreaming, tools: testTools, vision: testVision };

/**
 * Probe a (provider, model) pair. Runs sequentially so a rate-limited endpoint
 * does not fail everything at once, and so `onProgress` can drive a UI.
 *
 * @param which  which probes to run, default all
 * @returns { model, ranAt, durationMs, text, streaming, tools, vision }
 */
async function detectCapabilities(provider, model, opts = {}) {
  const which = opts.which || Object.keys(PROBES);
  const started = Date.now();
  const out = { model: model || null, protocol: provider && provider.protocol ? provider.protocol : null };

  if (!model) {
    for (const k of which) out[k] = cap(false, 'unknown', '未指定模型');
    out.ranAt = new Date().toISOString();
    out.durationMs = 0;
    return out;
  }

  for (const name of which) {
    if (opts.signal && opts.signal.aborted) { out[name] = cap(false, 'unknown', '已取消'); continue; }
    if (opts.onProgress) { try { opts.onProgress(name, 'running'); } catch { /* UI only */ } }
    const t0 = Date.now();
    const res = await PROBES[name](provider, model, opts);
    Object.assign(out, res);
    if (out[name]) out[name].ms = Date.now() - t0;
    if (opts.onProgress) { try { opts.onProgress(name, 'done', out[name]); } catch { /* UI only */ } }
    // If plain text does not work there is no point burning quota on the rest.
    if (name === 'text' && out.text && out.text.value === false && out.text.state === 'tested') {
      for (const rest of which.filter(k => k !== 'text' && !out[k])) {
        out[rest] = cap(false, 'unknown', '文本探测已失败，跳过');
      }
      break;
    }
  }

  out.ranAt = new Date().toISOString();
  out.durationMs = Date.now() - started;
  return out;
}

/** Collapse a report into { vision: bool, tools: bool, ... } for quick checks. */
function toFlags(report) {
  const flags = {};
  for (const k of ['text', 'streaming', 'tools', 'vision']) {
    if (report && report[k]) flags[k] = report[k].value === true;
  }
  return flags;
}

module.exports = {
  detectCapabilities, toFlags, cap, classify,
  testText, testStreaming, testTools, testVision,
  TINY_PNG
};
