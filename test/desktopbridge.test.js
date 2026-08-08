'use strict';
/**
 * P0-2 Test Harness for DesktopAgentBridge.
 *
 * This is NOT a mock of the bridge — it is the real state machine, real input
 * priority chain and real completion detection, driven by a scriptable fake
 * desktop app. The clock and sleep are injected so a 180-second production
 * timeout is exercised in microseconds.
 *
 * The behaviour under test is exactly what v2.0.0 got wrong:
 *   - it slept 3s and reported `completed` no matter what
 *   - it never read anything back
 *   - a timeout was indistinguishable from success
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  DesktopAgentBridge, diffAnswer, hash, normalise, BUSY_PATTERNS
} = require('../src/services/desktopBridge');

/* ------------------------------------------------------------------ harness */

/**
 * A scriptable stand-in for a chat-style desktop app.
 * `script` is a function (pollIndex, ctx) => string returning the full window
 * text at that poll, so each test can describe its own streaming behaviour.
 */
function fakeApp({
  title = 'WorkBuddy — 工作台',
  windows = null,
  script,
  supports = { uia: true, clipboard: true, type: true, text: true },
  focusOk = true,
  submitOk = true
} = {}) {
  const calls = [];
  const state = { poll: 0, sentinel: '', submitted: false, typed: '' };
  const app = {
    calls, state,
    listWindows: async () => {
      calls.push('listWindows');
      return { ok: true, windows: windows || [{ pid: 7, title }] };
    },
    focusWindow: async (t) => {
      calls.push('focusWindow:' + t);
      return focusOk ? { ok: true } : { ok: false, error: '窗口被最小化' };
    },
    pressKeys: async (k) => {
      calls.push('pressKeys:' + k);
      if (k === '~' || k === '{ENTER}') {
        if (!submitOk) return { ok: false, error: '按键被拦截' };
        state.submitted = true;
      }
      return { ok: true };
    }
  };
  const capture = (text) => {
    state.typed = text;
    const m = /ADP-[A-Z0-9]{6}/.exec(text);
    if (m) state.sentinel = m[0];
  };
  if (supports.uia) {
    app.setControlValue = async (_t, text) => { calls.push('setControlValue'); capture(text); return { ok: true }; };
  }
  if (supports.clipboard) {
    app.setClipboard = async (text) => { calls.push('setClipboard'); capture(text); return { ok: true }; };
  }
  if (supports.type) {
    app.typeText = async (text) => { calls.push('typeText'); capture(text); return { ok: true }; };
  }
  if (supports.text) {
    app.getWindowText = async () => {
      const i = state.poll++;
      calls.push('getWindowText#' + i);
      return { ok: true, text: script(i, state) };
    };
  }
  app.screenshot = async () => ({ ok: true, data_url: 'data:image/png;base64,SHOT' });
  return app;
}

/** A clock that jumps forward by the amount each injected sleep asks for. */
function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; }
  };
}

function build(app, config = {}, extra = {}) {
  const clock = fakeClock();
  const states = [];
  const bridge = new DesktopAgentBridge({
    computer: app,
    config: { pollIntervalMs: 100, timeoutMs: 5000, stableChecks: 3, ...config },
    now: clock.now,
    sleep: clock.sleep,
    onState: (s) => states.push(s),
    ...extra
  });
  return { bridge, clock, states };
}

/* --------------------------------------------------------------- unit bits */

test('DesktopBridge: hash 对相同文本稳定、对不同文本区分', () => {
  assert.strictEqual(hash('abc'), hash('abc'));
  assert.notStrictEqual(hash('abc'), hash('abd'));
  assert.notStrictEqual(hash('abc'), hash('abc '));
});

test('DesktopBridge: normalise 折叠空白但保留换行结构', () => {
  assert.strictEqual(normalise('a  \t b\r\nc '), 'a b\nc');
});

test('DesktopBridge: BUSY_PATTERNS 能识别中英文忙碌指示器', () => {
  const hits = ['正在生成回复', '思考中...', 'Stop', 'Generating…'];
  for (const h of hits) {
    assert.ok(BUSY_PATTERNS.some(re => re.test(h)), `应识别忙碌态: ${h}`);
  }
  assert.ok(!BUSY_PATTERNS.some(re => re.test('回答完毕')), '普通文本不应被判忙碌');
});

