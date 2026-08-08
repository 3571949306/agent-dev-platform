'use strict';
/**
 * v2.3.0 — i18n 中文显示层契约测试。
 *
 * 内部 IPC channel / Tool ID / Event ID / DB 字段保持英文不变；
 * 这里只验证「用户可见显示名」映射正确，且未知 ID 安全回退为原文。
 *
 * 注：i18n.js 是渲染进程 ES Module（浏览器以 <script type=module> 加载）。
 * 由于仓库 package.json 未声明 "type":"module"，Node 会把 .js 当作 CommonJS，
 * 故此处将其复制到临时 .mjs 后按 ESM 导入，确保测试的就是真实文件内容。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function loadI18n() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), 'i18n-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.mjs');
  fs.writeFileSync(tmp, src);
  try {
    return await import('file://' + tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

test('i18n 显示层映射正确', async () => {
  const i18n = await loadI18n();

  assert.strictEqual(i18n.toolName('read_file'), '读取文件');
  assert.strictEqual(i18n.toolName('terminal_run'), '运行命令');
  assert.strictEqual(i18n.toolName('computer_screenshot'), '屏幕截图');
  assert.strictEqual(i18n.toolName('send_message_to_chat'), '向其他对话派发任务');

  assert.strictEqual(i18n.eventName('run_completed'), '运行完成');
  assert.strictEqual(i18n.eventName('tool_call'), '调用工具');
  assert.strictEqual(i18n.eventName('run_state_changed'), '运行状态变更');

  assert.strictEqual(i18n.runStatus('preparing'), '准备中');
  assert.strictEqual(i18n.runStatus('waiting_external_agent'), '等待外部智能体');
  assert.strictEqual(i18n.runStatus('interrupted'), '已中断');

  assert.strictEqual(i18n.sourceName('remote'), 'API 获取');
  assert.strictEqual(i18n.sourceName('manual'), '手动添加');
  assert.strictEqual(i18n.sourceName('preset'), '内置推荐');
  assert.strictEqual(i18n.sourceName('cached'), '本地缓存');
});

test('i18n 未知 ID 安全回退为原文', async () => {
  const i18n = await loadI18n();
  const unknown = 'some_future_tool_xyz';
  assert.strictEqual(i18n.toolName(unknown), unknown);
  assert.strictEqual(i18n.eventName(unknown), unknown);
  assert.strictEqual(i18n.runStatus(unknown), unknown);
  assert.strictEqual(i18n.sourceName(unknown), unknown);
});

test('isTerminal 正确识别终态', async () => {
  const i18n = await loadI18n();
  for (const s of ['completed', 'failed', 'cancelled', 'timeout', 'interrupted']) {
    assert.strictEqual(i18n.isTerminal(s), true, s + ' 应视为终态');
  }
  for (const s of ['preparing', 'streaming', 'executing_tool', 'waiting_permission', 'waiting_external_agent']) {
    assert.strictEqual(i18n.isTerminal(s), false, s + ' 应视为非终态');
  }
});
