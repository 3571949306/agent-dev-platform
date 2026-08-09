'use strict';
const http = require('http');

/**
 * Fake OpenHands Agent Server — 模拟 OpenHands REST API。
 *
 * 端点：
 *   GET    /health                       → { status, version }
 *   POST   /conversations                → { conversation_id, ... }
 *   GET    /conversations/search         → Conversation[]
 *   GET    /conversations/:id            → Conversation
 *   GET    /conversations/:id/events     → Event[]
 *   POST   /conversations/:id/events     → { ok: true }（发消息，触发事件累积）
 *   DELETE /conversations/:id            → boolean
 *
 * 事件累积：POST /events 将模拟事件追加到 conversation.events，
 * 后续 GET /events 返回完整列表。OpenHands 客户端的 pollingStream
 * 会先 POST 消息再轮询 GET，因此事件在首次轮询时即可读到。
 *
 * 事件格式与 mapOpenHandsEvent 对齐：
 *   { type: 'message', content }                  → agent.message
 *   { type: 'action', action: 'edit', path }      → agent.file.changed
 *   { type: 'action', action: 'run', command }    → agent.command.started
 *   { type: 'observation', observation: 'run' }   → agent.command.completed
 *   { type: 'observation', observation: 'agent_state_changed', agent_state: 'finished' }
 *                                                  → agent.run.completed (terminal)
 */
function createFakeOpenHandsServer(opts = {}) {
  const port = opts.port || 0;
  const conversations = new Map();

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname;

    // Health
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: 'fake-1.41.0' }));
      return;
    }

    // Create conversation
    if (path === '/conversations' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const id = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        const conv = { conversation_id: id, ...JSON.parse(body || '{}') };
        conversations.set(id, { ...conv, events: [], status: 'running' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(conv));
      });
      return;
    }

    // Search conversations
    if (path === '/conversations/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.from(conversations.values())));
      return;
    }

    // Get conversation events
    if (path.match(/\/conversations\/[^/]+\/events/) && req.method === 'GET') {
      const id = path.split('/')[2];
      const conv = conversations.get(id);
      if (!conv) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(conv.events));
      return;
    }

    // Send message to conversation (triggers event accumulation)
    if (path.match(/\/conversations\/[^/]+\/events/) && req.method === 'POST') {
      const id = path.split('/')[2];
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        const conv = conversations.get(id);
        if (!conv) { res.writeHead(404); res.end('Not found'); return; }

        // Simulate agent processing — events aligned with mapOpenHandsEvent
        const events = [
          { type: 'message', content: 'Processing task...' },
          { type: 'action', action: 'edit', path: 'src/test.js' },
          { type: 'action', action: 'run', command: 'npm test' },
          { type: 'observation', observation: 'run', exit_code: 0, output: 'all tests passed' },
          { type: 'agent_state_changed', agent_state: 'finished' }
        ];
        conv.events.push(...events);
        conv.status = 'completed';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // Delete conversation
    if (path.match(/\/conversations\/[^/]+/) && req.method === 'DELETE') {
      const id = path.split('/')[2];
      conversations.delete(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('true');
      return;
    }

    // Get conversation
    if (path.match(/\/conversations\/[^/]+/) && req.method === 'GET') {
      const id = path.split('/')[2];
      const conv = conversations.get(id);
      if (!conv) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(conv));
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
      return new Promise(resolve => server.close(resolve));
    },
    get conversations() { return conversations; },
    port: null,
    baseUrl: null
  };
}

module.exports = { createFakeOpenHandsServer };
