'use strict';
/**
 * P0-4 Test Harness — UIA → Vision automatic degradation.
 *
 * This is NOT a mock of the fallback. It runs the real DesktopAgentBridge state
 * machine and the real DesktopVisionReader against:
 *   - a "blind" desktop app that exposes NO UI-automation text (the exact case
 *     v2.1.0 gave up on with `failed: 该窗口未暴露 UI 自动化文本`)
 *   - a scriptable screen whose frames are real base64 payloads, so the frame
 *     hashing / dedupe logic is genuinely exercised
 *   - a scripted vision model that actually reads those frames back
 *
 * The regressions being locked down:
 *   1. a readable-on-screen answer must come back as `completed`, not `failed`
 *   2. an unchanged frame must NOT cost a model call (images are expensive)
 *   3. no vision model configured must fail LOUDLY with VISION_MODEL_REQUIRED,
 *      never with a fabricated success
 *   4. Stop must still win, mid-vision-poll
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { DesktopAgentBridge } = require('../src/services/desktopBridge');
const { DesktopVisionReader, imageHash, extractJson } = require('../src/services/visionReader');

/* ------------------------------------------------------------------ harness */

/** Encode a "screen" into a real data URL so hashing behaves like production. */
function frameUrl(text) {
  return 'data:image/png;base64,' + Buffer.from(String(text), 'utf8').toString('base64');
}

/**
 * A desktop app that can be typed into but exposes no automation text at all.
 * `frames` is (pollIndex) => string: what is visibly on screen at that moment.
 */
function blindApp({
  title = 'Codex Desktop',
  frames,
  windowShots = true,
  shotFails = false
} = {}) {
  const calls = [];
  const state = { shot: 0, sentinel: '', typed: '' };
  const capture = (text) => {
    state.typed = text;
    const m = /ADP-[A-Z0-9]{6}/.exec(text);
    if (m) state.sentinel = m[0];
  };
  const app = {
    calls, state,
    listWindows: async () => { calls.push('listWindows'); return { ok: true, windows: [{ pid: 42, title }] }; },
    focusWindow: async () => { calls.push('focusWindow'); return { ok: true }; },
    // No setControlValue and no getWindowText — this window is invisible to UIA.
    setClipboard: async (t) => { calls.push('setClipboard'); capture(t); return { ok: true }; },
    pressKeys: async (k) => { calls.push('pressKeys:' + k); return { ok: true }; },
    typeText: async (t) => { calls.push('typeText'); capture(t); return { ok: true }; }
  };
  const shoot = () => {
    const i = state.shot++;
    calls.push('shot#' + i);
    if (shotFails) return { ok: false, error: '截图失败' };
    return { ok: true, data_url: frameUrl(frames(i, state)), width: 800, height: 600 };
  };
  if (windowShots) app.screenshotWindow = async () => { calls.push('screenshotWindow'); return shoot(); };
  app.screenshot = async () => { calls.push('screenshot'); return shoot(); };
  return app;
}

/**
 * A vision model that really looks at the frame it was handed.
 * `reply(frame, callIndex, promptText)` returns the raw model output.
 */
function scriptedVisionProvider(reply) {
  const seen = [];
  return {
    seen,
    streamResponse: async ({ model, messages }) => {
      const parts = messages[0].content;
      const img = parts.find(p => p.type === 'image');
      const txt = parts.find(p => p.type === 'text');
      assert.ok(img, '视觉请求必须包含图片 part');
      assert.strictEqual(img.type, 'image');
      const frame = Buffer.from(img.data, 'base64').toString('utf8');
      seen.push(frame);
      return { content: reply(frame, seen.length - 1, txt.text), responseModel: model };
    }
  };
}

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

function buildBlind(app, { reply, config = {}, reader = undefined, signal = null } = {}) {
  const clock = fakeClock();
  const states = [];
  const provider = reply ? scriptedVisionProvider(reply) : null;
  const visionReader = reader !== undefined
    ? reader
    : (provider ? new DesktopVisionReader({ provider, model: 'gpt-4o', source: 'tested', label: '主连接 / gpt-4o' }) : null);
  const bridge = new DesktopAgentBridge({
    computer: app,
    config: {
      windowMatch: /codex desktop/i,      // the harness app is not WorkBuddy
      pollIntervalMs: 100, timeoutMs: 3000,
      visionPollMs: 100, visionSlowPollMs: 200, visionTimeoutMs: 3000,
      visionStableChecks: 2, visionMaxCalls: 12,
      ...config
    },
    now: clock.now,
    sleep: clock.sleep,
    signal,
    visionReader,
    onState: (s, d) => states.push({ s, d })
  });
  return { bridge, clock, states, provider, visionReader };
}

