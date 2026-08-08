'use strict';
/**
 * v2.3.0 — Codex 配置修复契约测试。
 *
 * v2.2.0 之前用 `fs.existsSync("codex")` 判断 CLI 是否存在，那是检查「当前工作目录」
 * 下有没有叫 codex 的文件，几乎永远为 false，导致即便已安装也报「未找到 Codex」。
 * v2.3.0 改为走 PATH（`where` / `which`）解析，并区分三种调用方式：
 *   - cliMode='auto'  自动检测 PATH 中的 codex
 *   - cliMode='path'  使用 config.cliPath（绝对路径或裸命令，裸命令也走 PATH 解析）
 *   - cliMode='api'   通过 API 连接调用，不需要 CLI
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

const ext = require('../src/services/externalAgents');

test('resolveCodexCwd 优先级：cfg.cwd > projectRoot > process.cwd', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-'));
  const sub = path.join(tmp, 'nested');
  fs.mkdirSync(sub);
  // 1) cfg.cwd 优先
  assert.strictEqual(ext.resolveCodexCwd({ cwd: sub }, { projectRoot: tmp }), sub);
  // 2) 无 cfg.cwd 时取 projectRoot
  assert.strictEqual(ext.resolveCodexCwd({}, { projectRoot: tmp }), tmp);
  // 3) 都没有时回退 process.cwd()
  assert.strictEqual(ext.resolveCodexCwd({}, {}), process.cwd());
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cliMode=auto 且 PATH 无 codex 时，runCodex 优雅失败（不再误报未找到）', async () => {
  // 测试环境中 PATH 通常没有 codex（且我们不会伪造），应返回 failed 结构化结果。
  const raw = await ext.runCodex({ config: { cliMode: 'auto' } }, 'do something', null, {});
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.status, 'failed');
  assert.ok(Array.isArray(parsed.errors) && parsed.errors.length > 0);
});

test('cliMode=api 但缺少 API 连接时，给出可操作的失败信息', async () => {
  const raw = await ext.runCodex({ config: { cliMode: 'api' } }, 'task', null, {});
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.status, 'failed');
  assert.ok((parsed.errors[0] || '').includes('API 连接'), '应提示未配置 API 连接');
});

test('cliMode=path 指向不存在的文件时，不尝试 spawn，安全失败', async () => {
  const raw = await ext.runCodex(
    { config: { cliMode: 'path', cliPath: 'C:\\no\\such\\codex.exe' } },
    'task', null, {}
  );
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.status, 'failed');
});

test('cliMode=path 指向真实可执行文件时，会真正进入 spawn 阶段（使用 actualPath）', async () => {
  // 验证 #46 的核心修复：旧代码 spawn(cfg.cliPath, ...) 在 cliPath 为裸命令或需 PATH
  // 解析时易出错；新代码先解析出 actualPath 再 spawn。这里用一个真实存在的文件作为
  // cliPath，断言 runCodex 到达「尝试启动 CLI」阶段，而不是在配置检查就失败。
  let launcher;
  if (process.platform === 'win32') {
    launcher = path.join(os.tmpdir(), 'codex-stub-' + Date.now() + '.cmd');
    fs.writeFileSync(launcher, '@exit /b 0\r\n');
  } else {
    launcher = path.join(os.tmpdir(), 'codex-stub-' + Date.now() + '.sh');
    fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(launcher, 0o755);
  }
  try {
    const raw = await ext.runCodex(
      { config: { cliMode: 'path', cliPath: launcher } },
      'task', null, { signal: null }
    );
    const parsed = JSON.parse(raw);
    // 到达 spawn 阶段（使用解析后的 actualPath），而不是在配置检查就返回「未配置 CLI 路径」
    assert.ok(['failed', 'completed', 'timeout'].includes(parsed.status), '应为 failed/completed/timeout，实际: ' + parsed.status);
    assert.ok(!(parsed.errors[0] || '').includes('未配置 CLI 路径'), '不应在配置阶段就失败，说明 actualPath 已传给 spawn');
  } finally {
    fs.rmSync(launcher, { force: true });
  }
});