test('DesktopBridge: diffAnswer 只取新增内容并剔除回显的提示词与标记', () => {
  const before = '欢迎使用\n历史消息 A';
  const sentinel = 'ADP-ABC123';
  const prompt = `帮我算 2+2\n\n回答完成后请在最后单独一行输出 ${sentinel}`;
  const after = `欢迎使用\n历史消息 A\n帮我算 2+2\n回答完成后请在最后单独一行输出 ${sentinel}\n答案是 4\n${sentinel}`;
  const got = diffAnswer(before, after, { taskText: prompt, sentinel });
  assert.strictEqual(got, '答案是 4');
});

/* ---------------------------------------------------------- state machine */

test('DesktopBridge: 找不到目标窗口时失败并给出可操作提示', async () => {
  const app = fakeApp({ windows: [{ pid: 1, title: '记事本' }], script: () => '' });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'failed');
  assert.match(r.errors[0], /未找到 WorkBuddy 窗口/);
  assert.strictEqual(bridge.state, 'failed');
});

test('DesktopBridge: 聚焦失败时不继续输入，避免把内容打到别的应用里', async () => {
  const app = fakeApp({ focusOk: false, script: () => 'x' });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'failed');
  assert.match(r.errors[0], /无法聚焦窗口/);
  assert.ok(!app.calls.includes('setControlValue'), '聚焦失败后不应再尝试输入');
});

test('DesktopBridge: sentinel 命中时返回对方真实回答（完整状态流转）', async () => {
  const answer = '已完成重构，共修改 4 个文件。';
  const app = fakeApp({
    script: (i, st) => i === 0
      ? '历史消息'
      : `历史消息\n重构 utils\n${answer}\n${st.sentinel}`
  });
  const { bridge, states } = build(app);
  const r = await bridge.run('重构 utils');

  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.detection, 'sentinel');
  assert.strictEqual(r.summary, answer);
  assert.strictEqual(r.inputVia, 'uia-value', '有 UIA 时应优先走 ValuePattern');
  assert.deepStrictEqual(
    states,
    ['locating', 'focusing', 'inputting', 'submitted', 'waiting', 'reading', 'completed'],
    '状态机必须按 locating→...→completed 完整流转'
  );
});

test('DesktopBridge: 无 sentinel 时靠"输出增长后趋于稳定"判完成', async () => {
  // 逐字流式输出，第 4 次之后不再变化
  const frames = ['基线', '基线\n答', '基线\n答案', '基线\n答案是 42', '基线\n答案是 42'];
  const app = fakeApp({ script: (i) => frames[Math.min(i, frames.length - 1)] });
  const { bridge } = build(app, { useSentinel: false, stableChecks: 3 });
  const r = await bridge.run('终极问题');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.detection, 'stabilised');
  assert.strictEqual(r.summary, '答案是 42');
});

test('DesktopBridge: 忙碌指示器出现后消失即判完成', async () => {
  const frames = [
    '基线',
    '基线\n正在生成回复',
    '基线\n正在生成回复\n部分结果',
    '基线\n部分结果 完整了',
    '基线\n部分结果 完整了'
  ];
  const app = fakeApp({ script: (i) => frames[Math.min(i, frames.length - 1)] });
  const { bridge } = build(app, { useSentinel: false, stableChecks: 99 });
  const r = await bridge.run('干活');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.detection, 'busy-cleared', 'stableChecks 设得极高，只可能靠 busy 消失命中');
});

test('DesktopBridge: 对方一直在输出时返回 timeout 而不是 completed', async () => {
  // 永远在变化 —— 经典的"模型停不下来"场景
  const app = fakeApp({ script: (i) => '基线\n持续输出 ' + i });
  const { bridge } = build(app, { useSentinel: false, timeoutMs: 1000, pollIntervalMs: 100 });
  const r = await bridge.run('写一本书');
  assert.strictEqual(r.status, 'timeout', 'v2.0.0 在这里会谎报 completed');
  assert.ok(r.polls >= 9, '应确实轮询过');
  assert.match(r.errors[0], /仍在输出或无响应/);
  assert.ok(r.summary.length > 0, 'timeout 也应交回已捕获的部分内容');
});

