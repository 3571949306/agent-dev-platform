'use strict';
/**
 * DesktopAgentBridge — drive an already-running desktop AI app (WorkBuddy,
 * or any chat-style window) and bring back the REAL answer.
 *
 * v2.0.0 faked this: it typed the task, slept 3 seconds, and unconditionally
 * reported "completed — go look in the app yourself". No result ever came back,
 * so the calling Agent had nothing to reason about.
 *
 * This is a proper state machine:
 *
 *   locating → focusing → inputting → submitted → waiting → reading
 *              → completed | failed | timeout | cancelled
 *
 * Input priority chain (first one that works wins):
 *   1. UIA ValuePattern     — writes straight into the control, immune to focus
 *                             loss / IME / keyboard layout
 *   2. clipboard + Ctrl+V   — safe for multiline and any character
 *   3. SendKeys typing      — last resort, with proper escaping (not stripping)
 *
 * Completion detection runs all strategies at once and takes the first hit:
 *   A. sentinel marker      — we ask the remote agent to end with a unique token
 *   B. text stabilisation   — the window text grew, then stopped changing for
 *                             `stableChecks` consecutive polls
 *   C. busy-indicator gone  — a "生成中/Stop/正在思考" string appeared and left
 *   D. hard timeout         — reported as `timeout`, never as `completed`
 *
 * v2.2.0 (P0-4) adds a fifth path. When the window exposes no UI-automation
 * text at all — Electron apps started with accessibility off, Flutter/Skia
 * surfaces, GPU canvases — v2.1.0 returned `failed: 该窗口未暴露 UI 自动化文本`
 * while the answer was plainly visible on screen. Now the state machine
 * DEGRADES instead of giving up:
 *
 *   waiting --(unreadable)--> degrading --> vision-reading --> completed
 *
 * The vision path screenshots the window, hashes the frame so unchanged pixels
 * cost nothing, and asks a vision model for a structured verdict. With no
 * vision model configured we still fail — but with VISION_MODEL_REQUIRED and an
 * actionable message, never with a fabricated success.
 *
 * Everything is injected (`computer`, `visionReader`, `now`, `sleep`), which is
 * what makes the harnesses in test/desktopbridge.test.js and
 * test/desktopvision.test.js real end-to-end exercises of this logic rather
 * than mocks of it.
 */

const DEFAULTS = {
  windowMatch: /workbuddy/i,
  pollIntervalMs: 1200,
  quietMs: 2500,          // how long the text must stay unchanged
  stableChecks: 3,        // consecutive unchanged polls required
  timeoutMs: 180000,
  minAnswerChars: 2,
  useSentinel: true,
  captureScreenshot: false,
  // ---- P0-4 vision fallback ----
  visionFallback: true,
  visionPollMs: 2000,     // frame changed → look again soon
  visionSlowPollMs: 4000, // frame identical → back off, the app is idle
  visionStableChecks: 2,  // identical frames needed to call a read final
  visionMaxCalls: 12,     // hard cost ceiling: images are expensive
  visionMinConfidence: 0.35,
  visionTimeoutMs: 120000
};

/** Reasons that mean "the vision path ran out of time", not "it failed". */
const VISION_TIMEOUT_REASONS = ['vision-timeout', 'vision-timeout-partial', 'vision-budget'];

const BUSY_PATTERNS = [
  /正在(生成|思考|输入|回复)/, /生成中/, /思考中/,
  /\bStop\b/, /\bGenerating\b/, /\bThinking\b/, /\bStreaming\b'?/
];

