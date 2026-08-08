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
 * Everything is injected (`computer`, `now`, `sleep`), which is what makes the
 * Test Harness in test/desktopbridge.test.js a real end-to-end exercise of this
 * logic rather than a mock of it.
 */

const DEFAULTS = {
  windowMatch: /workbuddy/i,
  pollIntervalMs: 1200,
  quietMs: 2500,          // how long the text must stay unchanged
  stableChecks: 3,        // consecutive unchanged polls required
  timeoutMs: 180000,
  minAnswerChars: 2,
  useSentinel: true,
  captureScreenshot: false
};

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
   */
  constructor(opts = {}) {
    this.computer = opts.computer;
    this.cfg = { ...DEFAULTS, ...(opts.config || {}) };
    if (typeof this.cfg.windowMatch === 'string') this.cfg.windowMatch = new RegExp(this.cfg.windowMatch, 'i');
    this.onState = opts.onState || (() => {});
    this.signal = opts.signal || null;
    this.sleep = opts.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    this.now = opts.now || (() => Date.now());
    this.state = 'idle';
    this.trace = [];
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
    const r = await this.computer.listWindows();
    if (!r || r.ok === false) return { ok: false, error: '无法枚举窗口：' + ((r && r.error) || '未知错误') };
    const wanted = this.cfg.windowTitle;
    const list = (r.windows || []).filter(w => {
      const t = `${w.title || ''} ${w.name || ''}`;
      return wanted ? t.includes(wanted) : this.cfg.windowMatch.test(t);
    });
    if (!list.length) {
      return { ok: false, error: `未找到${wanted ? `标题包含「${wanted}」的` : ' WorkBuddy '}窗口，请先打开桌面应用并保持在前台可见。` };
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

    if (this.cfg.inputMode !== 'keys' && this.cfg.inputMode !== 'clipboard') {
      try {
        const r = await this.computer.setControlValue(title, text, { automationId: this.cfg.inputAutomationId || '' });
        if (r && r.ok) return { ok: true, via: 'uia-value', attempts };
        attempts.push({ via: 'uia-value', error: (r && r.error) || 'ValuePattern 不可用' });
      } catch (e) { attempts.push({ via: 'uia-value', error: e.message }); }
    }

    if (this.cfg.inputMode !== 'keys' && typeof this.computer.setClipboard === 'function') {
      try {
        const c = await this.computer.setClipboard(text);
        if (c && c.ok !== false) {
          const paste = await this.computer.pressKeys('^v');
          if (paste && paste.ok !== false) return { ok: true, via: 'clipboard', attempts };
          attempts.push({ via: 'clipboard', error: (paste && paste.error) || '粘贴失败' });
        } else {
          attempts.push({ via: 'clipboard', error: (c && c.error) || '写入剪贴板失败' });
        }
      } catch (e) { attempts.push({ via: 'clipboard', error: e.message }); }
    }

    try {
      const t = typeof this.computer.typeText === 'function'
        ? await this.computer.typeText(text)
        : await this.computer.pressKeys(String(text).replace(/[+^%~(){}\[\]]/g, m => '{' + m + '}'));
      if (t && t.ok !== false) return { ok: true, via: 'sendkeys', attempts };
      attempts.push({ via: 'sendkeys', error: (t && t.error) || '按键发送失败' });
    } catch (e) { attempts.push({ via: 'sendkeys', error: e.message }); }

    return { ok: false, error: '三种输入方式全部失败', attempts };
  }

  async submit() {
    const r = await this.computer.pressKeys(this.cfg.submitKeys || '~');
    this.setState('submitted', { ok: r && r.ok !== false });
    return r && r.ok !== false;
  }

  // -------------------------------------------------- completion detection
  async readWindowText(title) {
    if (typeof this.computer.getWindowText !== 'function') return null;
    const r = await this.computer.getWindowText(title);
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

    while (this.now() < deadline) {
      if (this.aborted()) return { done: false, reason: 'cancelled', text: latest, polls };
      await this.sleep(this.cfg.pollIntervalMs);
      polls++;
      const text = await this.readWindowText(title);
      if (text == null) {
        // No UIA text available (some Electron apps expose nothing). Fall back to
        // a bounded wait and report honestly that we could not verify.
        if (this.now() >= deadline - this.cfg.pollIntervalMs) {
          return { done: false, reason: 'unreadable', text: null, polls };
        }
        continue;
      }
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

  // ----------------------------------------------------------------- run
  /**
   * @returns {{status:'completed'|'failed'|'timeout'|'cancelled', summary:string, ...}}
   */
  async run(taskText) {
    const started = this.now();
    const loc = await this.locateWindow();
    if (!loc.ok) { this.setState('failed', { error: loc.error }); return this.result('failed', '', { errors: [loc.error] }); }

    const title = loc.window.title;
    this.setState('focusing', { title });
    const focused = await this.computer.focusWindow(title);
    if (focused && focused.ok === false) {
      const err = `无法聚焦窗口「${title}」：${focused.error || '未知原因'}`;
      this.setState('failed', { error: err });
      return this.result('failed', '', { errors: [err], window: title });
    }

    const baseline = (await this.readWindowText(title)) || '';

    const sentinel = this.cfg.useSentinel ? makeSentinel() : null;
    const prompt = sentinel
      ? `${taskText}\n\n回答完成后请在最后单独一行输出 ${sentinel}`
      : taskText;

    const input = await this.inputTask(title, prompt);
    if (!input.ok) {
      this.setState('failed', { error: input.error });
      return this.result('failed', '', { errors: [input.error], attempts: input.attempts, window: title });
    }
    if (!(await this.submit())) {
      const err = '任务已输入但提交（回车）失败';
      this.setState('failed', { error: err });
      return this.result('failed', '', { errors: [err], window: title, inputVia: input.via });
    }

    const wait = await this.waitForCompletion(title, { baseline, sentinel });

    this.setState('reading', { reason: wait.reason });
    const answer = wait.text ? diffAnswer(baseline, wait.text, { taskText: prompt, sentinel }) : '';
    const shot = this.cfg.captureScreenshot ? await this.computer.screenshot().catch(() => null) : null;
    const common = {
      window: title,
      inputVia: input.via,
      detection: wait.reason,
      polls: wait.polls,
      elapsedMs: this.now() - started,
      screenshot: shot && shot.ok ? shot.data_url : null,
      trace: this.trace.map(t => t.state)
    };

    if (wait.reason === 'cancelled') {
      this.setState('cancelled');
      return this.result('cancelled', answer, common);
    }
    if (wait.reason === 'timeout') {
      this.setState('timeout');
      return this.result('timeout', answer, {
        ...common,
        errors: [`等待 ${Math.round(this.cfg.timeoutMs / 1000)} 秒后对方仍在输出或无响应；以上为已捕获的部分内容。`]
      });
    }
    if (wait.reason === 'unreadable') {
      this.setState('failed');
      return this.result('failed', '', {
        ...common,
        errors: ['该窗口未暴露 UI 自动化文本，无法确认执行结果。请改用截图 + 视觉模型，或为该应用配置 inputAutomationId。']
      });
    }
    if (!answer || answer.length < this.cfg.minAnswerChars) {
      this.setState('failed');
      return this.result('failed', '', { ...common, errors: ['已发送任务，但未能从窗口读到新的回答内容。'] });
    }

    this.setState('completed', { chars: answer.length });
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

module.exports = { DesktopAgentBridge, diffAnswer, hash, normalise, BUSY_PATTERNS, DEFAULTS };
