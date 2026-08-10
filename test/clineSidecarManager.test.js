'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const path = require('node:path');
const { ClineSidecarManager } = require('../src/agents/integrations/cline/sidecarManager');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function protocol(type, fields = {}) { return { protocol: 1, type, ...fields }; }

function createFakeChild(mode = 'result') {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let buffer = '';
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === 'runtime.probe') {
          send(protocol('runtime.probe', { requestId: message.requestId, payload: { ok: true, runtime: 'ClineCore', coreConstructible: true, networkCall: false } }));
        } else if (message.type === 'run.start') {
          send(protocol('run.started', { requestId: message.requestId, runId: message.runId, payload: { sessionId: 's1', workspace: message.payload.projectRoot } }));
          if (mode === 'result') {
            send(protocol('run.event', { runId: message.runId, payload: { event: { type: 'agent_event', payload: { sessionId: 's1', event: { type: 'content_start', contentType: 'text', text: 'done' } } } } }));
            send(protocol('run.result', { requestId: message.requestId, runId: message.runId, payload: { result: { text: 'done', finishReason: 'completed' } } }));
          } else if (mode === 'crash') {
            queueMicrotask(() => child.emit('exit', 23, null));
          }
        } else if (message.type === 'run.cancel') {
          send(protocol('run.cancelled', { runId: message.runId, payload: { error: { code: 'CLINE_RUN_CANCELLED', message: 'cancelled' } } }));
        } else if (message.type === 'runtime.shutdown' && mode !== 'ignore-shutdown') {
          send(protocol('runtime.goodbye', { requestId: message.requestId, payload: { ok: true } }));
          queueMicrotask(() => child.emit('exit', 0, null));
        }
      }
      done();
    }
  });
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => send(protocol('hello.ok', { payload: { runtime: 'ClineCore', nodeVersion: mode === 'bad-handshake' ? '18.20.0' : '22.23.2', clineSdkVersion: '0.0.72' } })));
  return child;
}

function managerFor(mode, calls = [], overrides = {}) {
  return new ClineSidecarManager({
    locator: () => ({
      available: true,
      root: PROJECT_ROOT,
      nodePath: 'node.exe',
      sidecarPath: 'sidecar.mjs',
      manifest: { protocolVersion: 1, node: { version: '22.23.2' }, cline: { sdkVersion: '0.0.72' } }
    }),
    env: { PATH: 'safe', OPENAI_API_KEY: 'sk-test-never-forward' },
    dataDir: path.join(PROJECT_ROOT, '.cache', 'test-cline'),
    handshakeTimeoutMs: 250,
    shutdownTimeoutMs: 250,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return createFakeChild(mode);
    },
    ...overrides
  });
}

test('Cline sidecar manager handshakes, probes, and uses spawn without a shell', async () => {
  const calls = [];
  const manager = managerFor('result', calls);
  const result = await manager.probe(PROJECT_ROOT);
  assert.strictEqual(result.runtime, 'ClineCore');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.shell, false);
  assert.strictEqual(calls[0].options.cwd, PROJECT_ROOT);
  assert.strictEqual(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.strictEqual((await manager.shutdown()).ok, true);
  assert.strictEqual(manager.child, null);
});

test('Cline sidecar manager streams events and accepts exactly one terminal result', async () => {
  const manager = managerFor('result');
  const events = [];
  const terminal = await manager.run({ runId: 'run-1', projectRoot: PROJECT_ROOT, payload: { prompt: 'test' }, onEvent: event => events.push(event) });
  assert.strictEqual(terminal.type, 'run.result');
  assert.strictEqual(events[0].payload.event.text, 'done');
  assert.strictEqual(manager.activeRuns.size, 0);
  await manager.shutdown();
});