function normalise(s) {
  return String(s == null ? '' : s).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

/** Cheap stable hash so we can compare long UI dumps without keeping them all. */
function hash(s) {
  let h = 5381;
  const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return `${h}:${t.length}`;
}

function makeSentinel() {
  return 'ADP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/**
 * What the remote app newly produced: the part of the window text that was not
 * there before we sent the task, minus our own echoed prompt.
 */
function diffAnswer(before, after, { taskText, sentinel }) {
  const beforeLines = new Set(normalise(before).split('\n').map(l => l.trim()).filter(Boolean));
  const task = normalise(taskText);
  const taskLines = new Set(task.split('\n').map(l => l.trim()).filter(Boolean));

  const fresh = normalise(after)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !beforeLines.has(l))
    .filter(l => !taskLines.has(l))
    .filter(l => !(sentinel && l === sentinel));

  let text = fresh.join('\n').trim();
  if (sentinel) {
    // drop the marker and anything we appended to the prompt to request it
    text = text.split(sentinel).join('').trim();
    text = text.replace(/回答完成后[^\n]*$/m, '').trim();
  }
  return text;
}

class DesktopAgentBridge {
  /**
   * @param opts.computer  ComputerManager-compatible object
   * @param opts.config    per-adapter overrides (windowTitle, timeoutMs, ...)
   * @param opts.onState   (state, detail) => void — surfaced to the UI
   * @param opts.signal    AbortSignal for the user's Stop button
   * @param opts.sleep     injectable delay (tests run instantly)
   * @param opts.now       injectable clock
   * @param opts.visionReader DesktopVisionReader for the UIA→Vision fallback
   */
  constructor(opts = {}) {
    this.computer = opts.computer;
    this.cfg = { ...DEFAULTS, ...(opts.config || {}) };
    if (typeof this.cfg.windowMatch === 'string') this.cfg.windowMatch = new RegExp(this.cfg.windowMatch, 'i');
    this.onState = opts.onState || (() => {});
    this.signal = opts.signal || null;
    this.sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now || (() => Date.now());
    this.vision = opts.visionReader || null;
    this.sessionId = opts.sessionId || null;
    this.boundWindow = opts.windowRef || null;
    this.requireExactWindow = opts.requireExactWindow === true || !!this.sessionId || !!this.boundWindow;
    this.state = 'idle';
    this.trace = [];
    this.targetHwnd = null; // P3 — verified foreground identity for input fencing
    this.targetPid = null;
  }

  setState(state, detail = {}) {
    this.state = state;
    this.trace.push({ state, at: this.now(), ...detail });
    try { this.onState(state, detail); } catch { /* UI must never break the run */ }
  }

  aborted() { return !!(this.signal && this.signal.aborted); }

  // ------------------------------------------------------------- locating
  async locateWindow() {
    this.setState('locating');
    if (this.boundWindow) {
      const resolved = typeof this.computer.resolveWindow === 'function'
        ? await this.computer.resolveWindow({ hwnd: this.boundWindow.hwnd, pid: this.boundWindow.pid }, { sessionId: this.sessionId, signal: this.signal })
        : { ok: true, window: this.boundWindow };
      return resolved.ok ? { ok: true, window: resolved.window } : resolved;
    }
    const r = await this.computer.listWindows(30000, { sessionId: this.sessionId, signal: this.signal });
    if (!r || r.ok === false) return { ok: false, error: '无法枚举窗口：' + ((r && r.error) || '未知错误') };
    const wanted = this.cfg.windowTitle;
    const list = (r.windows || []).filter(w => {
      const t = `${w.title || ''} ${w.name || ''}`;
      return wanted ? t.includes(wanted) : this.cfg.windowMatch.test(t);
    });
    if (!list.length) {
      return { ok: false, error: `未找到${wanted ? `标题包含「${wanted}」的` : ' WorkBuddy '}窗口，请先打开桌面应用并保持在前台可见。` };
    }
    if (list.length !== 1) {
      return { ok: false, code: 'AMBIGUOUS_EXTERNAL_AGENT_WINDOW', error: `匹配到 ${list.length} 个 WorkBuddy 窗口，拒绝任意选择。` };
    }
    if (this.requireExactWindow && (!list[0].hwnd || !list[0].pid)) {
      return { ok: false, code: 'TARGET_IDENTITY_REQUIRED', error: 'WorkBuddy 窗口缺少 HWND + PID 身份。' };
    }
    return { ok: true, window: list[0] };
  }

  // ---------------------------------------------------------- input chain
  /**
   * Try UIA → clipboard → SendKeys. Returns which path actually worked so the
   * result is honest about how the text got in.
   */
  async inputTask(title, text) {
    this.setState('inputting');
    const attempts = [];
    if (this.aborted()) return { ok: false, cancelled: true, error: '用户已停止', attempts };

    if (this.cfg.inputMode !== 'keys' && this.cfg.inputMode !== 'clipboard') {
      try {
        const r = await this.computer.setControlValue(title, text, {
          automationId: this.cfg.inputAutomationId || '',
          hwnd: this.targetHwnd,
          pid: this.targetPid,
          sessionId: this.sessionId,
          signal: this.signal
        });
        if (r && r.ok) return { ok: true, via: 'uia-value', attempts };
        attempts.push({ via: 'uia-value', error: (r && r.error) || 'ValuePattern 不可用' });
      } catch (e) { attempts.push({ via: 'uia-value', error: e.message }); }
    }

    if (this.aborted()) return { ok: false, cancelled: true, error: '用户已停止', attempts };
    if (this.cfg.inputMode !== 'keys' &&
      (typeof this.computer.pasteToTarget === 'function' || typeof this.computer.setClipboard === 'function')) {
      try {
        if (typeof this.computer.pasteToTarget === 'function' && this.targetHwnd && this.targetPid) {
          // Production compatibility uses the canonical transaction: exact
          // HWND+PID action fence plus restore-in-finally clipboard semantics.
          const paste = await this.computer.pasteToTarget({
            target: { hwnd: this.targetHwnd, pid: this.targetPid, title },
            text,
            sessionId: this.sessionId
          }, { signal: this.signal, sessionId: this.sessionId });
          if (paste && paste.ok !== false) return { ok: true, via: 'clipboard', attempts };
          attempts.push({ via: 'clipboard', error: (paste && paste.error) || '粘贴失败' });
        } else {
          const c = await this.computer.setClipboard(text, { sessionId: this.sessionId, signal: this.signal });
          if (c && c.ok !== false) {
            const paste = await this.computer.pressKeys('^v', { foregroundHwnd: this.targetHwnd, foregroundPid: this.targetPid, sessionId: this.sessionId, signal: this.signal });
            if (paste && paste.ok !== false) return { ok: true, via: 'clipboard', attempts };
            attempts.push({ via: 'clipboard', error: (paste && paste.error) || '粘贴失败' });
          } else {
            attempts.push({ via: 'clipboard', error: (c && c.error) || '写入剪贴板失败' });
          }
        }
      } catch (e) { attempts.push({ via: 'clipboard', error: e.message }); }
    }

    if (this.aborted()) return { ok: false, cancelled: true, error: '用户已停止', attempts };
    try {
      const t = typeof this.computer.typeText === 'function'
        ? await this.computer.typeText(text, { foregroundHwnd: this.targetHwnd, foregroundPid: this.targetPid, sessionId: this.sessionId, signal: this.signal })
        : await this.computer.pressKeys(String(text).replace(/[+^%~(){}\[\]]/g, m => '{' + m + '}'), { foregroundHwnd: this.targetHwnd, foregroundPid: this.targetPid, sessionId: this.sessionId, signal: this.signal });
      if (t && t.ok !== false) return { ok: true, via: 'sendkeys', attempts };
      attempts.push({ via: 'sendkeys', error: (t && t.error) || '按键发送失败' });
    } catch (e) { attempts.push({ via: 'sendkeys', error: e.message }); }

    return { ok: false, error: '三种输入方式全部失败', attempts };
  }

  async submit() {
    if (this.aborted()) return false;
    const r = await this.computer.pressKeys(this.cfg.submitKeys || '~', { foregroundHwnd: this.targetHwnd, foregroundPid: this.targetPid, sessionId: this.sessionId, signal: this.signal });
    this.setState('submitted', { ok: r && r.ok !== false });
    return r && r.ok !== false;
  }

  // -------------------------------------------------- completion detection
  async readWindowText(title) {
    if (typeof this.computer.getWindowText !== 'function') return null;
    const target = this.targetHwnd && this.targetPid
      ? { hwnd: this.targetHwnd, pid: this.targetPid, title }
      : title;
    const r = await this.computer.getWindowText(target, 400, { sessionId: this.sessionId, signal: this.signal });
    if (!r || r.ok === false) return null;
    return typeof r.text === 'string' ? r.text : null;
  }

  /**
   * Poll the window until one of the completion strategies fires.
   * @returns {{done:boolean, reason:string, text:string|null, polls:number}}
   */
  async waitForCompletion(title, { baseline, sentinel }) {
    this.setState('waiting', { timeoutMs: this.cfg.timeoutMs });
    // If the target app exposes no UI-automation text at all there is nothing to
    // poll — say so straight away instead of burning the whole timeout budget.
    if (typeof this.computer.getWindowText !== 'function') {
      return { done: false, reason: 'unreadable', text: null, polls: 0 };
    }
    const deadline = this.now() + this.cfg.timeoutMs;
    let lastHash = hash(baseline);
    let stable = 0;
    let grew = false;
    let sawBusy = false;
    let polls = 0;
    let latest = baseline;
    let emptyCount = 0; // P0: 连续空文本计数，避免单次空就误降级

    while (this.now() < deadline) {
      if (this.aborted()) return { done: false, reason: 'cancelled', text: latest, polls };
      await this.sleep(this.cfg.pollIntervalMs);
      polls++;
      const text = await this.readWindowText(title);
      if (text == null || (typeof text === 'string' && text.trim() === '')) {
        // P0: UIA 可能返回 null、空字符串 ""、或纯空白 "   "
        // 不一次空就降级，连续达到阈值才认为 unreadable
        emptyCount++;
        if (emptyCount >= 3) {
          return { done: false, reason: 'unreadable', text: null, polls };
        }
        continue;
      }
      emptyCount = 0; // 拿到有效文本，重置计数
      latest = text;

      // A. sentinel — the remote agent echoed our unique marker back.
      // We require a line that is EXACTLY the marker: in the prompt the marker is
      // embedded in a sentence ("...请在最后单独一行输出 ADP-XXXXXX"), so a bare
      // line can only come from the answer. This works whether or not the app
      // echoes the user's message back into the transcript.
      if (sentinel && text.includes(sentinel)) {
        const standalone = text.split('\n').some(l => l.trim() === sentinel);
        if (standalone) return { done: true, reason: 'sentinel', text, polls };
      }

      const h = hash(text);
      const busyNow = BUSY_PATTERNS.some(re => re.test(text));
      if (busyNow) sawBusy = true;

      if (h !== lastHash) {
        grew = true;
        stable = 0;
        lastHash = h;
        continue;
      }
      stable++;

      // C. the app showed a busy indicator and it is gone now
      if (sawBusy && !busyNow && grew && stable >= 1) {
        return { done: true, reason: 'busy-cleared', text, polls };
      }
      // B. output grew and then went quiet
      if (grew && stable >= this.cfg.stableChecks) {
        return { done: true, reason: 'stabilised', text, polls };
      }
    }
    return { done: false, reason: 'timeout', text: latest, polls };
  }

  // ------------------------------------------------------- vision fallback
  /**
   * Prefer a window-cropped frame; fall back to the whole desktop when the app
   * cannot be cropped (minimised, off-screen, older ComputerManager).
   */
  async captureWindow(title) {
    const c = this.computer || {};
    if (typeof c.screenshotWindow === 'function') {
      try {
        const target = this.targetHwnd && this.targetPid ? { hwnd: this.targetHwnd, pid: this.targetPid, title } : title;
        const r = await c.screenshotWindow(target, { sessionId: this.sessionId, signal: this.signal });
        if (r && r.ok !== false && r.data_url) return r;
      } catch { /* fall through to full screen */ }
    }
    if (typeof c.screenshot === 'function') {
      try {
        const r = await c.screenshot({ sessionId: this.sessionId, signal: this.signal });
        if (r && r.ok !== false && r.data_url) return { ...r, fullScreen: true };
      } catch { /* no frame at all */ }
    }
    return null;
  }

  /**
   * The UIA tree told us nothing. Watch the pixels instead.
   *
   * Returns the SAME shape as waitForCompletion so run() can treat both paths
   * identically, plus `via:'vision'` so the answer is not run through
   * diffAnswer() (the model already extracted it — there is no baseline text to
   * diff against).
   */
  async visionRead(title, { taskText, sentinel }) {
    const reader = this.vision;
    if (!reader || !reader.available) {
      return {
        done: false, reason: 'vision-unavailable', text: null, polls: 0, via: 'vision',
        error: reader ? reader.unavailableReason() : '未提供视觉读屏器'
      };
    }

    this.setState('vision-reading', { model: reader.model, source: reader.source, label: reader.label });
    const deadline = this.now() + (this.cfg.visionTimeoutMs || this.cfg.timeoutMs);
    let lastHash = null;
    let sameFrames = 0;
    let best = '';
    let bestConfidence = 0;
    let polls = 0;
    let calls = 0;
    let lastState = 'idle';
    let interval = this.cfg.visionPollMs;
    const errors = [];

    while (this.now() < deadline) {
      if (this.aborted()) return { done: false, reason: 'cancelled', text: best, polls, via: 'vision', visionCalls: calls };
      await this.sleep(interval);
      polls++;

      const shot = await this.captureWindow(title);
      if (!shot) {
        errors.push('截图失败');
        interval = this.cfg.visionSlowPollMs;
        continue;
      }

      const h = reader.hash(shot.data_url);
      if (h === lastHash) {
        // Nothing moved. Do NOT spend a model call on an identical frame.
        sameFrames++;
        interval = this.cfg.visionSlowPollMs;
        if (best && sameFrames >= this.cfg.visionStableChecks) {
          return {
            done: true, reason: 'vision-stable', text: best, polls, via: 'vision',
            visionCalls: calls, confidence: bestConfidence
          };
        }
        continue;
      }
      lastHash = h;
      sameFrames = 0;
      interval = this.cfg.visionPollMs;

      if (calls >= this.cfg.visionMaxCalls) {
        return {
          done: !!best,
          reason: best ? 'vision-budget' : 'vision-exhausted',
          text: best, polls, via: 'vision', visionCalls: calls, confidence: bestConfidence
        };
      }

      const a = await reader.analyze(shot.data_url, { taskText, sentinel, signal: this.signal });
      calls++;
      if (!a.ok) {
        if (a.code === 'VISION_MODEL_REQUIRED') {
          return { done: false, reason: 'vision-unavailable', text: null, polls, via: 'vision', error: a.error };
        }
        if (a.code === 'CANCELLED') {
          return { done: false, reason: 'cancelled', text: best, polls, via: 'vision', visionCalls: calls };
        }
        errors.push(a.error || a.code);
        this.setState('vision-error', { error: a.error, code: a.code });
        continue;
      }

      lastState = a.state;
      this.setState('vision-poll', { state: a.state, confidence: a.confidence, chars: (a.answer || '').length, calls });

      if (a.answer && a.answer.length >= this.cfg.minAnswerChars && a.confidence >= this.cfg.visionMinConfidence) {
        // Keep the longest reading: a streaming answer only grows.
        if (a.answer.length >= best.length) { best = a.answer; bestConfidence = a.confidence; }
      }

      if (a.state === 'done' && best) {
        return { done: true, reason: 'vision-done', text: best, polls, via: 'vision', visionCalls: calls, confidence: bestConfidence };
      }
      if (a.state === 'error') {
        return {
          done: false, reason: 'vision-app-error', text: best, polls, via: 'vision',
          visionCalls: calls, error: a.note || '视觉模型判定目标应用处于错误状态'
        };
      }
    }

    return {
      done: !!best,
      reason: best ? 'vision-timeout-partial' : 'vision-timeout',
      text: best, polls, via: 'vision', visionCalls: calls, confidence: bestConfidence,
      lastState, errors
    };
  }

  // ----------------------------------------------------------------- run
  /**
   * @returns {{status:'completed'|'failed'|'timeout'|'cancelled', summary:string, ...}}
   */
  async run(taskText) {
    const started = this.now();
    if (this.aborted()) {
      this.setState('cancelled');
      return this.result('cancelled', '', { errors: ['用户已停止'], durationMs: this.now() - started });
    }
    const loc = await this.locateWindow();
    if (!loc.ok) { this.setState('failed', { error: loc.error }); return this.result('failed', '', { errors: [loc.error] }); }

    const title = loc.window.title;
    if (this.aborted()) {
      this.setState('cancelled');
      return this.result('cancelled', '', { errors: ['用户已停止'], window: title, durationMs: this.now() - started });
    }
    this.setState('focusing', { title });
    const focused = typeof this.computer.focusWindowRef === 'function'
      ? await this.computer.focusWindowRef(loc.window, { sessionId: this.sessionId, signal: this.signal })
      : await this.computer.focusWindow(title, { sessionId: this.sessionId, signal: this.signal });
    if (focused && focused.ok === false) {
      const err = `无法聚焦窗口「${title}」：${focused.error || '未知原因'}`;
      this.setState('failed', { error: err });
      return this.result('failed', '', { errors: [err], window: title });
    }
    // P3 compatibility fix: keep the VERIFIED window identity (HWND) so every
    // later keystroke is fenced to this exact window.
    this.targetHwnd = (loc.window && loc.window.hwnd) || (focused && focused.hwnd) || null;
    this.targetPid = (loc.window && loc.window.pid) || (focused && focused.pid) || null;

    if (this.aborted()) {
      this.setState('cancelled');
      return this.result('cancelled', '', { errors: ['用户已停止'], window: title, durationMs: this.now() - started });
    }

    const baseline = (await this.readWindowText(title)) || '';

    const sentinel = this.cfg.useSentinel ? makeSentinel() : null;
    const prompt = sentinel
      ? `${taskText}\n\n回答完成后请在最后单独一行输出 ${sentinel}`
      : taskText;

    const input = await this.inputTask(title, prompt);
    if (!input.ok) {
      if (input.cancelled || this.aborted()) {
        this.setState('cancelled');
        return this.result('cancelled', '', { errors: ['用户已停止'], attempts: input.attempts, window: title, durationMs: this.now() - started });
      }
      this.setState('failed', { error: input.error });
      return this.result('failed', '', { errors: [input.error], attempts: input.attempts, window: title });
    }
    if (this.aborted()) {
      this.setState('cancelled');
      return this.result('cancelled', '', { errors: ['用户已停止'], inputVia: input.via, window: title, durationMs: this.now() - started });
    }
    if (!(await this.submit())) {
      if (this.aborted()) {
        this.setState('cancelled');
        return this.result('cancelled', '', { errors: ['用户已停止'], inputVia: input.via, window: title, durationMs: this.now() - started });
      }
      const err = '任务已输入但提交（回车）失败';
      this.setState('failed', { error: err });
      return this.result('failed', '', { errors: [err], window: title, inputVia: input.via });
    }

    let wait = await this.waitForCompletion(title, { baseline, sentinel });

    // P0-4: the UIA tree is empty → degrade to reading the screen, don't quit.
    let degraded = null;
    if (wait.reason === 'unreadable' && this.cfg.visionFallback !== false) {
      this.setState('degrading', {
        from: 'uia', to: 'vision',
        reason: '窗口未暴露 UI 自动化文本',
        model: this.vision ? this.vision.model : null
      });
      const v = await this.visionRead(title, { taskText: prompt, sentinel });
      degraded = { uiaReason: 'unreadable', uiaPolls: wait.polls };
      // vision-unavailable means we never got to look — keep the UIA verdict as
      // the primary error so the user is told what to configure.
      wait = (v.reason === 'vision-unavailable')
        ? { ...wait, reason: 'vision-unavailable', error: v.error, via: 'vision' }
        : v;
    }

    const viaVision = wait.via === 'vision';
    this.setState('reading', { reason: wait.reason, via: viaVision ? 'vision' : 'uia' });
    // The vision model already extracted the answer; there is no baseline dump
    // to diff it against, so diffAnswer() would shred it.
    const answer = viaVision
      ? String(wait.text || '').trim()
      : (wait.text ? diffAnswer(baseline, wait.text, { taskText: prompt, sentinel }) : '');
    const shot = this.cfg.captureScreenshot
      ? await this.computer.screenshot({ sessionId: this.sessionId, signal: this.signal }).catch(() => null)
      : null;
    const common = {
      window: title,
      inputVia: input.via,
      readVia: viaVision ? 'vision' : 'uia',
      detection: wait.reason,
      polls: wait.polls,
      elapsedMs: this.now() - started,
      screenshot: shot && shot.ok ? shot.data_url : null,
      trace: this.trace.map(t => t.state),
      ...(degraded || {}),
      ...(viaVision ? {
        visionCalls: wait.visionCalls || 0,
        visionModel: this.vision ? this.vision.model : null,
        visionModelSource: this.vision ? this.vision.source : null,
        confidence: wait.confidence != null ? wait.confidence : null
      } : {})
    };

    if (wait.reason === 'cancelled') {
      this.setState('cancelled');
      return this.result('cancelled', answer, common);
    }
    if (wait.reason === 'timeout' || VISION_TIMEOUT_REASONS.includes(wait.reason)) {
      this.setState('timeout');
      const budget = wait.reason === 'vision-budget'
        ? `视觉读屏已用满 ${this.cfg.visionMaxCalls} 次预算，对方仍在输出；以上为已读到的部分内容。`
        : `等待 ${Math.round((viaVision ? this.cfg.visionTimeoutMs : this.cfg.timeoutMs) / 1000)} 秒后对方仍在输出或无响应；以上为已捕获的部分内容。`;
      return this.result('timeout', answer, { ...common, errors: [budget] });
    }
    if (wait.reason === 'unreadable' || wait.reason === 'vision-unavailable') {
      this.setState('failed');
      const hint = this.cfg.visionFallback === false
        ? '该窗口未暴露 UI 自动化文本，且本适配器已关闭视觉降级（visionFallback=false）。'
        : `该窗口未暴露 UI 自动化文本，已尝试降级为截图 + 视觉模型，但${wait.error || '没有可用的视觉模型'}`;
      return this.result('failed', '', {
        ...common,
        code: 'VISION_MODEL_REQUIRED',
        errors: [`${hint}请在「连接」里配置一个支持图片输入的模型（如 gpt-4o / claude-sonnet-4 / qwen-vl / llava），或为该应用配置 inputAutomationId。`]
      });
    }
    if (wait.reason === 'vision-exhausted') {
      this.setState('failed');
      return this.result('failed', '', {
        ...common,
        errors: [`视觉读屏进行了 ${wait.visionCalls || 0} 次仍未读到任何回答，画面可能一直在变化或被遮挡。`]
      });
    }
    if (wait.reason === 'vision-app-error') {
      this.setState('failed');
      return this.result('failed', answer, {
        ...common,
        errors: [`视觉读屏发现目标应用处于异常状态：${wait.error || '未知'}`]
      });
    }
    if (!answer || answer.length < this.cfg.minAnswerChars) {
      this.setState('failed');
      return this.result('failed', '', { ...common, errors: ['已发送任务，但未能从窗口读到新的回答内容。'] });
    }

    this.setState('completed', { chars: answer.length, via: common.readVia });
    return this.result('completed', answer, common);
  }

  result(status, summary, extra = {}) {
    return {
      status,
      summary: String(summary || '').slice(0, 4000),
      findings: [], changedFiles: [], artifacts: [], errors: [],
      ...extra
    };
  }
}

module.exports = {
  DesktopAgentBridge, diffAnswer, hash, normalise,
  BUSY_PATTERNS, DEFAULTS, VISION_TIMEOUT_REASONS
};
