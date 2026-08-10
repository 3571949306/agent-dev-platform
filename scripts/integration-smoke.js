'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ClineSidecarManager } = require('../src/agents/integrations/cline/sidecarManager');

function sseChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'cmpl-local-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`;
}

function toolResponse(name, args, id) {
  return sseChunk({
    role: 'assistant',
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  }) + sseChunk({}, 'tool_calls') + 'data: [DONE]\n\n';
}

function textResponse(text) {
  return sseChunk({ role: 'assistant', content: text }) + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
}

async function createLocalModelServer(workspace, nodePath) {
  let turn = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      JSON.parse(body || '{}');
      turn += 1;
      let payload;
      if (turn === 1) {
        payload = toolResponse('editor', {
          path: path.join(workspace, 'src', 'math.js'),
          old_text: "function add(a, b) {\n  return a - b;\n}",
          new_text: "function add(a, b) {\n  return a + b;\n}"
        }, 'call-editor');
      } else if (turn === 2) {
        const testPath = path.join(workspace, 'test', 'math.test.js');
        payload = toolResponse('run_commands', {
          commands: [`"${nodePath}" --test "${testPath}"`]
        }, 'call-test');
      } else {
        payload = textResponse('Implemented the addition fix and verified the fixture test passes.');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end(payload);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    turns: () => turn,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function runCodingFixture(manager, root) {
  const fixture = path.join(root, 'test', 'fixtures', 'cline-coding');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-cline-coding-'));
  fs.cpSync(fixture, workspace, { recursive: true });
  const nodePath = path.join(root, 'build-runtime', 'cline-runtime', 'node', 'node.exe');
  const localModel = await createLocalModelServer(workspace, nodePath);
  const events = [];
  try {
    const terminal = await manager.run({
      runId: `coding-fixture-${Date.now()}`,
      projectRoot: workspace,
      timeoutMs: 60000,
      payload: {
        prompt: 'Fix src/math.js so the addition test passes, run the test, then report completion.',
        providerId: 'openai-compatible',
        modelId: 'fixture-model',
        apiKey: 'sk-test-cline-integration',
        baseUrl: localModel.baseUrl,
        maxIterations: 6,
        allowedScopes: ['filesystem.read', 'filesystem.write', 'terminal.read', 'terminal.write']
      },
      onEvent: event => events.push(event)
    });
    if (terminal.type !== 'run.result') throw new Error(`Real ClineCore coding fixture ended as ${terminal.type}`);
    const changed = fs.readFileSync(path.join(workspace, 'src', 'math.js'), 'utf8');
    if (!changed.includes('return a + b;')) throw new Error('Real ClineCore did not apply the fixture edit');
    const verified = spawnSync(nodePath, ['--test', path.join(workspace, 'test', 'math.test.js')], { cwd: workspace, encoding: 'utf8', shell: false, windowsHide: true });
    if (verified.status !== 0) throw new Error(`Edited fixture test failed: ${verified.stderr || verified.stdout}`);
    const serializedEvents = JSON.stringify(events);
    if (!serializedEvents.includes('editor') || !serializedEvents.includes('run_commands')) throw new Error('Real ClineCore fixture did not emit expected tool events');
    if (serializedEvents.includes('sk-test-cline-integration')) throw new Error('Credential leaked into ClineCore events');
    process.stdout.write(`CLINE_CODING_FIXTURE_OK turns=${localModel.turns()} changed=src/math.js test=passed\n`);
  } finally {
    await localModel.close();
    // Windows cannot remove a directory while the sidecar process has it as cwd.
    await manager.shutdown();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const root = path.resolve(__dirname, '..');
  // The runtime download cache is intentionally restored by CI, but Cline's
  // mutable session/database state must never be restored across workflow
  // runs. A per-process data directory keeps the real ClineCore smoke test
  // deterministic and also exercises clean first-run initialization.
  const runtimeDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adp-cline-runtime-data-'));
  const manager = new ClineSidecarManager({
    runtimeRoot: path.join(root, 'build-runtime', 'cline-runtime'),
    dataDir: runtimeDataDir
  });
  try {
    const probe = await manager.probe(root);
    if (!probe.ok || probe.runtime !== 'ClineCore' || probe.networkCall !== false || !probe.coreConstructible) {
      throw new Error(`Unexpected Cline runtime probe: ${JSON.stringify(probe)}`);
    }
    process.stdout.write(`CLINE_INTEGRATION_SMOKE_OK node=${probe.nodeVersion} sdk=${probe.clineSdkVersion} networkCall=false\n`);
    await runCodingFixture(manager, root);
  } finally {
    const outcome = await manager.shutdown();
    try {
      if (!outcome.ok) throw new Error(`Cline runtime did not shut down cleanly: ${outcome.error || 'unknown error'}`);
    } finally {
      fs.rmSync(runtimeDataDir, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  // SidecarManager stores only a bounded, secret-redacted stderr tail. Include
  // it on failure so a clean CI runner can diagnose platform-only crashes
  // without exposing credentials or turning normal runs into verbose logs.
  const stderrTail = typeof error?.detail?.stderr === 'string'
    ? error.detail.stderr.trim().slice(-8192)
    : '';
  process.stderr.write(`CLINE_INTEGRATION_SMOKE_FAILED ${error.message}${stderrTail ? `\nCLINE_SIDECAR_STDERR ${stderrTail}` : ''}\n`);
  process.exitCode = 1;
});
