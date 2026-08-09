'use strict';
/**
 * v2.4.0 Smart API Onboarding — Protocol Probe + Model Discovery。
 *
 * §24/§25/§26/§28/§29：智能协议检测，复用 v2.2 HTTP Abort 合约。
 *
 * 流程：
 *   Parse / Hint → Normalize URL → 低成本 models probe → 必要时协议 probe → 检测报告
 *
 * 探测策略（不发真实大模型请求，避免成本）：
 *   - GET /models（或 /v1/models）：200 = 模型发现可用；401 = key 无效但端点存在；404 = 不支持
 *   - GET /chat/completions：405 = 端点存在（OpenAI Chat）；404 = 不存在
 *   - GET /responses：405 = 端点存在（OpenAI Responses）；404 = 不存在
 *   - GET /v1/messages：405 = 端点存在（Anthropic）；404 = 不存在
 *   - GET /api/tags：200 = Ollama 模型发现可用
 *
 * §28：MAX_PROBES = 4（总请求数上限）。
 * §29：复用 linkSignals(timeoutMs, externalSignal) → 取消检测立即停止网络请求。
 *
 * 输出（§30）：
 *   { baseUrl, reachable, latencyMs, candidates: [{protocol, status, confidence}], models: [], recommendedProtocol }
 */

const { linkSignals, isAbortError } = require('../http');
const { normalizeBaseUrl, joinUrl, candidateModelPaths } = require('./urlNormalizer');

const MAX_PROBES = 4;
const PROBE_TIMEOUT_MS = 8000;

/**
 * @param {object} candidate ImportCandidate
 * @param {{ signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {Promise<object>} probe report
 */
async function probe(candidate, opts = {}) {
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const link = linkSignals(timeoutMs, opts.signal || null);

  const baseUrl = normalizeBaseUrl(candidate.baseUrl);
  const report = {
    baseUrl,
    reachable: false,
    latencyMs: null,
    candidates: [],
    models: [],
    recommendedProtocol: null,
    aborted: false,
    error: null
  };

  if (!baseUrl) {
    link.dispose();
    report.error = '缺少 Base URL，无法检测';
    return report;
  }

  const conn = {
    provider: candidate.protocolHint || 'custom',
    base_url: baseUrl,
    api_key: candidate.apiKey || '',
    headers: candidate.headers || {}
  };

  let probeCount = 0;
  const t0 = Date.now();

  try {
    // 1. 模型发现 probe（OpenAI 兼容 /v1/models 或 /models）
    const modelPaths = candidateModelPaths(baseUrl).slice(0, 2); // 最多 2 个路径
    let modelsFound = null;
    for (const path of modelPaths) {
      if (probeCount >= MAX_PROBES) break;
      if (link.signal.aborted) break;
      probeCount++;
      const url = joinUrl(baseUrl, path);
      const r = await safeFetch(url, 'GET', conn, link);
      if (!r) continue;
      report.reachable = true;
      if (r.status === 200) {
        try {
          const json = await r.json();
          const list = Array.isArray(json) ? json : json.data;
          if (Array.isArray(list)) {
            modelsFound = list.map(m => m.id || m.name).filter(Boolean);
          }
        } catch { /* not json */ }
        if (modelsFound) break; // 拿到模型列表就停
      } else if (r.status === 401 || r.status === 403) {
        // key 无效但端点存在 —— 仍标记 reachable，模型发现不可用
        report.candidates.push({ protocol: 'openai', status: 'auth_failed', confidence: 0.5 });
      }
      // 404/405 等：继续尝试下一个路径
    }

    if (modelsFound) {
      report.models = modelsFound;
      report.candidates.push({ protocol: 'openai', status: 'supported', confidence: 0.9, modelsFound: modelsFound.length });
    }

    // 1b. /chat/completions probe —— 模型发现失败时（Server D：/models 404），
    // 用 GET /chat/completions 的 405/400/401 确认 OpenAI Chat 端点存在（§71 D）。
    if (!modelsFound && !link.signal.aborted && probeCount < MAX_PROBES &&
        shouldTryProtocol(candidate, 'openai')) {
      probeCount++;
      const r = await safeFetch(joinUrl(baseUrl, '/chat/completions'), 'GET', conn, link);
      if (r) {
        report.reachable = true;
        if (r.status === 405 || r.status === 400 || r.status === 401) {
          report.candidates.push({ protocol: 'openai', status: 'supported', confidence: 0.8 });
        } else if (r.status === 404) {
          report.candidates.push({ protocol: 'openai', status: 'unsupported', confidence: 0.6 });
        }
      }
    }

    // 2. 协议 probe（仅当模型发现未明确时，或 baseUrl 看起来是 Anthropic/Ollama 时）
    if (!link.signal.aborted && probeCount < MAX_PROBES) {
      // Anthropic /v1/messages
      if (shouldTryProtocol(candidate, 'anthropic')) {
        if (probeCount < MAX_PROBES && !link.signal.aborted) {
          probeCount++;
          const r = await safeFetch(joinUrl(baseUrl, '/v1/messages'), 'GET', { ...conn, provider: 'anthropic' }, link);
          if (r) {
            report.reachable = true;
            if (r.status === 405 || r.status === 400 || r.status === 401) {
              report.candidates.push({ protocol: 'anthropic', status: 'supported', confidence: 0.85 });
            } else if (r.status === 404) {
              report.candidates.push({ protocol: 'anthropic', status: 'unsupported', confidence: 0.7 });
            }
          }
        }
      }
    }

    if (!link.signal.aborted && probeCount < MAX_PROBES) {
      // OpenAI Responses /responses
      if (shouldTryProtocol(candidate, 'openai-responses')) {
        probeCount++;
        const r = await safeFetch(joinUrl(baseUrl, '/responses'), 'GET', conn, link);
        if (r) {
          report.reachable = true;
          if (r.status === 405 || r.status === 400 || r.status === 401) {
            report.candidates.push({ protocol: 'openai-responses', status: 'supported', confidence: 0.85 });
          } else if (r.status === 404) {
            report.candidates.push({ protocol: 'openai-responses', status: 'unsupported', confidence: 0.6 });
          }
        }
      }
    }

    if (!link.signal.aborted && probeCount < MAX_PROBES) {
      // Ollama /api/tags（本地）
      if (shouldTryProtocol(candidate, 'ollama')) {
        probeCount++;
        const r = await safeFetch(joinUrl(baseUrl, '/api/tags'), 'GET', { ...conn, provider: 'ollama' }, link);
        if (r) {
          report.reachable = true;
          if (r.status === 200) {
            try {
              const json = await r.json();
              if (Array.isArray(json.models)) {
                report.models = json.models.map(m => m.name || m.model).filter(Boolean);
                report.candidates.push({ protocol: 'ollama', status: 'supported', confidence: 0.95, modelsFound: report.models.length });
              }
            } catch { /* ignore */ }
          }
        }
      }
    }

    report.latencyMs = Date.now() - t0;
    report.recommendedProtocol = pickRecommended(report.candidates, candidate.protocolHint);
  } catch (err) {
    report.aborted = isAbortError(err) || (link.signal.aborted === true);
    report.latencyMs = Date.now() - t0;
    if (!report.aborted) report.error = err.message || String(err);
  } finally {
    link.dispose();
  }

  return report;
}

