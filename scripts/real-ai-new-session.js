'use strict';
/**
 * v2.9.0 Harness Safety Patch（§13/§16/§17）— 显式创建新的 Real AI Closure Session。
 *
 * 用途：同一 Closure Session（repoRoot + HEAD + TTL）已达 maxPaidRuns=2 后，
 * 操作者（人）如确需继续真实测试，显式执行本命令创建新 Session。
 * 这是人工 override 通道之一（另一通道：外部环境传入 REAL_AI_ALLOW_NEW_SESSION=1；
 * 脚本/测试/WorkBuddy 不得自行设置，§18）。
 *
 * 每次执行都会留下日志：NEW_PAID_TEST_SESSION_CREATED reason=explicit_new_session_command。
 *
 * 运行：node scripts/real-ai-new-session.js
 */

const path = require('path');
const { createRealAiPaidRunGuard } = require('./lib/real-ai-paid-run-guard');

function main() {
  const repoRoot = path.join(__dirname, '..');
  const guard = createRealAiPaidRunGuard({ repoRoot });
  const before = guard.inspect();
  const acq = guard.forceNewSession('explicit_new_session_command');
  if (!acq.ok) {
    console.log(`REAL_AI_NEW_SESSION_FAILED code=${acq.code} detail=${acq.detail || ''}`);
    process.exit(1);
  }
  const s = acq.session;
  console.log('REAL_AI_NEW_SESSION_OK');
  console.log(`REAL_AI_TEST_SESSION_ID=${s.sessionId}`);
  console.log(`maxPaidRuns=${s.maxPaidRuns} paidRunsStarted=${s.paidRunsStarted}`);
  if (before.hasSession) {
    console.log(`previous session: ${before.sessionId} (${before.paidRunsStarted}/${before.maxPaidRuns}) — 已按 override 替换`);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { main };
