'use strict';
/**
 * v2.3.0 — WorkBuddy 空 UIA 文本阈值测试（P0 修复）。
 *
 * 问题：窗口刚加载、或 Electron 应用 accessibility 未就绪时，UIA 会瞬间返回
 * null / "" / 纯空白。v2.2.0 把「一次空文本」直接判定为 unreadable 并降级到视觉，
 * 造成大量误降级。
 *
 * 修复：连续 `uiaEmptyThreshold`（=3）次空文本才判定 unreadable；中间一旦拿到
 * 有效文本即重置计数。本测试用注入的时钟驱动真实 waitForCompletion 状态机。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { DesktopAgentBridge } = require('../src/services/desktopBridge');

// 可注入时钟的假 computer，仅实现 waitForCompletion 需要的 getWindowText。
// 注意：bridge.readWindowText 期望返回 { ok:true, text }，而不是裸字符串。
function makeBridge(textProvider) {
  let clock = 0;
  const computer = { getWindowText: async () => ({ ok: true, text: textProvider() }) };
  const sleep = (ms) => { clock += (ms || 0); return Promise.resolve(); };
  const now = () => clock;
  const bridge = new DesktopAgentBridge({
    computer,
    config: { timeoutMs: 100000, pollIntervalMs: 1, stableChecks: 1, quietMs: 1, useSentinel: false },
    sleep, now
  });
  return bridge;
}

test('连续 3 次空文本才判定 unreadable（单次空不降级）', async () => {
  let polls = 0;
  const bridge = makeBridge(() => {
    polls++;
    return null; // 一直空
  });
  const r = await bridge.waitForCompletion('Win', { baseline: '', sentinel: null });
  assert.strictEqual(r.reason, 'unreadable', '连续空应最终 unreadable');
  assert.ok(polls >= 3, '应在累计 >=3 次空后才降级，实际 polls=' + polls);
});

test('空文本后拿到有效内容则重置计数，不误降级', async () => {
  let polls = 0;
  const bridge = makeBridge(() => {
    polls++;
    // 第 1 次空，第 2 次起返回真实回答
    return polls === 1 ? '' : '已为你创建文件 src/app.js';
  });
  const r = await bridge.waitForCompletion('Win', { baseline: '', sentinel: null });
  assert.notStrictEqual(r.reason, 'unreadable', '单次空后恢复，不应降级');
  assert.ok((r.text || '').includes('src/app.js'), '应读到真实回答');
});

test('纯空白文本也视为空（trim 修复）', async () => {
  let polls = 0;
  const bridge = makeBridge(() => {
    polls++;
    return polls === 1 ? '   \t  ' : '完成：已写入配置';
  });
  const r = await bridge.waitForCompletion('Win', { baseline: '', sentinel: null });
  assert.notStrictEqual(r.reason, 'unreadable', '空白应等同空，恢复后不降级');
  assert.ok((r.text || '').includes('完成'), '应读到真实回答');
});

test('首轮即有内容时正常稳定完成', async () => {
  const bridge = makeBridge(() => '模型已生成代码并保存');
  const r = await bridge.waitForCompletion('Win', { baseline: '', sentinel: null });
  assert.notStrictEqual(r.reason, 'unreadable');
  assert.ok((r.text || '').includes('生成代码'), '应读到内容');
});
