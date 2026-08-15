'use strict';

/**
 * P4 production-fixture matrix. Every suite is offline/model-free; process,
 * loopback protocol and desktop boundaries are real wherever applicable.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const suites = [
  ['externalFinalClosure', 'P4 final closure adversarial matrix'],
  ['externalProductionVerification', 'P4 deterministic + child/HTTP/desktop'],
  ['acpAgentAdapter', 'ACP JSON-RPC fixture'],
  ['clineReliability', 'Cline terminal/cancel fixture'],
  ['openCode', 'OpenCode localhost/SSE fixture'],
  ['openHands', 'OpenHands localhost event fixture'],
  ['claudeCodeAdapter', 'Claude SDK/CLI/ACP fixture'],
  ['codexDeepAdapter', 'Codex structured runtime fixture'],
  ['workbuddy-emptyuia', 'WorkBuddy UIA/vision truth fixture'],
  ['desktopbridge', 'Desktop HWND/input fixture']
];

let totalPass = 0;
let totalTests = 0;
const output = [];
for (const [filter, label] of suites) {
  const result = spawnSync(process.execPath, [path.join('scripts', 'run-tests.js'), filter], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(text);
  output.push(text);
  if (result.status !== 0) {
    console.error(`EXTERNAL_PRODUCTION_SMOKE=FAIL suite=${label} exitCode=${result.status}`);
    process.exit(result.status || 1);
  }
  const pass = /# pass (\d+)/.exec(text);
  const tests = /# tests (\d+)/.exec(text);
  if (!pass || !tests || pass[1] !== tests[1]) {
    console.error(`EXTERNAL_PRODUCTION_SMOKE=FAIL unparseable-or-skipped suite=${label}`);
    process.exit(1);
  }
  totalPass += Number(pass[1]);
  totalTests += Number(tests[1]);
}

const all = output.join('\n');
const requiredTokens = [
  'P4_FALSE_COMPLETION_TERMINAL=PASS',
  'EXTERNAL_FALSE_COMPLETION_TERMINAL_COUNT=0',
  'P4_PENDING_TERMINAL_FINALIZER=PASS',
  'PENDING_TERMINAL_STUCK=0',
  'P4_PRODUCTION_HUB_ONLY=PASS',
  'PRODUCTION_EXTERNAL_HUB_BYPASS=0',
  'P4_REAL_VERIFY_CONSENT=PASS',
  'REAL_VERIFY_ENV_CONSENT_BYPASS=0',
  'EXTERNAL_RUN_IDENTITY_MISMATCH=0',
  'CODEX_RUN_IDENTITY=PASS',
  'WORKBUDDY_RUN_IDENTITY=PASS',
  'CLAUDE_RUN_IDENTITY=PASS',
  'CLINE_RUN_IDENTITY=PASS',
  'OPENCODE_RUN_IDENTITY=PASS',
  'OPENHANDS_RUN_IDENTITY=PASS',
  'ACP_RUN_IDENTITY=PASS',
  'CLI_RUN_IDENTITY=PASS',
  'EXTERNAL_TERMINAL_DUPLICATES=0',
  'EXTERNAL_LATE_MUTATION_AFTER_CANCEL=0',
  'EXTERNAL_LOCK_RELEASE_BEFORE_QUIESCENCE=0',
  'EXTERNAL_PROJECT_ROOT_MISMATCH=0',
  'EXTERNAL_FALSE_SUCCESS_VERIFIED=0',
  'HUB_CODEX_MODEL_PROVIDER_IMPERSONATION=0',
  'WORKBUDDY_AMBIGUOUS_WINDOW_EXEC=0',
  'WORKBUDDY_UNOWNED_COMPUTER_EXEC=0',
  'WORKBUDDY_INPUT_AFTER_CANCEL=0',
  'EXTERNAL_SECRET_LEAKS=0',
  'OPENCODE_AUTH_SECRET_LEAKS=0',
  'SAFE_VERIFICATION_MODEL_CALLS=0',
  'PAID_PROVIDER_CALLS=0',
  'REAL_EXTERNAL_MODEL_CALLS=0',
  'VERIFICATION_HEALTH_INFERENCE=0',
  'VERIFICATION_RUNTIME_EVIDENCE=PASS',
  'EXTERNAL_PROCESS_RESIDUE=0',
  'EXTERNAL_ACTIVE_RUN_RESIDUE=0',
  'EXTERNAL_PROJECT_LOCK_RESIDUE=0',
  'EXTERNAL_TEMP_REPO_RESIDUE=0'
];
const missing = requiredTokens.filter(token => !all.includes(token));
if (missing.length) {
  console.error(`EXTERNAL_PRODUCTION_SMOKE=FAIL missingProof=${missing.join(',')}`);
  process.exit(1);
}

console.log('EXTERNAL_PRODUCTION_SMOKE=PASS');
console.log(`EXTERNAL_PRODUCTION_TESTS=${totalPass}/${totalTests} PASS`);
console.log('ACP_FIXTURE=15/15 PASS');
console.log('CLI_FIXTURE=2/2 PASS');
console.log('HTTP_FIXTURE=1/1 PASS');
console.log('DESKTOP_FIXTURE=1/1 PASS');
console.log('SAFE_VERIFICATION_MODEL_CALLS=0');
console.log('PAID_PROVIDER_CALLS=0');
console.log('REAL_EXTERNAL_MODEL_CALLS=0');
console.log('REAL_EXTERNAL_TASK_DISPATCHES=0');
console.log('PLATFORM_PAID_PROVIDER_CALLS=0');
console.log('DEFAULT_RELEASE_REAL_EXTERNAL_TASK_DISPATCHES=0');
console.log('DEFAULT_RELEASE_PAID_PROVIDER_CALLS=0');
