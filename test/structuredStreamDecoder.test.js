'use strict';
/**
 * v2.8.0 — StructuredStreamDecoder 单测（spec §60/§61/§62/§126）。
 *
 * 这一层是所有外部 Agent 协议流的地基：ACP / Codex App Server / codex exec --json /
 * claude -p --output-format stream-json 全部依赖它把 stdout 切成结构化消息。
 * 它一旦出错，表现是"事件静默丢失"，比崩溃更难排查 —— 所以这里测得细一点。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  createStructuredStreamDecoder,
  DEFAULT_FRAME_LIMIT_BYTES,
  DEFAULT_MALFORMED_THRESHOLD
} = require('../src/agents/runtime/structuredStreamDecoder');

function collect(decoder) {
  const out = { messages: [], malformed: [], errors: [] };
  decoder.on('message', m => out.messages.push(m));
  decoder.on('malformed', i => out.malformed.push(i));
  decoder.on('error', i => out.errors.push(i));
  return out;
}

test('JSONL：一次喂入多行，逐条解析', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  d.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
  assert.deepStrictEqual(got.messages.map(m => m.type), ['a', 'b', 'c']);
  assert.strictEqual(got.malformed.length, 0);
});

test('跨 chunk 的半行会被缓冲，直到收到换行才解析', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  d.push('{"type":"split","va');
  assert.strictEqual(got.messages.length, 0, '半行不得提前解析');
  assert.ok(d.pendingBytes() > 0);
  d.push('lue":42}\n');
  assert.deepStrictEqual(got.messages, [{ type: 'split', value: 42 }]);
  assert.strictEqual(d.pendingBytes(), 0);
});

test('UTF-8 多字节字符被 chunk 边界劈开时不得乱码', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  const full = Buffer.from('{"text":"中文测试"}\n', 'utf8');
  // 在"中"字的 3 个字节中间切开
  const cut = full.indexOf(Buffer.from('中', 'utf8')) + 1;
  d.push(full.subarray(0, cut));
  d.push(full.subarray(cut));
  assert.strictEqual(got.messages.length, 1);
  assert.strictEqual(got.messages[0].text, '中文测试');
});

test('CRLF 行尾兼容（Windows 子进程常见）', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  d.push('{"os":"win"}\r\n{"os":"posix"}\n');
  assert.deepStrictEqual(got.messages.map(m => m.os), ['win', 'posix']);
});

test('空行被忽略，不算畸形', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  d.push('\n\n{"ok":true}\n\n');
  assert.strictEqual(got.messages.length, 1);
  assert.strictEqual(got.malformed.length, 0);
});

test('单条畸形 JSON 只报 malformed，不中断后续消息', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  d.push('{"good":1}\nnot json at all\n{"good":2}\n');
  assert.deepStrictEqual(got.messages.map(m => m.good), [1, 2]);
  assert.strictEqual(got.malformed.length, 1);
  assert.strictEqual(got.malformed[0].error, 'INVALID_JSON');
  assert.strictEqual(got.errors.length, 0, '单条畸形不得升级为协议错误');
});

test('单帧超过上限 → FRAME_TOO_LARGE，且不尝试解析', () => {
  const d = createStructuredStreamDecoder({ frameLimitBytes: 64 });
  const got = collect(d);
  d.push(JSON.stringify({ blob: 'x'.repeat(500) }) + '\n');
  assert.strictEqual(got.messages.length, 0);
  assert.strictEqual(got.malformed.length, 1);
  assert.strictEqual(got.malformed[0].error, 'FRAME_TOO_LARGE');
  assert.strictEqual(got.malformed[0].limit, 64);
});

test('连续畸形达到阈值 → AGENT_PROTOCOL_ERROR，并停止继续解析（不 crash 宿主）', () => {
  const d = createStructuredStreamDecoder({ malformedThreshold: 3 });
  const got = collect(d);
  d.push('bad1\nbad2\nbad3\n{"after":"corrupt"}\n');
  assert.strictEqual(got.errors.length, 1);
  assert.strictEqual(got.errors[0].code, 'AGENT_PROTOCOL_ERROR');
  assert.strictEqual(got.errors[0].reason, 'MALFORMED_STREAM');
  assert.ok(d.isCorrupted());
  assert.strictEqual(got.messages.length, 0, '进入损坏状态后不得再产出消息');
});

test('中途出现的合法消息会重置连续畸形计数', () => {
  const d = createStructuredStreamDecoder({ malformedThreshold: 3 });
  const got = collect(d);
  d.push('bad\nbad\n{"ok":1}\nbad\nbad\n');
  assert.strictEqual(got.errors.length, 0, '计数被重置，不应触发协议错误');
  assert.strictEqual(got.malformed.length, 4);
  assert.strictEqual(got.messages.length, 1);
});

test('flush() 处理没有换行结尾的最后一行（进程退出场景）', () => {
  const d = createStructuredStreamDecoder();
  const got = collect(d);
  d.push('{"last":true}');
  assert.strictEqual(got.messages.length, 0);
  d.flush();
  assert.deepStrictEqual(got.messages, [{ last: true }]);
});

test('reset() 清空缓冲与损坏状态，实例可复用', () => {
  const d = createStructuredStreamDecoder({ malformedThreshold: 1 });
  const got = collect(d);
  d.push('bad\n');
  assert.ok(d.isCorrupted());
  d.reset();
  assert.ok(!d.isCorrupted());
  d.push('{"revived":true}\n');
  assert.deepStrictEqual(got.messages, [{ revived: true }]);
});

test('监听器抛错不得破坏解码器', () => {
  const d = createStructuredStreamDecoder();
  const seen = [];
  d.on('message', m => { seen.push(m); throw new Error('listener boom'); });
  assert.doesNotThrow(() => d.push('{"n":1}\n{"n":2}\n'));
  assert.deepStrictEqual(seen.map(m => m.n), [1, 2]);
});

test('默认常量与文档一致（4 MiB / 10 次）', () => {
  assert.strictEqual(DEFAULT_FRAME_LIMIT_BYTES, 4 * 1024 * 1024);
  assert.strictEqual(DEFAULT_MALFORMED_THRESHOLD, 10);
});
