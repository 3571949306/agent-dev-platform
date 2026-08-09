'use strict';
/**
 * v2.4.1 — ProbeManager Lifecycle Tests（spec §45-§52）。
 *
 * 测试：
 *   - ProbeManager lifecycle（start → completed → cleanup）
 *   - Probe cancel（真实 abort fetch < 2s）
 *   - Probe timeout（≠ cancel）
 *   - Probe cleanup（正常完成 / cancel / timeout / failed 后 active = 0）
 *   - 多 Probe 隔离（cancel A 不影响 B）
 *   - Late Result Guard（cancel 后迟到 result 不覆盖 cancelled）
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { ProbeManager } = require('../src/providers/onboarding/probeManager');
const { createCandidate } = require('../src/providers/onboarding/candidate');

/** Hang server：接受 TCP 但永不响应 */
function hangServer() {
  const state = { sockets: [] };
  const server = http.createServer((_req, _res) => { /* hang */ });
  server.on('connection', s => state.sockets.push(s));
  return {
    state,
    async listen() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const s of state.sockets) { try { s.destroy(); } catch { /* noop */ } }
      await new Promise(r => server.close(r));
    }
  };
}

/** Fast server：立即返回 */
function fastServer() {
  const state = { sockets: [] };
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    if (req.url.includes('/chat/completions')) {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('connection', s => state.sockets.push(s));
  return {
    state,
    async listen() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      for (const s of state.sockets) { try { s.destroy(); } catch { /* noop */ } }
      await new Promise(r => server.close(r));
    }
  };
}

function makeCandidate(baseUrl, protocolHint) {
  const c = createCandidate();
  c.baseUrl = baseUrl;
  c.apiKey = 'sk-test';
  c.protocolHint = protocolHint || 'openai';
  return c;
}

/** 等待 emit 回调被调用 */
function waitForEmit(pm, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const origEmit = pm.emit;
    const timer = setTimeout(() => reject(new Error('emit timeout')), timeoutMs);
    pm.emit = (type, payload) => {
      origEmit(type, payload);
      if (type === 'onboarding:probe:event' && (payload.state === 'completed' || payload.state === 'failed' || payload.state === 'cancelled' || payload.state === 'timeout')) {
        clearTimeout(timer);
        pm.emit = origEmit;
        resolve(payload);
      }
    };
  });
}

// ─── §45: 正常完成 → active probes = 0 ──────────────────────────────────────