test('Cline sidecar manager cancellation wins and late terminal messages are ignored', async () => {
  const manager = managerFor('hang');
  const pending = manager.run({ runId: 'run-cancel', projectRoot: PROJECT_ROOT, payload: { prompt: 'wait' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(manager.cancel('run-cancel'), true);
  const terminal = await pending;
  assert.strictEqual(terminal.type, 'run.cancelled');
  manager._handleMessage(protocol('run.result', { runId: 'run-cancel', payload: { result: { text: 'late' } } }));
  assert.strictEqual(manager.activeRuns.size, 0);
  await manager.shutdown();
});

test('Cline sidecar manager enforces timeout and ignores late results', async () => {
  const manager = managerFor('hang');
  const terminal = await manager.run({ runId: 'run-timeout', projectRoot: PROJECT_ROOT, timeoutMs: 20, payload: { prompt: 'wait' } });
  assert.strictEqual(terminal.type, 'run.timeout');
  manager._handleMessage(protocol('run.result', { runId: 'run-timeout', payload: { result: { text: 'late' } } }));
  assert.strictEqual(manager.activeRuns.size, 0);
  await manager.shutdown();
});

test('Cline sidecar manager turns a process crash into a terminal error and can restart', async () => {
  let starts = 0;
  const manager = managerFor('crash');
  const originalSpawn = manager.spawn;
  manager.spawn = (...args) => {
    starts += 1;
    return starts === 1 ? originalSpawn(...args) : createFakeChild('result');
  };
  await assert.rejects(
    manager.run({ runId: 'run-crash', projectRoot: PROJECT_ROOT, payload: { prompt: 'crash' } }),
    error => error.code === 'CLINE_SIDECAR_CRASHED'
  );
  const result = await manager.probe(PROJECT_ROOT);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(starts, 2);
  await manager.shutdown();
});

test('Cline sidecar manager rejects incompatible handshakes and synchronous spawn failures', async () => {
  const incompatible = managerFor('bad-handshake');
  await assert.rejects(
    incompatible.start(PROJECT_ROOT),
    error => error.code === 'CLINE_SIDECAR_HANDSHAKE_FAILED'
  );
  const failedSpawn = managerFor('result', [], { spawn: () => { throw new Error('fixture spawn failed'); } });
  await assert.rejects(
    failedSpawn.start(PROJECT_ROOT),
    error => error.code === 'CLINE_SIDECAR_START_FAILED'
  );
});

test('Cline sidecar manager treats an unexpected runId as fatal and ignores duplicate terminals', async () => {
  const manager = managerFor('hang');
  const pending = manager.run({ runId: 'expected-run', projectRoot: PROJECT_ROOT, payload: { prompt: 'wait' } });
  await new Promise(resolve => setImmediate(resolve));
  manager._handleMessage(protocol('run.result', { runId: 'spoofed-run', payload: { result: { text: 'spoofed' } } }));
  await assert.rejects(pending, error => error.code === 'CLINE_PROTOCOL_ERROR');
  manager._handleMessage(protocol('run.result', { runId: 'expected-run', payload: { result: { text: 'duplicate' } } }));
  assert.strictEqual(manager.activeRuns.size, 0);
});

test('Cline sidecar manager caps and redacts stderr diagnostics', async () => {
  const manager = managerFor('result');
  await manager.probe(PROJECT_ROOT);
  manager.child.stderr.write(`${'x'.repeat(80 * 1024)} sk-test-sidecar-secret`);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(Buffer.byteLength(manager.stderrTail, 'utf8') <= 64 * 1024);
  assert.ok(!manager.stderrTail.includes('sk-test-sidecar-secret'));
  await manager.shutdown();
});

test('Cline sidecar manager uses kill-tree fallback and rejects runs after dispose', async () => {
  let killCalls = 0;
  const manager = managerFor('ignore-shutdown', [], {
    shutdownTimeoutMs: 20,
    killTree: child => { killCalls += 1; return child.kill(); }
  });
  await manager.start(PROJECT_ROOT);
  const stopped = await manager.shutdown();
  assert.strictEqual(stopped.killed, true);
  assert.strictEqual(killCalls, 1);
  await manager.dispose();
  await assert.rejects(
    manager.run({ runId: 'after-dispose', projectRoot: PROJECT_ROOT, payload: { prompt: 'no' } }),
    error => error.code === 'CLINE_SIDECAR_STOPPED'
  );
});
