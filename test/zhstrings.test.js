'use strict';
/**
 * v2.3.1 — P1-7/P1-20 全中文 UI 回归测试。
 *
 * 普通用户可见层不允许出现「Agent / Agents / Main Agent / External Agent」等英文残留
 * （品牌名 Agent Dev Platform、OpenAI、Codex、WorkBuddy、MCP、API、Git 等除外）。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const FORBIDDEN = [
  'Agents 页',          // 导航/提示里的英文页名
  'Main Agent',
  'External Agent',
  '外部 Agent',
  '子 Agent',
  '未指定 Agent',
  '调用外部 Agent',
  'Agent「',            // 权限弹窗
  'Agent 请求',
  'Agent 不存在',
  'Agent 未绑定',
  '无 Agent',
  '新建一个 Agent',
  '创建一个 Agent',
];

const ALLOWED = [
  'Agent Dev Platform', // 品牌保留
  'OpenAI', 'Anthropic', 'Ollama', 'LM Studio', 'OpenCode', 'Codex',
  'WorkBuddy', 'MCP', 'API', 'Git', 'GitHub', 'Windows', 'Electron',
  'SQLite', 'Playwright', 'HTTP', 'CLI', 'URL',
];

test('前端用户可见层无 Agent/Agents 英文残留', () => {
  const files = ['public/index.html', 'public/js/chat.js', 'public/js/pages.js', 'public/js/app.js', 'public/js/panels.js', 'public/js/i18n.js'];
  for (const rel of files) {
    const src = read(rel);
    for (const bad of FORBIDDEN) {
      // 排除注释行（以 // 或 /* 开头的行）
      const lines = src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l));
      const hit = lines.find(l => l.includes(bad));
      assert.ok(!hit, `${rel} 出现禁止英文「${bad}」: ${hit ? hit.trim().slice(0, 120) : ''}`);
    }
  }
});

test('后端 emit 给 GUI 的错误消息无 Agent 残留', () => {
  const files = ['src/ipc/handlers.js', 'src/services/externalAgents.js', 'src/agent/runtime.js', 'src/agent/context.js'];
  for (const rel of files) {
    const src = read(rel);
    const lines = src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l));
    for (const bad of FORBIDDEN) {
      const hit = lines.find(l => l.includes(bad));
      assert.ok(!hit, `${rel} 出现禁止英文「${bad}」: ${hit ? hit.trim().slice(0, 120) : ''}`);
    }
  }
});

test('品牌名与允许的技术名保留', () => {
  const src = read('public/index.html');
  assert.ok(src.includes('Agent Dev Platform'));
  assert.ok(src.includes('OpenAI') || src.includes('MCP'));
});