async function safeFetch(url, method, conn, link) {
  try {
    const headers = buildHeaders(conn);
    const r = await fetch(url, { method, headers, signal: link.signal });
    return r;
  } catch (err) {
    // abort 由 link.signal 触发，向上传播
    throw err;
  }
}

function buildHeaders(conn) {
  const h = { 'Content-Type': 'application/json' };
  const isOllama = conn.provider === 'ollama' || conn.provider === 'local';
  if (conn.api_key && !isOllama) {
    // Anthropic 用 x-api-key，其他用 Bearer
    if (conn.provider === 'anthropic') {
      h['x-api-key'] = conn.api_key;
      h['anthropic-version'] = '2023-06-01';
    } else {
      h['Authorization'] = `Bearer ${conn.api_key}`;
    }
  }
  if (conn.headers && typeof conn.headers === 'object') {
    for (const [k, v] of Object.entries(conn.headers)) {
      if (k.startsWith('x-')) continue; // 跳过我们的内部标记
      h[k] = v;
    }
  }
  return h;
}

function shouldTryProtocol(candidate, protocol) {
  // 如果候选已 hint 某协议，优先探测那个；否则对 OpenAI 系都试
  if (!candidate.protocolHint || candidate.protocolHint === 'custom') return true;
  if (candidate.protocolHint === protocol) return true;
  // openai hint 也尝试 responses
  if (candidate.protocolHint === 'openai' && protocol === 'openai-responses') return true;
  return false;
}

// 协议偏好：当多个协议同时 supported 时，按此顺序推荐。
// §31: Chat + Responses 同时可用时推荐 Responses（更新的 API），用户可改（§32）。
const PROTOCOL_PREFERENCE = ['openai-responses', 'openai', 'anthropic', 'ollama', 'local', 'custom'];

function pickRecommended(candidates, hint) {
  if (!candidates.length) return null;
  const supported = candidates.filter(c => c.status === 'supported');
  if (!supported.length) return null;
  const supportedProtocols = new Set(supported.map(c => c.protocol));
  // 按偏好顺序选第一个 supported 的
  for (const p of PROTOCOL_PREFERENCE) {
    if (supportedProtocols.has(p)) return p;
  }
  return supported[0].protocol;
}

module.exports = { probe, MAX_PROBES, PROBE_TIMEOUT_MS };
