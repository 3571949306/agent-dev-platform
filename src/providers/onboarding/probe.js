'use strict';
/**
 * v2.4.1 Smart API Onboarding — Protocol Probe + Model Discovery（可靠性重写）。
 *
 * §11-§17: Model Discovery 与 Protocol Capability 严格分离。
 *   - /models 200 只说明模型发现可用，不等于 OpenAI Chat supported。
 *   - 每个协议独立探测 endpoint（405/400/401/403 = exists，404 = unsupported）。
 *
 * §18-§24: 新 Probe Scheduler。
 *   - Hint（parser/preset/url/port）只影响优先级，不禁止其他候选（§31）。
 *   - MAX_TOTAL_PROBES = 6（不再固定 4 导致漏协议）。
 *   - 分阶段：Stage A = model discovery，Stage B = protocol capability。
 *   - 可以提前结束（§23）：Ollama /api/tags 200 + localhost → 跳过 Anthropic/Responses。
 *
 * §32: Probe Report 新结构。
 *   { probeId, baseUrl, reachable, latencyMs,
 *     modelDiscovery: { status, path, models },
 *     protocols: [{ protocol, status, endpoint, confidence }],
 *     recommendedProtocol, aborted, state, errorCode, error,
 *     probeCount, protocolsAttempted }
 *
 * §50: Cancel ≠ Timeout。link.timedOut → 'timeout'，link.externallyAborted → 'cancelled'。
 * §51: Probe Error Codes。
 */

const { linkSignals, isAbortError } = require('../http');
const { normalizeBaseUrl, joinUrl, candidateModelPaths } = require('./urlNormalizer');

const MAX_TOTAL_PROBES = 6;
const PROBE_TIMEOUT_MS = 15000;

// 协议端点定义：protocol → { path, method }
const PROTOCOL_ENDPOINTS = {
  'openai':           { path: '/chat/completions', label: 'OpenAI Chat' },
  'openai-responses': { path: '/responses',        label: 'OpenAI Responses' },
  'anthropic':        { path: '/v1/messages',      label: 'Anthropic' },
  'ollama':           { path: '/api/tags',         label: 'Ollama' }
};

const ALL_PROTOCOLS = ['openai', 'openai-responses', 'anthropic', 'ollama'];

/** Release an unread fetch body so long probe matrices cannot retain sockets. */
async function discardResponse(response) {
  if (!response || !response.body || typeof response.body.cancel !== 'function') return;
  try { await response.body.cancel(); } catch { /* already consumed/closed */ }
}

// §31: 协议偏好顺序（当多协议同时 supported 时用于推荐）
const PROTOCOL_PREFERENCE = ['openai-responses', 'openai', 'anthropic', 'ollama'];

/**
 * §20/§31: Probe Scheduler —— 根据 hint 确定协议探测优先级。
 * Hint 只影响优先级，不禁止其他候选。
 */
function prioritizeProtocols(candidate, baseUrl) {
  const weights = new Map();
  for (const p of ALL_PROTOCOLS) weights.set(p, 0);

  // URL-based hints
  try {
    const u = new URL(baseUrl);
    const host = u.hostname.toLowerCase();
    const port = u.port;
    if (port === '11434' || host.includes('ollama')) weights.set('ollama', weights.get('ollama') + 10);
    if (port === '1234' || host.includes('lmstudio') || host.includes('lm-studio')) {
      weights.set('openai', weights.get('openai') + 8);
      weights.set('openai-responses', weights.get('openai-responses') + 6);
    }
    if (host.includes('anthropic') || host.includes('claude')) weights.set('anthropic', weights.get('anthropic') + 10);
    if (host.includes('openai')) {
      weights.set('openai-responses', weights.get('openai-responses') + 10);
      weights.set('openai', weights.get('openai') + 8);
    }
  } catch { /* invalid url, no url hints */ }

  // Parser hint
  if (candidate && candidate.protocolHint) {
    const ph = candidate.protocolHint;
    if (ph === 'anthropic') weights.set('anthropic', weights.get('anthropic') + 8);
    else if (ph === 'ollama') weights.set('ollama', weights.get('ollama') + 8);
    else if (ph === 'openai-responses') weights.set('openai-responses', weights.get('openai-responses') + 8);
    else if (ph === 'openai' || ph === 'local' || ph === 'custom') weights.set('openai', weights.get('openai') + 7);
  }

  return ALL_PROTOCOLS.slice().sort((a, b) => weights.get(b) - weights.get(a));
}

