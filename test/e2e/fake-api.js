'use strict';
/**
 * Fake API —— GUI E2E 的本地模型服务（不开真实网络）。
 *
 * 能力：
 *  - GET  /v1/models              → model-A / model-B / model-C（OpenAI /models 格式）
 *    · opts.modelsEnabled=false   → 404（§77 手动模型用例）
 *  - GET  /v1/chat/completions    → 405（§71D / §77: probe 确认 OpenAI Chat 端点存在）
 *  - POST /v1/chat/completions    → SSE 流式回复「你好，我是测试智能体。」
 *    · model=model-FAIL  → HTTP 500（业务失败）
 *    · model=model-HANG  → 永不返回（超时 / 停止用例）
 *    · model=model-QUICK → 回复「QUICK_CONNECT_OK」（§76 一键分配主智能体）
 *  - POST /v1/chat/completions（老模型名）→ 回复 echo
 */
const http = require('http');

const MODELS = ['model-A', 'model-B', 'model-C'];

function start(preferredPort = 0, opts = {}) {
  const modelsEnabled = opts.modelsEnabled !== false; // 默认 true
  const workbench = opts.workbench === true;
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/v1/models') {
        if (!modelsEnabled) {
          // §77: /models 不可用，但 chat 端点可用
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'models not found' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) }));
        return;
      }

      // §71D / §77: GET /chat/completions → 405 表示端点存在（OpenAI Chat supported）
      if (req.method === 'GET' && pathname === '/v1/chat/completions') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Method Not Allowed' } }));
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          let model = 'model-A';
          let requestBody = {};
          try { requestBody = JSON.parse(body || '{}'); model = requestBody.model || 'model-A'; } catch { /* ignore */ }

          if (workbench) {
            const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
            const system = String((messages.find(m => m.role === 'system') || {}).content || '');
            const context = String((messages.filter(m => m.role === 'user').pop() || {}).content || '');
            const isChild = system.includes('# Dynamic Agent Base Prompt');
            let action;
            if (isChild) {
              const summary = system.includes('Return findings without modifying files.')
                ? 'REVIEWER_RESULT_4817'
                : 'TEST_ANALYST_RESULT_9264';
              action = { type: 'complete', args: { summary } };
            } else if (!context.includes('REVIEWER_RESULT_4817')) {
              action = { type: 'delegate', args: { goal: 'Review the workbench fixture', inlineAgentDefinition: inlineDefinition('Temporary Reviewer', 'code_reviewer', 'Return findings without modifying files.') } };
            } else if (!context.includes('TEST_ANALYST_RESULT_9264')) {
              action = { type: 'delegate', args: { goal: 'Analyze the workbench tests', inlineAgentDefinition: inlineDefinition('Temporary Test Analyst', 'test_analyst', 'Analyze test coverage and return TEST_ANALYST_RESULT_9264.') } };
            } else if (!context.includes('WORKBENCH_FIXTURE_CONTENT')) {
              action = { type: 'read_file', args: { path: 'src/main.js' } };
            } else if (!context.includes('WORKBENCH_TEST_PASS')) {
              action = { type: 'run_tests', args: { command: `node -e "console.log('WORKBENCH_TEST_PASS')"` } };
            } else {
              action = { type: 'complete', args: { summary: 'Workbench task complete: children consumed, file read, tests passed.' } };
            }
            return streamReply(res, model, JSON.stringify({ action }));
          }

          if (model === 'model-FAIL') {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'FAKE_SERVER_FAILURE' } }));
            return;
          }

          if (model === 'model-HANG') {
            // 永不返回：保持连接挂起，直到客户端断开（停止/超时用例）
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write('data: {"choices":[{"delta":{"content":"正在等待…"}}]}\n\n');
            res.flushHeaders && res.flushHeaders();
            return; // 不 end()
          }

          // §76: model-QUICK → 回复 QUICK_CONNECT_OK（一键分配主智能体验收）
          if (model === 'model-QUICK') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });
            const reply = 'QUICK_CONNECT_OK';
            let i = 0;
            const timer = setInterval(() => {
              if (i >= reply.length) {
                clearInterval(timer);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              const chunk = reply.slice(i, i + 3);
              i += 3;
              res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
            }, 20);
            res.on('close', () => clearInterval(timer));
            return;
          }

          // 正常 SSE 流式回复
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          const reply = '你好，我是测试智能体。';
          let i = 0;
          const timer = setInterval(() => {
            if (i >= reply.length) {
              clearInterval(timer);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            const chunk = reply.slice(i, i + 3);
            i += 3;
            res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] })}\n\n`);
          }, 20);
          // v2.3.2: 必须用 res.on('close') 而非 req.on('close') —— req 'close' 在请求体
          // 接收完成后就触发，会立即清掉 timer，导致 SSE body 永远不发送（Case 3 卡死根因）。
          res.on('close', () => clearInterval(timer));
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found: ' + pathname } }));
    });

    srv.on('error', reject);
    srv.listen(preferredPort, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ server: srv, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

module.exports = { start, startProbeServer, startHangServer, MODELS };

function inlineDefinition(name, role, systemPrompt) {
  return {
    name, role, systemPrompt,
    runtime: { kind: 'native' },
    toolPolicy: { allow: ['read_file'], deny: [] },
    permissionPolicy: { readOnly: true, allow: ['filesystem.read'], deny: [] },
    modelPolicy: { mode: 'inherit_parent' },
    lifetime: 'run', canDelegate: false
  };
}

function streamReply(res, model, reply) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-workbench', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * v2.4.1 — Probe 专用 Fake Server（spec §25-§30 E2E fixtures）。
 *
 * Scenarios:
 *   'responses-only': /models 200, /chat/completions 404, /responses 405
 *   'models-only':    /models 200, /chat/completions 404, /responses 404, /messages 404
 *   'chat-only':      /models 200, /chat/completions 405, /responses 404
 *   'both':           /models 200, /chat/completions 405, /responses 405
 */
function startProbeServer(scenario = 'responses-only') {
  const routes = {
    'responses-only': {
      'GET /v1/models': { status: 200, body: { data: [{ id: 'resp-model' }] } },
      'GET /v1/chat/completions': 404,
      'GET /v1/responses': 405,
      'GET /v1/messages': 404,
      'GET /v1/api/tags': 404
    },
    'models-only': {
      'GET /v1/models': { status: 200, body: { data: [{ id: 'model-x' }] } },
      'GET /v1/chat/completions': 404,
      'GET /v1/responses': 404,
      'GET /v1/messages': 404,
      'GET /v1/api/tags': 404
    },
    'chat-only': {
      'GET /v1/models': { status: 200, body: { data: [{ id: 'chat-model' }] } },
      'GET /v1/chat/completions': 405,
      'GET /v1/responses': 404,
      'GET /v1/messages': 404,
      'GET /v1/api/tags': 404
    },
    'both': {
      'GET /v1/models': { status: 200, body: { data: [{ id: 'dual-model' }] } },
      'GET /v1/chat/completions': 405,
      'GET /v1/responses': 405,
      'GET /v1/messages': 404,
      'GET /v1/api/tags': 404
    }
  };

  const table = routes[scenario] || routes['responses-only'];

  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      const rule = table[key];
      if (!rule) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found: ' + key } }));
        return;
      }
      const status = typeof rule === 'number' ? rule : rule.status;
      const body = typeof rule === 'object' && rule.body !== undefined ? rule.body : null;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      if (body !== null) res.end(JSON.stringify(body));
      else res.end();
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ server: srv, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/**
 * v2.4.1 — Hang Server（spec §9/§55 E2E Probe Cancel）。
 * 接受 TCP 连接但永不响应，用于验证 cancel < 2s。
 */
function startHangServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((_req, _res) => { /* hang forever */ });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ server: srv, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}
