'use strict';
/**
 * Fake API —— GUI E2E 的本地模型服务（不开真实网络）。
 *
 * 能力：
 *  - GET  /v1/models              → model-A / model-B / model-C（OpenAI /models 格式）
 *  - POST /v1/chat/completions    → SSE 流式回复「你好，我是测试智能体。」
 *    · model=model-FAIL  → HTTP 500（业务失败）
 *    · model=model-HANG  → 永不返回（超时 / 停止用例）
 *  - POST /v1/chat/completions（老模型名）→ 回复 echo
 */
const http = require('http');

const MODELS = ['model-A', 'model-B', 'model-C'];

function start(preferredPort = 0) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) }));
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        let body = '';
        req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
          let model = 'model-A';
          try { model = JSON.parse(body || '{}').model || 'model-A'; } catch { /* ignore */ }

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

          // 正常 SSE 流式回复
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          res.flushHeaders && res.flushHeaders();
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
          req.on('close', () => clearInterval(timer));
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

module.exports = { start, MODELS };