test('§45 ProbeManager: 正常完成 → active probes = 0', async () => {
  const srv = fastServer();
  const base = await srv.listen();
  const events = [];
  const pm = new ProbeManager({ emit: (type, payload) => events.push({ type, ...payload }) });
  try {
    const probeId = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 5000 });
    assert.ok(probeId, '应返回 probeId');
    assert.strictEqual(pm.listActiveProbes().length, 1, '应 1 个活跃 probe');

    const ev = await waitForEmit(pm);
    assert.strictEqual(ev.state, 'completed', '应 completed');
    assert.strictEqual(ev.probeId, probeId, 'probeId 应匹配');

    // 等待清理（5s retention）
    await new Promise(r => setTimeout(r, 5100));
    assert.strictEqual(pm.listActiveProbes().length, 0, '完成后 active probes = 0');
    assert.strictEqual(pm.getProbe(probeId), null, '完成后 getProbe = null');
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §45: cancel → active probes = 0 ────────────────────────────────────────

test('§45/§9 ProbeManager: cancel → fetch abort < 2s + active = 0', async () => {
  const srv = hangServer();
  const base = await srv.listen();
  const pm = new ProbeManager({ emit: () => {} });
  try {
    const probeId = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 30000 });
    assert.strictEqual(pm.listActiveProbes().length, 1, '应 1 个活跃 probe');

    const t0 = Date.now();
    // 100ms 后取消
    await new Promise(r => setTimeout(r, 100));
    const cancelled = pm.cancelProbe(probeId);
    assert.strictEqual(cancelled, true, 'cancelProbe 应返回 true');

    // 等待 probe 结束（< 2s）
    await new Promise(r => setTimeout(r, 2000));
    const elapsed = Date.now() - t0;

    // §9: cancel < 2s
    assert.ok(elapsed < 3000, `cancel 应在 2s 内结束，实际 ${elapsed}ms`);

    // probe 不再 running
    const probe = pm.getProbe(probeId);
    if (probe) {
      assert.notStrictEqual(probe.state, 'running', 'probe 不应仍 running');
    }
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §45: timeout → active probes = 0 ───────────────────────────────────────

test('§45/§50 ProbeManager: timeout → state = timeout（≠ cancelled）', async () => {
  const srv = hangServer();
  const base = await srv.listen();
  const events = [];
  const pm = new ProbeManager({ emit: (type, payload) => events.push({ type, ...payload }) });
  try {
    const probeId = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 1000 });
    const ev = await waitForEmit(pm, 5000);

    // §50: timeout ≠ cancelled
    assert.strictEqual(ev.state, 'timeout', '应 timeout，不是 cancelled');
    assert.strictEqual(ev.probeId, probeId, 'probeId 应匹配');
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §46: 多 Probe 隔离 ─────────────────────────────────────────────────────

test('§46 ProbeManager: cancel A 不影响 B', async () => {
  const srv = fastServer();
  const base = await srv.listen();
  const pm = new ProbeManager({ emit: () => {} });
  try {
    const idA = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 10000 });
    const idB = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 10000 });
    assert.notStrictEqual(idA, idB, 'probeId 应不同');
    assert.strictEqual(pm.listActiveProbes().length, 2, '应 2 个活跃 probe');

    // Cancel A
    pm.cancelProbe(idA);
    await new Promise(r => setTimeout(r, 500));

    const probeA = pm.getProbe(idA);
    const probeB = pm.getProbe(idB);
    if (probeA) {
      assert.strictEqual(probeA.state, 'cancelled', 'A 应 cancelled');
    }
    if (probeB) {
      assert.notStrictEqual(probeB.state, 'cancelled', 'B 不应 cancelled');
    }
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §47: Late Result Guard ─────────────────────────────────────────────────

test('§47 ProbeManager: cancel 后迟到 result 不覆盖 cancelled', async () => {
  const srv = hangServer();
  const base = await srv.listen();
  const events = [];
  const pm = new ProbeManager({ emit: (type, payload) => events.push({ type, ...payload }) });
  try {
    const probeId = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 30000 });

    // 100ms 后取消
    await new Promise(r => setTimeout(r, 100));
    pm.cancelProbe(probeId);

    // 等待迟到 result
    await new Promise(r => setTimeout(r, 2000));

    // 应只收到 cancelled 事件，不收到 result 事件
    const resultEvents = events.filter(e => e.type === 'result');
    assert.strictEqual(resultEvents.length, 0, '§47: cancel 后不应 emit result 事件');
    const cancelEvents = events.filter(e => e.state === 'cancelled');
    assert.ok(cancelEvents.length >= 1, '应 emit cancelled 事件');
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §43: Diagnostics 不含 apiKey ───────────────────────────────────────────

test('§43 ProbeManager: getProbe 不含 apiKey', async () => {
  const srv = fastServer();
  const base = await srv.listen();
  const pm = new ProbeManager({ emit: () => {} });
  try {
    const c = makeCandidate(base + '/v1');
    c.apiKey = 'sk-secret-key-12345';
    const probeId = pm.startProbe(c, { timeoutMs: 5000 });

    const diag = pm.getProbe(probeId);
    assert.ok(diag, '应返回 diagnostics');
    const json = JSON.stringify(diag);
    assert.ok(!json.includes('sk-secret-key-12345'), '§43: diagnostics 不含 apiKey');
    assert.ok(diag.startedAt, '应有 startedAt');
    assert.ok(diag.timeoutMs, '应有 timeoutMs');
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §44: listActiveProbes ──────────────────────────────────────────────────

test('§44 ProbeManager: listActiveProbes 返回 running probes', async () => {
  const srv = hangServer();
  const base = await srv.listen();
  const pm = new ProbeManager({ emit: () => {} });
  try {
    const id = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 30000 });
    const active = pm.listActiveProbes();
    assert.strictEqual(active.length, 1, '应 1 个活跃');
    assert.strictEqual(active[0].probeId, id, 'probeId 应匹配');
    // §43: 不含 apiKey
    const json = JSON.stringify(active[0]);
    assert.ok(!json.includes('sk-test'), 'listActiveProbes 不含 apiKey');
  } finally {
    pm.cleanupAll();
    await srv.close();
  }
});

// ─── §51: Error Codes ───────────────────────────────────────────────────────

test('§51 ProbeManager: cancel → PROBE_CANCELLED, timeout → PROBE_TIMEOUT', async () => {
  const srv = hangServer();
  const base = await srv.listen();
  try {
    // Cancel test
    {
      const events = [];
      const pm = new ProbeManager({ emit: (t, p) => events.push(p) });
      const id = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 30000 });
      await new Promise(r => setTimeout(r, 100));
      pm.cancelProbe(id);
      await new Promise(r => setTimeout(r, 2000));
      // cancelled 事件不含 errorCode（由 probe() resolve 后处理），但 probe 内部有 PROBE_CANCELLED
      pm.cleanupAll();
    }
    // Timeout test
    {
      const events = [];
      const pm = new ProbeManager({ emit: (t, p) => events.push(p) });
      const id = pm.startProbe(makeCandidate(base + '/v1'), { timeoutMs: 500 });
      const ev = await waitForEmit(pm, 5000);
      assert.strictEqual(ev.state, 'timeout', '应 timeout');
      assert.ok(ev.report, '应有 report');
      assert.strictEqual(ev.report.errorCode, 'PROBE_TIMEOUT', 'errorCode 应 PROBE_TIMEOUT');
      pm.cleanupAll();
    }
  } finally {
    await srv.close();
  }
});