function isLocalhost(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return /^(localhost|127\.|0\.0\.0\.0|::1)$/i.test(u.hostname) || u.hostname === '[::1]';
  } catch { return false; }
}

function isOllamaHinted(candidate, baseUrl) {
  if (candidate && candidate.protocolHint === 'ollama') return true;
  try {
    const u = new URL(baseUrl);
    if (u.port === '11434') return true;
    if (u.hostname.toLowerCase().includes('ollama')) return true;
  } catch { /* */ }
  return false;
}

/**
 * @param {object} candidate ImportCandidate
 * @param {{ signal?: AbortSignal, timeoutMs?: number, probeId?: string, onProgress?: Function }} opts
 * @returns {Promise<object>} probe report
 */
async function probe(candidate, opts = {}) {
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const link = linkSignals(timeoutMs, opts.signal || null);
  const probeId = opts.probeId || null;
  const onProgress = opts.onProgress || null;

  const baseUrl = normalizeBaseUrl(candidate.baseUrl);
  const report = {
    probeId,
    baseUrl,
    reachable: false,
    latencyMs: null,
    // §12: Model Discovery 与 Protocol Capability 分离
    modelDiscovery: { status: 'unknown', path: null, models: [] },
    protocols: [],
    recommendedProtocol: null,
    aborted: false,
    state: null,
    errorCode: null,
    error: null,
    probeCount: 0,
    protocolsAttempted: [],
    modelEndpointAttempted: false,
    // 向后兼容旧字段
    candidates: [],
    models: []
  };

  if (!baseUrl) {
    link.dispose();
    report.error = '缺少 Base URL，无法检测';
    report.state = 'failed';
    report.errorCode = 'PROBE_NETWORK_ERROR';
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

  /** 检查是否已取消/超时 */
  const aborted = () => link.signal.aborted;

  /** 安全 fetch 包装 */
  async function safeFetch(url, connOverride) {
    const c = connOverride || conn;
    const headers = buildHeaders(c);
    return await fetch(url, { method: 'GET', headers, signal: link.signal });
  }

  try {
    // ─── Stage A: Model Discovery ──────────────────────────────────────
    // §13: /models 成功只说明 API 可达 + 模型列表能力，不说明 /chat/completions 存在。

    if (isOllamaHinted(candidate, baseUrl)) {
      // Ollama hint → 直接用 /api/tags 做模型发现（也同时确认 ollama 协议）
      if (probeCount < MAX_TOTAL_PROBES && !aborted()) {
        probeCount++;
        report.modelEndpointAttempted = true;
        if (onProgress) onProgress({ probeCount, modelEndpointAttempted: true });
        try {
          const r = await safeFetch(joinUrl(baseUrl, '/api/tags'), { ...conn, provider: 'ollama' });
          report.reachable = true;
          if (r.status === 200) {
            try {
              const json = await r.json();
              if (Array.isArray(json.models)) {
                report.modelDiscovery = {
                  status: 'supported',
                  path: '/api/tags',
                  models: json.models.map(m => m.name || m.model).filter(Boolean)
                };
                // Ollama /api/tags 200 同时确认 ollama 协议
                report.protocols.push({ protocol: 'ollama', status: 'supported', endpoint: '/api/tags', confidence: 0.95 });
                report.protocolsAttempted.push('ollama');
                if (onProgress) onProgress({ protocolAttempted: 'ollama' });
              }
            } catch { /* not json */ }
          } else {
            await discardResponse(r);
          }
        } catch (err) { if (isAbortError(err) || aborted()) throw err; /* network error, continue */ }
      }
    } else {
      // OpenAI-compatible model discovery: /models or /v1/models
      const modelPaths = candidateModelPaths(baseUrl);
      for (const mp of modelPaths) {
        if (probeCount >= MAX_TOTAL_PROBES || aborted()) break;
        probeCount++;
        report.modelEndpointAttempted = true;
        if (onProgress) onProgress({ probeCount, modelEndpointAttempted: true });
        try {
          const r = await safeFetch(joinUrl(baseUrl, mp));
          report.reachable = true;
          if (r.status === 200) {
            try {
              const json = await r.json();
              const list = Array.isArray(json) ? json : json.data;
              if (Array.isArray(list)) {
                report.modelDiscovery = {
                  status: 'supported',
                  path: mp,
                  models: list.map(m => m.id || m.name).filter(Boolean)
                };
                break; // 拿到模型列表就停
              }
            } catch { /* not json */ }
          } else if (r.status === 401 || r.status === 403) {
            // key 无效但端点存在 —— 模型发现 auth_failed
            if (report.modelDiscovery.status === 'unknown') {
              report.modelDiscovery = { status: 'auth_failed', path: mp, models: [] };
            }
          }
          if (r.status !== 200) await discardResponse(r);
          // 404/405 等：继续尝试下一个路径
        } catch (err) { if (isAbortError(err) || aborted()) throw err; /* network error, continue */ }
      }
    }

    // ─── Stage B: Protocol Capability（独立探测）────────────────────────
    // §14-§17: 每个协议独立探测，/models 不等于任何协议 supported。
    // §20: 按 hint 优先级排序，但所有协议都有机会被探测。
    // §23: 可以提前结束 —— Ollama 已确认 + localhost → 跳过其他协议。

    const priority = prioritizeProtocols(candidate, baseUrl);
    const ollamaAlreadyConfirmed = report.protocols.some(p => p.protocol === 'ollama' && p.status === 'supported');

    // §23: Ollama 已确认 + localhost → 跳过 Anthropic/Responses/Chat
    const skipRemaining = ollamaAlreadyConfirmed && isLocalhost(baseUrl);

    for (const proto of priority) {
      if (probeCount >= MAX_TOTAL_PROBES || aborted()) break;
      if (skipRemaining && proto !== 'ollama') continue;
      // 已探测的协议不重复
      if (report.protocols.some(p => p.protocol === proto)) continue;

      const ep = PROTOCOL_ENDPOINTS[proto];
      if (!ep) continue;

      probeCount++;
      report.protocolsAttempted.push(proto);
      if (onProgress) onProgress({ probeCount, protocolAttempted: proto });

      const connForProto = proto === 'anthropic'
        ? { ...conn, provider: 'anthropic' }
        : proto === 'ollama'
          ? { ...conn, provider: 'ollama' }
          : conn;

      try {
        const r = await safeFetch(joinUrl(baseUrl, ep.path), connForProto);
        report.reachable = true;
        const status = interpretStatus(r.status, proto);

        if (proto === 'ollama' && r.status === 200) {
          // Ollama /api/tags 200 → 协议 supported + 模型发现
          let models = [];
          try {
            const json = await r.json();
            if (Array.isArray(json.models)) models = json.models.map(m => m.name || m.model).filter(Boolean);
          } catch { /* not json */ }
          report.protocols.push({ protocol: 'ollama', status: 'supported', endpoint: ep.path, confidence: 0.95 });
          if (report.modelDiscovery.status === 'unknown' || report.modelDiscovery.status === 'auth_failed') {
            report.modelDiscovery = { status: 'supported', path: ep.path, models };
          }
        } else {
          report.protocols.push({ protocol: proto, status, endpoint: ep.path, confidence: status === 'supported' ? 0.85 : 0.6 });
          await discardResponse(r);
        }
      } catch (err) {
        if (isAbortError(err) || aborted()) throw err;
        // network error → 无法判断，标记 unknown
        report.protocols.push({ protocol: proto, status: 'unknown', endpoint: ep.path, confidence: 0 });
      }
    }

    // ─── Finalize ──────────────────────────────────────────────────────
    report.latencyMs = Date.now() - t0;
    report.probeCount = probeCount;
    report.recommendedProtocol = pickRecommended(report.protocols, candidate.protocolHint);
    report.state = 'completed';

    // §51: 没有可用协议时设 NO_PROTOCOL
    const hasSupported = report.protocols.some(p => p.status === 'supported');
    if (!hasSupported && report.modelDiscovery.status !== 'supported') {
      report.errorCode = 'PROBE_NO_PROTOCOL';
    }

    // 向后兼容
    report.candidates = report.protocols.map(p => ({ protocol: p.protocol, status: p.status, confidence: p.confidence || 0 }));
    report.models = report.modelDiscovery.models || [];

  } catch (err) {
    report.latencyMs = Date.now() - t0;
    report.probeCount = probeCount;
    // §50: Cancel ≠ Timeout
    if (link.timedOut) {
      report.state = 'timeout';
      report.errorCode = 'PROBE_TIMEOUT';
      report.error = '检测超时';
    } else if (link.externallyAborted || isAbortError(err)) {
      report.aborted = true;
      report.state = 'cancelled';
      report.errorCode = 'PROBE_CANCELLED';
      report.error = '检测已取消';
    } else {
      report.state = 'failed';
      report.errorCode = 'PROBE_NETWORK_ERROR';
      report.error = err.message || String(err);
    }
    // 向后兼容
    report.candidates = report.protocols.map(p => ({ protocol: p.protocol, status: p.status, confidence: p.confidence || 0 }));
    report.models = report.modelDiscovery.models || [];
  } finally {
    link.dispose();
  }

  return report;
}

/**
 * §14: 根据 HTTP 状态码判断协议是否 supported。
 * 405/400/401/403 → endpoint exists = supported
 * 404 → unsupported
 * 200 → supported（Ollama /api/tags 或其他异常但端点存在）
 * 其他 → unknown
 */
function interpretStatus(status, proto) {
  if (status === 405 || status === 400 || status === 401 || status === 403) return 'supported';
  if (status === 404) return 'unsupported';
  if (status === 200) return 'supported';
  return 'unknown';
}

function buildHeaders(conn) {
  const h = { 'Content-Type': 'application/json' };
  const isOllama = conn.provider === 'ollama' || conn.provider === 'local';
  if (conn.api_key && !isOllama) {
    if (conn.provider === 'anthropic') {
      h['x-api-key'] = conn.api_key;
      h['anthropic-version'] = '2023-06-01';
    } else {
      h['Authorization'] = `Bearer ${conn.api_key}`;
    }
  }
  if (conn.headers && typeof conn.headers === 'object') {
    for (const [k, v] of Object.entries(conn.headers)) {
      if (k.startsWith('x-')) continue;
      h[k] = v;
    }
  }
  return h;
}

function pickRecommended(protocols, hint) {
  const supported = protocols.filter(p => p.status === 'supported');
  if (!supported.length) return null;
  const supportedSet = new Set(supported.map(p => p.protocol));
  // 按偏好顺序选第一个 supported 的
  for (const p of PROTOCOL_PREFERENCE) {
    if (supportedSet.has(p)) return p;
  }
  return supported[0].protocol;
}

module.exports = { probe, MAX_TOTAL_PROBES, PROBE_TIMEOUT_MS, prioritizeProtocols, ALL_PROTOCOLS, PROTOCOL_ENDPOINTS, discardResponse };
