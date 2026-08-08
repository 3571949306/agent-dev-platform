'use strict';
/**
 * DesktopVisionReader — P0-4.
 *
 * The UIA path in desktopBridge.js reads a window by walking its automation
 * tree. Plenty of real apps (Electron chat clients with `--disable-renderer-
 * accessibility`, Flutter/Skia surfaces, hardware-accelerated canvases) expose
 * NOTHING there: `getWindowText()` returns null forever and v2.1.0 simply gave
 * up with `failed: 该窗口未暴露 UI 自动化文本`. The user watched the answer
 * appear on screen while the Agent claimed it could not see it.
 *
 * This reader is the fallback: screenshot the window, ask a vision model what
 * state the conversation is in, and hand back the answer it can read.
 *
 * Design constraints that matter in production:
 *  - Cost. A poll every 2s for 3 minutes is 90 image requests. So we hash each
 *    frame and only call the model when the pixels actually changed, and we
 *    enforce a hard `maxCalls` budget.
 *  - Determinism. The model must answer with strict JSON; free-form prose is
 *    unparseable and would make the state machine guess.
 *  - Honesty. No vision model configured => VISION_MODEL_REQUIRED, never a
 *    fabricated "completed".
 *
 * Everything is injected (provider, clock), so test/desktopvision.test.js
 * exercises the real parsing / dedupe / budget logic against a scripted model.
 */
const crypto = require('crypto');
const { textPart, imagePart } = require('../providers/content');

const SYSTEM_PROMPT = [
  '你是桌面界面读屏助手。用户会给你一个 AI 聊天应用窗口的截图，你要判断这一轮对话的状态，并把对方（助手）最新一条回答原样抄写出来。',
  '',
  '只输出一个 JSON 对象。不要 Markdown 代码块，不要任何解释文字。字段固定为：',
  '{"state":"idle|thinking|answering|done|error","confidence":0到1的小数,"answer":"对方最新一条回答的完整文本，没有就空字符串","note":"一句话说明你的判断依据"}',
  '',
  '判定规则：',
  '- 画面里有「停止 / Stop / 正在生成 / 正在思考 / Generating」等忙碌指示，或回答明显还没写完 → answering',
  '- 已经有一段完整回答，并且没有任何忙碌指示 → done',
  '- 界面报错、要求登录、被弹窗挡住、输入没有发出去 → error',
  '- 还看不到任何新回答 → idle',
  '- answer 只能是助手说的话。不要把用户发出去的那条提问抄回来，也不要抄界面按钮和菜单文字。',
  '- 看不清就把 confidence 调低，不要编造内容。'
].join('\n');

const VALID_STATES = ['idle', 'thinking', 'answering', 'done', 'error'];

/**
 * Fingerprint a frame. sha1 over the base64 payload is native-fast even for a
 * 4K screenshot, and lets us skip the model call when nothing moved.
 */
function imageHash(dataUrl) {
  const b64 = String(dataUrl || '').replace(/^data:[^,]*,/, '');
  return crypto.createHash('sha1').update(b64).digest('hex').slice(0, 16);
}

/**
 * Models love to wrap JSON in ```json fences or prepend "好的，". Pull the
 * outermost object out instead of failing the whole poll.
 */
function extractJson(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  const body = fenced ? fenced[1].trim() : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const slice = body.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { /* fall through */ }
  // Trailing commas / smart quotes from smaller models.
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')); } catch { return null; }
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Last-resort interpretation when the model ignored the JSON contract: at least
 * honour the sentinel, which is unambiguous.
 */
function salvage(raw, sentinel) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (sentinel && text.includes(sentinel)) {
    return {
      state: 'done',
      confidence: 0.4,
      answer: text.split(sentinel).join('').trim(),
      note: '模型未按 JSON 输出，但画面中出现了结束标记'
    };
  }
  return null;
}

class DesktopVisionReader {
  /**
   * @param opts.provider  provider adapter with streamResponse({model, messages, ...})
   * @param opts.model     vision-capable model id
   * @param opts.label     human readable "连接名 / 模型" for the UI and errors
   * @param opts.source    'configured' | 'tested' | 'inferred' — why this model was picked
   * @param opts.maxTokens cap per poll (answers are short; screenshots are the cost)
   * @param opts.timeoutMs per-call timeout
   */
  constructor(opts = {}) {
    this.provider = opts.provider || null;
    this.model = opts.model || null;
    this.label = opts.label || (this.model || '未配置');
    this.source = opts.source || 'configured';
    this.maxTokens = opts.maxTokens || 1024;
    this.timeoutMs = opts.timeoutMs || 60000;
    this.signal = opts.signal || null;
    this.calls = 0;
    this.lastError = null;
  }

  get available() { return !!(this.provider && typeof this.provider.streamResponse === 'function' && this.model); }

  hash(dataUrl) { return imageHash(dataUrl); }

  /** Why the caller cannot use this reader — surfaced verbatim to the user. */
  unavailableReason() {
    if (!this.model) return '未配置可用于读屏的视觉模型（需要一个支持图片输入的模型，如 gpt-4o / claude-sonnet-4 / qwen-vl / llava）。';
    if (!this.provider) return `视觉模型「${this.model}」所属的 API 连接不可用。`;
    return '视觉模型不可用。';
  }