test('DesktopBridge: 窗口不暴露 UIA 文本时立刻诚实失败，不空耗超时', async () => {
  const app = fakeApp({ supports: { uia: true, clipboard: true, type: true, text: false }, script: () => '' });
  const { bridge, clock } = build(app, { timeoutMs: 180000 });
  const t0 = clock.now();
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'failed');
  assert.match(r.errors[0], /未暴露 UI 自动化文本/);
  assert.ok(clock.now() - t0 < 1000, '不可读应立即返回，而不是耗满 180s');
});

test('DesktopBridge: 用户按 Stop 时返回 cancelled', async () => {
  const ac = new AbortController();
  let n = 0;
  const app = fakeApp({
    script: (i) => { if (++n === 2) ac.abort(); return '基线\n输出 ' + i; }
  });
  const { bridge } = build(app, { useSentinel: false, timeoutMs: 60000 }, { signal: ac.signal });
  const r = await bridge.run('长任务');
  assert.strictEqual(r.status, 'cancelled');
});

/* ------------------------------------------------------- input priority chain */

test('DesktopBridge: UIA 不可用时自动降级到剪贴板粘贴', async () => {
  const app = fakeApp({
    supports: { uia: false, clipboard: true, type: true, text: true },
    script: (i, st) => i === 0 ? '基线' : `基线\n结果\n${st.sentinel}`
  });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.inputVia, 'clipboard');
  assert.ok(app.calls.includes('setClipboard'));
  assert.ok(app.calls.includes('pressKeys:^v'), '剪贴板路径必须真的发出 Ctrl+V');
});

test('DesktopBridge: UIA 与剪贴板都失败时降级到 SendKeys 键入', async () => {
  const app = fakeApp({
    supports: { uia: true, clipboard: true, type: true, text: true },
    script: (i, st) => i === 0 ? '基线' : `基线\n结果\n${st.sentinel}`
  });
  app.setControlValue = async () => ({ ok: false, error: '控件无 ValuePattern' });
  app.setClipboard = async () => ({ ok: false, error: '剪贴板被占用' });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.inputVia, 'sendkeys');
});

test('DesktopBridge: 三种输入方式全失败时如实报错并附带每一步原因', async () => {
  const app = fakeApp({ script: () => '基线' });
  app.setControlValue = async () => ({ ok: false, error: '无 ValuePattern' });
  app.setClipboard = async () => { throw new Error('剪贴板拒绝访问'); };
  app.typeText = async () => ({ ok: false, error: 'SendKeys 被安全策略拦截' });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'failed');
  assert.match(r.errors[0], /三种输入方式全部失败/);
  assert.strictEqual(r.attempts.length, 3, '三次尝试都应留痕');
  assert.match(r.attempts[1].error, /剪贴板拒绝访问/);
});

test('DesktopBridge: 提交按键失败时不谎称已派发任务', async () => {
  const app = fakeApp({ submitOk: false, script: () => '基线' });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'failed');
  assert.match(r.errors[0], /提交（回车）失败/);
});

test('DesktopBridge: 读到的新内容太短时判为未取得结果', async () => {
  const app = fakeApp({ script: (i, st) => i === 0 ? '基线' : `基线\n${st.sentinel}` });
  const { bridge } = build(app);
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'failed');
  assert.match(r.errors[0], /未能从窗口读到新的回答内容/);
});

test('DesktopBridge: 开启截图时把截图一并带回', async () => {
  const app = fakeApp({ script: (i, st) => i === 0 ? '基线' : `基线\n有效回答内容\n${st.sentinel}` });
  const { bridge } = build(app, { captureScreenshot: true });
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.screenshot, 'data:image/png;base64,SHOT');
});

test('DesktopBridge: 支持按标题精确匹配非 WorkBuddy 的第三方应用', async () => {
  const app = fakeApp({
    windows: [{ pid: 1, title: 'WorkBuddy' }, { pid: 2, title: 'Cursor — main.ts' }],
    script: (i, st) => i === 0 ? '基线' : `基线\n来自 Cursor 的回答\n${st.sentinel}`
  });
  const { bridge } = build(app, { windowTitle: 'Cursor' });
  const r = await bridge.run('任务');
  assert.strictEqual(r.status, 'completed');
  assert.strictEqual(r.window, 'Cursor — main.ts');
  assert.match(r.summary, /来自 Cursor 的回答/);
});
