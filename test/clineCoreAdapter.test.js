'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { ClineAgentAdapter } = require('../src/agents/adapters/clineAgentAdapter');
const { AGENT_EVENT } = require('../src/agents/hub/types');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function storeWithConnection() {
  return {
    connections: {
      getDecrypted: id => id === 'conn' ? { protocol: 'anthropic', model: 'test-model', apiKey: 'sk-test-cline-secret' } : null
    }
  };
}

test('production Cline health is honest about sidecar, API, and workspace readiness', async () => {
  const sidecar = {
    detect: () => ({ available: true, installed: true, configured: true, version: '0.0.72', nodeVersion: '22.23.2', runtime: { manifest: { protocolVersion: 1 } } }),
    probe: async projectRoot => ({ ok: true, runtime: 'ClineCore', coreConstructible: true, networkCall: false, nodeVersion: '22.23.2', clineSdkVersion: '0.0.72', projectRoot }),
    dispose: async () => {}
  };
  const missing = new ClineAgentAdapter({ store: storeWithConnection(), sidecarManager: sidecar });
  const degraded = await missing.healthCheck({ projectRoot: PROJECT_ROOT });
  assert.strictEqual(degraded.status, 'degraded');
  assert.strictEqual(degraded.sidecar.ready, true);
  assert.strictEqual(degraded.api.configured, false);
  assert.strictEqual(degraded.workspace.ready, true);

  const configured = new ClineAgentAdapter({
    store: storeWithConnection(),
    config: { connectionId: 'conn', model: 'test-model' },
    sidecarManager: sidecar
  });
  const healthy = await configured.healthCheck({ projectRoot: PROJECT_ROOT });
  assert.strictEqual(healthy.status, 'healthy');
  assert.strictEqual(healthy.api.configured, true);
  assert.strictEqual(healthy.workspace.path, PROJECT_ROOT);
  await Promise.all([missing.dispose(), configured.dispose()]);
});

test('production Cline adapter delegates to ClineCore sidecar with exact scopes and provenance', async () => {
  let request = null;
  const sidecar = {
    detect: () => ({ available: true, installed: true, configured: true, version: '0.0.72', nodeVersion: '22.23.2', path: 'runtime', runtime: { manifest: { protocolVersion: 1 } } }),
    probe: async () => ({ ok: true, runtime: 'ClineCore', coreConstructible: true, networkCall: false, nodeVersion: '22.23.2', clineSdkVersion: '0.0.72' }),
    run: async options => {
      request = options;
      options.onStarted({ sessionId: 'session-real-shape', workspace: options.projectRoot });
      options.onEvent({ type: 'agent_event', payload: { sessionId: 'session-real-shape', event: { type: 'content_start', contentType: 'text', text: 'implemented' } } });
      options.onEvent({ type: 'agent_event', payload: { sessionId: 'session-real-shape', event: { type: 'usage', inputTokens: 10, outputTokens: 4, totalInputTokens: 10, totalOutputTokens: 4 } } });
      return {
        type: 'run.result',
        payload: {
          result: { finishReason: 'completed', text: 'implemented', iterations: 1, changedFiles: [path.join(PROJECT_ROOT, 'fixture.js')] },
          provenance: { runtime: 'ClineCore Sidecar', nodeVersion: '22.23.2', sdkVersion: '0.0.72', sessionId: 'session-real-shape' }
        }
      };
    },
    cancel: () => true,
    dispose: async () => {}
  };
  const adapter = new ClineAgentAdapter({ store: storeWithConnection(), sidecarManager: sidecar });
  const events = [];
  let finish = null;
  const { runId } = await adapter.startTask({
    goal: 'implement fixture',
    connectionId: 'conn',
    projectRoot: PROJECT_ROOT,
    allowedScopes: ['filesystem.read', 'filesystem.write', 'terminal.write']
  }, {
    emit: (type, data) => events.push({ type, data }),
    finishRun: (status, result) => { finish = { status, result }; }
  });
  for (let i = 0; !finish && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(runId);
  assert.strictEqual(finish.status, 'completed');
  assert.deepStrictEqual(request.payload.allowedScopes, ['filesystem.read', 'filesystem.write', 'terminal.write']);
  assert.strictEqual(request.payload.apiKey, undefined, 'credential payload must be cleared after terminal result');
  assert.ok(events.some(event => event.type === AGENT_EVENT.MESSAGE && event.data.text === 'implemented'));
  assert.ok(events.some(event => event.type === AGENT_EVENT.FILE_CHANGED && event.data.path.endsWith('fixture.js')));
  assert.strictEqual(finish.result.provenance.integration, 'ClineCore Sidecar');
  assert.strictEqual(finish.result.provenance.sdkVersion, '0.0.72');
  assert.strictEqual(finish.result.provenance.projectRootApplied, true);
  assert.deepStrictEqual(finish.result.changedFiles, [path.join(PROJECT_ROOT, 'fixture.js')]);
  assert.ok(!JSON.stringify(events).includes('sk-test-cline-secret'));
  await adapter.dispose();
});

test('production Cline adapter cancel propagates to sidecar and finishes once', async () => {
  let cancelCalls = 0;
  let resolveRun;
  const sidecar = {
    detect: () => ({ available: true, installed: true, configured: true, version: '0.0.72', nodeVersion: '22.23.2', runtime: { manifest: { protocolVersion: 1 } } }),
    run: options => new Promise(resolve => { resolveRun = () => resolve({ type: 'run.cancelled', payload: {} }); }),
    cancel: () => { cancelCalls += 1; resolveRun?.(); return true; },
    dispose: async () => {}
  };
  const adapter = new ClineAgentAdapter({ store: storeWithConnection(), sidecarManager: sidecar });
  let finishes = 0;
  const started = await adapter.startTask({ goal: 'wait', connectionId: 'conn', projectRoot: PROJECT_ROOT }, { finishRun: () => { finishes += 1; } });
  await new Promise(resolve => setImmediate(resolve));
  await adapter.cancel(started.runId);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(cancelCalls, 1);
  assert.strictEqual(finishes, 1);
  assert.strictEqual((await adapter.getStatus(started.runId)).status, 'cancelled');
  await adapter.dispose();
});