  buildMessages(dataUrl, { taskText, sentinel } = {}) {
    const lines = ['这是目标应用的窗口截图。请判断当前状态并抄写对方的最新回答。'];
    if (taskText) lines.push('', '我刚刚发给它的任务是（不要把这段抄回来）：', String(taskText).slice(0, 800));
    if (sentinel) {
      lines.push('', `如果画面中出现单独一行的 ${sentinel}，说明回答已经结束：state 必须为 done，且 answer 里不要包含这个标记。`);
    }
    return [{ role: 'user', content: [textPart(lines.join('\n')), imagePart(dataUrl)] }];
  }

  /**
   * One frame → one structured observation.
   * @returns {{ok:boolean, state?:string, confidence?:number, answer?:string,
   *            note?:string, imageHash?:string, model?:string,
   *            code?:string, error?:string}}
   */
  async analyze(dataUrl, { taskText, sentinel, signal } = {}) {
    if (!this.available) {
      return { ok: false, code: 'VISION_MODEL_REQUIRED', error: this.unavailableReason() };
    }
    if (!dataUrl) return { ok: false, code: 'NO_FRAME', error: '截图为空' };

    const h = imageHash(dataUrl);
    this.calls++;
    let raw = '';
    try {
      const r = await this.provider.streamResponse({
        model: this.model,
        system: SYSTEM_PROMPT,
        messages: this.buildMessages(dataUrl, { taskText, sentinel }),
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
        signal: signal || this.signal,
        onChunk: () => {}
      });
      raw = (r && r.content) || '';
    } catch (e) {
      this.lastError = e.message;
      const aborted = e.aborted === true || e.name === 'AbortError';
      return { ok: false, code: aborted ? 'CANCELLED' : 'VISION_CALL_FAILED', error: e.message, imageHash: h };
    }

    const parsed = extractJson(raw) || salvage(raw, sentinel);
    if (!parsed) {
      this.lastError = '视觉模型未返回可解析的 JSON';
      return { ok: false, code: 'VISION_BAD_OUTPUT', error: this.lastError, raw: raw.slice(0, 300), imageHash: h };
    }

    let state = String(parsed.state || '').toLowerCase();
    if (!VALID_STATES.includes(state)) state = parsed.answer ? 'answering' : 'idle';

    let answer = String(parsed.answer == null ? '' : parsed.answer).trim();
    if (sentinel && answer.includes(sentinel)) {
      answer = answer.split(sentinel).join('').trim();
      state = 'done';                          // the marker is stronger evidence than the label
    }

    return {
      ok: true,
      state,
      confidence: clamp01(parsed.confidence),
      answer,
      note: String(parsed.note || '').slice(0, 200),
      imageHash: h,
      model: this.model,
      calls: this.calls
    };
  }
}

/**
 * Pick a vision model out of the user's configured connections.
 *
 * Priority: explicitly configured > probe-tested vision > inferred from model id.
 * Returns null when the user has no vision-capable model at all, so the caller
 * can report VISION_MODEL_REQUIRED instead of silently doing nothing.
 *
 * @param deps.store       the app store
 * @param deps.providers   the providers index (getProvider / inferVision)
 * @param opts.connectionId preferred connection (usually the calling agent's)
 * @param opts.model        explicit model override
 */
function pickVisionModel(deps, opts = {}) {
  const { store, providers } = deps;
  if (!store || !providers) return null;

  const modelsOf = (conn) => {
    const list = Array.isArray(conn.models) ? conn.models.filter(Boolean) : [];
    if (conn.default_model && !list.includes(conn.default_model)) list.unshift(conn.default_model);
    return list.map(m => (typeof m === 'string' ? m : (m && (m.id || m.model)) || '')).filter(Boolean);
  };

  const build = (conn, model, source) => {
    let provider = null;
    try {
      const full = store.connections.getDecrypted(conn.id) || conn;
      provider = providers.getProvider(full);
    } catch { return null; }
    if (!provider) return null;
    return new DesktopVisionReader({ provider, model, source, label: `${conn.name} / ${model}` });
  };

  // 1. explicit configuration wins, even if we cannot prove the model sees images
  if (opts.connectionId && opts.model) {
    const conn = store.connections.get(opts.connectionId);
    if (conn) { const r = build(conn, opts.model, 'configured'); if (r) return r; }
  }

  let all = [];
  try { all = store.connections.list() || []; } catch { all = []; }
  // Try the caller's own connection first — same key, same latency, same bill.
  if (opts.connectionId) {
    all = [...all.filter(c => c.id === opts.connectionId), ...all.filter(c => c.id !== opts.connectionId)];
  }

  // 2. a real capability probe beats a regex on the model name
  for (const conn of all) {
    for (const m of modelsOf(conn)) {
      let caps = null;
      try { caps = store.models.caps(conn.id, m); } catch { /* not probed */ }
      const v = caps && caps.vision;
      const passed = v && (v === true || (v.state === 'tested' && v.value === true));
      if (passed) { const r = build(conn, m, 'tested'); if (r) return r; }
    }
  }

  // 3. fall back to the model id
  for (const conn of all) {
    for (const m of modelsOf(conn)) {
      if (providers.inferVision(m).value === true) { const r = build(conn, m, 'inferred'); if (r) return r; }
    }
  }
  return null;
}

module.exports = { DesktopVisionReader, pickVisionModel, imageHash, extractJson, SYSTEM_PROMPT, VALID_STATES };