const json = (o) => JSON.stringify(o);

/* -------------------------------------------------------------- unit: reader */

test('VisionReader: extractJson 能吃裸 JSON、代码围栏和前置废话', () => {
  assert.deepStrictEqual(extractJson('{"state":"done","answer":"4"}'), { state: 'done', answer: '4' });
  assert.deepStrictEqual(extractJson('```json\n{"state":"idle"}\n```'), { state: 'idle' });
  assert.deepStrictEqual(extractJson('好的，结果如下：\n{"state":"answering","answer":"写到一半"}\n希望有帮助'),
    { state: 'answering', answer: '写到一半' });
  assert.deepStrictEqual(extractJson('{"state":"done","answer":"a",}'), { state: 'done', answer: 'a' });
  assert.strictEqual(extractJson('完全没有 JSON'), null);
});

test('VisionReader: imageHash 对同帧稳定、对不同帧区分', () => {
  assert.strictEqual(imageHash(frameUrl('same')), imageHash(frameUrl('same')));
  assert.notStrictEqual(imageHash(frameUrl('a')), imageHash(frameUrl('b')));
});

test('VisionReader: 未配置视觉模型时报 VISION_MODEL_REQUIRED，不假装成功', async () => {
  const r = new DesktopVisionReader({});
  assert.strictEqual(r.available, false);
  const out = await r.analyze(frameUrl('x'));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'VISION_MODEL_REQUIRED');
  assert.match(out.error, /视觉模型/);
});

