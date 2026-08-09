'use strict';
const http = require('http');

/**
 * Fake OpenCode Server — 模拟 OpenCode serve 的 HTTP + SSE API。
 *
 * 端点：
 *   GET  /global/health            → { healthy, version }
 *   POST /session                  → Session { id, title, ... }
 *   POST /session/:id/prompt_async → 204（触发 SSE 事件）
 *   POST /session/:id/message      → { info, parts }（同步 prompt）
 *   GET  /session/:id/message      → Message[]
 *   POST /session/:id/abort        → boolean
 *   GET  /session/:id/diff         → FileDiff[]
 *   DELETE /session/:id            → boolean
 *   GET  /session/status           → { [sessionId]: status }
 *   GET  /event (SSE)              → server.connected + 事件流
 *
 * SSE 事件缓冲：prompt_async 可能在 SSE 客户端连接前到达。
 * pendingEvents 缓冲这些事件，在第一个 SSE 客户端连接时按序回放。
 */
function createFakeOpenCodeServer(opts = {}) {
  const port = opts.port || 0;
  const sessions = new Map();
  let pendingEvents = [];
  let sseClients = [];
  // v2.7.1 — Cancel 测试：hangNext=true 时下次 prompt_async 只发 running 不发 completed
  let hangNext = false;
  let abortCount = 0;
  // v2.7.2 — 失败场景注入
  let forcedCreateStatus = 200;   // createSession 强制返回的状态码
  let forcedRecoveryStatus = 200; // /session/status 强制返回的状态码
  let malformedBurst = 0;         // 下次 prompt_async 发送的畸形 SSE 行数（不发 completed）

  function broadcast(event) {
    const data = 'data: ' + JSON.stringify(event) + '\n\n';
    sseClients.forEach(c => {
      try { c.write(data); } catch { /* client gone */ }
    });
  }

  // 发送原始（可能畸形的）SSE 行，不做 JSON.stringify
  function broadcastRaw(line) {
    sseClients.forEach(c => {
      try { c.write(line); } catch { /* client gone */ }
    });
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // Health
    if (path === '/global/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ healthy: true, version: 'fake-1.0.0' }));
      return;
    }

    // SSE events
    if (path === '/event' || path === '/global/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ type: 'server.connected' }) + '\n\n');
      sseClients.push(res);
      // Flush buffered events (from prompt_async that arrived before SSE connect)
      if (pendingEvents.length > 0) {
        const buffered = pendingEvents.splice(0);
        buffered.forEach((e, i) => {
          setTimeout(() => broadcast(e), (i + 1) * 20);
        });
      }
      req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
      return;
    }

    // Create session
    if (path === '/session' && req.method === 'POST') {
      if (forcedCreateStatus !== 200) {
        res.writeHead(forcedCreateStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forced status ' + forcedCreateStatus }));
        return;
      }
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const id = 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        const session = { id, title: 'Test', createdAt: Date.now(), ...JSON.parse(body || '{}') };
        sessions.set(id, session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      });
      return;
    }

    // Prompt async
    if (path.match(/\/session\/[^/]+\/prompt_async/) && req.method === 'POST') {
      const sessionId = path.split('/')[2];
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        // 畸形 / 未知 schema SSE 突发（§25）：发送 N 个无法识别的事件类型
        // （合法 JSON，但 schema 未知）。streamSSE 会原样下发，适配器据
        // unrecognized 标记计数；连续达到阈值 -> PROTOCOL_ERROR。
        if (malformedBurst > 0) {
          const n = malformedBurst;
          malformedBurst = 0;
          for (let i = 0; i < n; i++) {
            setTimeout(() => broadcast({ type: '__unknown_schema_' + i, junk: true }), (i + 1) * 20);
          }
          return;
        }
        // Emit events to SSE clients
        const useHang = hangNext;
        hangNext = false; // 一次性
        const events = useHang
          ? [
              { type: 'session.updated', sessionId, status: 'running' },
              { type: 'message.updated', sessionId, role: 'assistant', content: 'Processing...' }
              // 故意不发 session.completed —— 模拟 hang，等 abort
            ]
          : [
              { type: 'session.updated', sessionId, status: 'running' },
              { type: 'message.updated', sessionId, role: 'assistant', content: 'Processing...' },
              { type: 'tool_call', sessionId, tool: 'read_file', status: 'started' },
              { type: 'tool_call.updated', sessionId, tool: 'read_file', status: 'completed', output: 'file contents' },
              { type: 'session.completed', sessionId, status: 'completed' }
            ];
        if (sseClients.length > 0) {
          // Client already connected — send with small delays
          events.forEach((e, i) => {
            setTimeout(() => broadcast(e), (i + 1) * 20);
          });
        } else {
          // Buffer for when client connects
          pendingEvents.push(...events);
        }
      });
      return;
    }

    // Abort
    if (path.match(/\/session\/[^/]+\/abort/) && req.method === 'POST') {
      abortCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('true');
      return;
    }

    // Diff
    if (path.match(/\/session\/[^/]+\/diff/)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { path: 'src/test.js', status: 'modified', additions: 5, deletions: 2, content: '+added line\n-removed line' }
      ]));
      return;
    }

    // Messages
    if (path.match(/\/session\/[^/]+\/message/) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ info: { id: 'msg-1', role: 'assistant' }, parts: [{ type: 'text', text: 'Done' }] }]));
      return;
    }

    // Sync message (POST)
    if (path.match(/\/session\/[^/]+\/message/) && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ info: { id: 'msg-sync', role: 'assistant' }, parts: [{ type: 'text', text: 'Sync reply' }] }));
      });
      return;
    }

    // Session status
    if (path === '/session/status') {
      if (forcedRecoveryStatus !== 200) {
        res.writeHead(forcedRecoveryStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forced recovery status ' + forcedRecoveryStatus }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const status = {};
      sessions.forEach((s, id) => { status[id] = 'completed'; });
      res.end(JSON.stringify(status));
      return;
    }

    // Delete session
    if (path.match(/\/session\/[^/]+/) && req.method === 'DELETE') {
      const id = path.split('/')[2];
      sessions.delete(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('true');
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return {
    server,
    async start() {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => {
          const actualPort = server.address().port;
          this.port = actualPort;
          this.baseUrl = `http://127.0.0.1:${actualPort}`;
          resolve({ port: actualPort });
        });
      });
    },
    async stop() {
      sseClients.forEach(c => { try { c.end(); } catch { /* gone */ } });
      sseClients = [];
      pendingEvents = [];
      return new Promise(resolve => server.close(resolve));
    },
    get sessions() { return sessions; },
    /** 设置下次 prompt_async 进入 hang 模式（不发 completed）。 */
    setHangNext() { hangNext = true; },
    /** 强制 createSession 返回指定状态码（§27：401/403/404/5xx 分类）。 */
    setForcedCreateStatus(code) { forcedCreateStatus = code; },
    /** 强制 /session/status 返回指定状态码（终态恢复失败测试）。 */
    setForcedRecoveryStatus(code) { forcedRecoveryStatus = code; },
    /** 下次 prompt_async 发送 count 个畸形 SSE 行（不发 completed，§25）。 */
    setMalformedBurst(count) { malformedBurst = count; },
    /** 返回 abort 被调用的次数。 */
    get abortCount() { return abortCount; },
    port: null,
    baseUrl: null
  };
}

module.exports = { createFakeOpenCodeServer };