test('VisionReader: answer 里出现哨兵时剥离标记并强制判定 done', async () => {
  const provider = scriptedVisionProvider(() => json({ state: 'answering', confidence: 0.9, answer: '答案是 4\nADP-ZZZ999' }));
  const r = new DesktopVisionReader({ provider, model: 'qwen-vl-max' });
  const out = await r.analyze(frameUrl('屏幕'), { sentinel: 'ADP-ZZZ999' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.state, 'done', '哨兵比模型自报的 state 更可信');
  assert.strictEqual(out.answer, '答案是 4');
});

test('VisionReader: 模型不按 JSON 输出但画面有哨兵时能兜底', async () => {
  const provider = scriptedVisionProvider(() => '我看到屏幕上写着：答案是 4\nADP-AAA111');
  const r = new DesktopVisionReader({ provider, model: 'gpt-4o' });
  const out = await r.analyze(frameUrl('屏幕'), { sentinel: 'ADP-AAA111' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.state, 'done');
  assert.match(out.answer, /答案是 4/);
});

test('VisionReader: 模型彻底跑偏时报 VISION_BAD_OUTPUT 而不是编造答案', async () => {
  const provider = scriptedVisionProvider(() => '抱歉，我看不清这张图。');
  const r = new DesktopVisionReader({ provider, model: 'gpt-4o' });
  const out = await r.analyze(frameUrl('屏幕'));
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.code, 'VISION_BAD_OUTPUT');
});

test('VisionReader: 非法 state 被归一化，confidence 被裁剪到 0~1', async () => {
  const provider = scriptedVisionProvider(() => json({ state: '外星状态', confidence: 7, answer: '有内容' }));
  const r = new DesktopVisionReader({ provider, model: 'gpt-4o' });
  const out = await r.analyze(frameUrl('x'));
  assert.strictEqual(out.state, 'answering');
  assert.strictEqual(out.confidence, 1);
});

/* --------------------------------------------------- integration: 降级主链路 */

test('DesktopBridge P0-4: UIA 读不到文本时自动降级视觉并拿回真实答案', async () => {
  const app = blindApp({
    frames: (i) => (i === 0 ? '正在生成…' : `助手：北京今天晴，26℃\n${'ADP'}`)
  });
  const { bridge, states } = buildBlind(app, {
    reply: (frame) => (/正在生成/.test(frame)
      ? json({ state: 'answering', confidence: 0.8, answer: '', note: '还在生成' })
      : json({ state: 'done', confidence: 0.92, answer: '助手：北京今天晴，26℃', note: '没有忙碌指示' }))
  });

  const res = await bridge.run('北京天气怎么样？');
  assert.strictEqual(res.status, 'completed', 'v2.1.0 在这里返回 failed');
  assert.strictEqual(res.summary, '助手：北京今天晴，26℃');
  assert.strictEqual(res.readVia, 'vision');
  assert.strictEqual(res.detection, 'vision-done');
  assert.strictEqual(res.uiaReason, 'unreadable', '应记录降级来源');
  assert.strictEqual(res.visionModel, 'gpt-4o');
  assert.strictEqual(res.visionModelSource, 'tested');
  assert.ok(res.confidence >= 0.9);
  const seq = states.map(x => x.s);
  assert.ok(seq.includes('degrading'), '必须有显式的降级状态供 UI 展示');
  assert.ok(seq.includes('vision-reading'));
  assert.ok(seq.indexOf('degrading') < seq.indexOf('vision-reading'));
});

test('DesktopBridge P0-4: 视觉答案不走 diffAnswer，内容原样返回', async () => {
  // diffAnswer() would strip lines that also appear in the prompt; the vision
  // model already did the extraction, so re-diffing it destroys the answer.
  const app = blindApp({ frames: () => '助手：北京天气怎么样？这个问题的答案是晴' });
  const { bridge } = buildBlind(app, {
    reply: () => json({ state: 'done', confidence: 0.9, answer: '北京天气怎么样？这个问题的答案是晴' })
  });
  const res = await bridge.run('北京天气怎么样？');
  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(res.summary, '北京天气怎么样？这个问题的答案是晴');
});

test('DesktopBridge P0-4: 画面不变时不重复调用视觉模型（成本闸门）', async () => {
  // The app answers on frame 1 and then freezes. Every later poll is the exact
  // same image: a naive implementation would bill one model call per poll.
  const app = blindApp({
    frames: (i) => (i === 0 ? '思考中…' : '助手：42')
  });
  const { bridge, provider } = buildBlind(app, {
    reply: (frame) => (/思考中/.test(frame)
      ? json({ state: 'answering', confidence: 0.7, answer: '' })
      : json({ state: 'answering', confidence: 0.85, answer: '助手：42' })),
    config: { visionStableChecks: 3 }
  });

  const res = await bridge.run('1+41 等于几');
  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(res.detection, 'vision-stable', '冻结画面 + 已读到内容 => 判定完成');
  assert.strictEqual(res.summary, '助手：42');
  assert.strictEqual(provider.seen.length, 2, '只有两帧不同，就只能有两次模型调用');
  assert.ok(res.polls > provider.seen.length, '轮询次数应明显多于模型调用次数');
  assert.strictEqual(res.visionCalls, 2);
});

test('DesktopBridge P0-4: 没有可用视觉模型时报 VISION_MODEL_REQUIRED，绝不假装完成', async () => {
  const app = blindApp({ frames: () => '助手：看得见的答案' });
  const { bridge } = buildBlind(app, { reader: null });
  const res = await bridge.run('随便问点什么');
  assert.strictEqual(res.status, 'failed');
  assert.strictEqual(res.code, 'VISION_MODEL_REQUIRED');
  assert.match(res.errors[0], /支持图片输入的模型/);
  assert.strictEqual(app.calls.filter(c => c === 'screenshotWindow').length, 0, '没有模型就不该白截图');
});

test('DesktopBridge P0-4: visionFallback=false 时保持旧行为并说明原因', async () => {
  const app = blindApp({ frames: () => '助手：答案' });
  const { bridge, states } = buildBlind(app, {
    reply: () => json({ state: 'done', confidence: 1, answer: '答案' }),
    config: { visionFallback: false }
  });
  const res = await bridge.run('问题');
  assert.strictEqual(res.status, 'failed');
  assert.match(res.errors[0], /已关闭视觉降级/);
  assert.ok(!states.map(x => x.s).includes('degrading'));
});

test('DesktopBridge P0-4: 视觉判定目标应用异常（要求登录）时如实失败', async () => {
  const app = blindApp({ frames: () => '请先登录后再使用' });
  const { bridge } = buildBlind(app, {
    reply: () => json({ state: 'error', confidence: 0.95, answer: '', note: '界面提示需要登录' })
  });
  const res = await bridge.run('帮我写段代码');
  assert.strictEqual(res.status, 'failed');
  assert.strictEqual(res.detection, 'vision-app-error');
  assert.match(res.errors[0], /需要登录/);
});

test('DesktopBridge P0-4: 视觉读屏过程中按 Stop 立刻取消', async () => {
  const ac = new AbortController();
  const app = blindApp({ frames: (i) => '第 ' + i + ' 帧，仍在生成' });
  const { bridge } = buildBlind(app, {
    reply: (_f, i) => { if (i >= 1) ac.abort(); return json({ state: 'answering', confidence: 0.8, answer: '' }); },
    signal: ac.signal
  });
  const res = await bridge.run('长任务');
  assert.strictEqual(res.status, 'cancelled');
  assert.strictEqual(res.readVia, 'vision');
});

test('DesktopBridge P0-4: 超出调用预算时返回 timeout + 已读到的部分内容', async () => {
  const app = blindApp({ frames: (i) => `助手：正在写第 ${i} 段…` });
  const { bridge } = buildBlind(app, {
    reply: (_f, i) => json({ state: 'answering', confidence: 0.8, answer: `已写到第 ${i} 段` }),
    config: { visionMaxCalls: 3 }
  });
  const res = await bridge.run('写一篇长文');
  assert.strictEqual(res.status, 'timeout');
  assert.strictEqual(res.detection, 'vision-budget');
  assert.strictEqual(res.visionCalls, 3);
  assert.match(res.summary, /已写到第/, '超预算也要把读到的内容交出来');
  assert.match(res.errors[0], /预算/);
});

test('DesktopBridge P0-4: 低置信度的读数不会被当成答案', async () => {
  const app = blindApp({ frames: (i) => `模糊画面 ${i}` });
  const { bridge } = buildBlind(app, {
    reply: () => json({ state: 'answering', confidence: 0.1, answer: '可能是……看不清' }),
    config: { visionMinConfidence: 0.5, visionMaxCalls: 4 }
  });
  const res = await bridge.run('看看屏幕');
  assert.notStrictEqual(res.status, 'completed');
  assert.strictEqual(res.summary, '', '置信度不够就不能把猜测写进结果');
});

test('DesktopBridge P0-4: 截不到图时不崩溃，如实报无法读取', async () => {
  const app = blindApp({ frames: () => '看不见', shotFails: true, windowShots: true });
  const { bridge } = buildBlind(app, {
    reply: () => json({ state: 'done', confidence: 1, answer: '不应该被调用' }),
    config: { visionMaxCalls: 2 }
  });
  const res = await bridge.run('问题');
  assert.strictEqual(res.status, 'timeout');
  assert.strictEqual(res.detection, 'vision-timeout');
  assert.strictEqual(res.summary, '');
});

test('DesktopBridge P0-4: 没有 screenshotWindow 时回退整屏截图', async () => {
  const app = blindApp({ frames: () => '助手：整屏也能读', windowShots: false });
  const { bridge } = buildBlind(app, {
    reply: () => json({ state: 'done', confidence: 0.9, answer: '整屏也能读' })
  });
  const res = await bridge.run('问题');
  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(res.summary, '整屏也能读');
  assert.ok(app.calls.includes('screenshot'));
});

test('DesktopBridge P0-4: UIA 可读时完全不触发视觉，一次模型调用都不产生', async () => {
  // The cheap path must stay the default — vision is a fallback, not an upgrade.
  const app = blindApp({ frames: () => '不该被看到' });
  let poll = 0;
  app.getWindowText = async () => {
    poll++;
    return { ok: true, text: poll >= 2 ? '历史\n助手：UIA 读到的答案' : '历史' };
  };
  const { bridge, provider, states } = buildBlind(app, {
    reply: () => json({ state: 'done', confidence: 1, answer: '视觉答案' }),
    config: { stableChecks: 1 }
  });
  const res = await bridge.run('问题');
  assert.strictEqual(res.status, 'completed');
  assert.strictEqual(res.readVia, 'uia');
  assert.match(res.summary, /UIA 读到的答案/);
  assert.strictEqual(provider.seen.length, 0, '视觉模型一次都不该被调用');
  assert.ok(!states.map(x => x.s).includes('degrading'));
});
