'use strict';

const { normalizeModelCandidate, evidence } = require('./modelCandidate');

function publicLocality(connection) {
  if (['local', 'ollama', 'mock'].includes(connection.provider)) return 'local';
  try {
    const host = new URL(connection.base_url || '').hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
    if (host) return 'remote';
  } catch { /* unknown URL remains unknown */ }
  return 'unknown';
}

function metadataFor(modelRow, key, aliases = []) {
  const caps = modelRow && modelRow.capabilities ? modelRow.capabilities : {};
  for (const name of [key, ...aliases]) if (caps[name] !== undefined) return caps[name];
  return undefined;
}

function createModelCatalog({ store } = {}) {
  if (!store || !store.connections || !store.models) throw new Error('MODEL_CATALOG_STORE_REQUIRED');

  function listCandidates() {
    const candidates = [];
    const connections = store.connections.list().slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    for (const connection of connections) {
      const rows = store.models.listByConnection(connection.id);
      const rowById = new Map(rows.map(row => [row.model_id, row]));
      const models = Array.isArray(connection.models) ? connection.models : [];
      for (const model of models.slice().sort((a, b) => String(a && a.id).localeCompare(String(b && b.id)))) {
        if (!model || typeof model.id !== 'string' || !model.id.trim()) continue;
        const row = rowById.get(model.id) || null;
        const caps = row && row.capabilities ? row.capabilities : {};
        const contextWindow = metadataFor(row, 'contextWindow', ['context_window']);
        const pricing = metadataFor(row, 'pricing') || {};
        const locality = publicLocality(connection);
        candidates.push(normalizeModelCandidate({
          connectionId: connection.id,
          connectionName: connection.name,
          provider: connection.provider,
          protocol: connection.provider,
          modelId: model.id,
          displayName: (row && row.display_name) || model.displayName || model.id,
          enabled: connection.enabled !== false && connection.enabled !== 0 && connection.disabled !== true,
          authenticated: locality === 'local' || connection.has_key === true,
          capabilities: {
            // Presence in the configured model catalog is provider/manual declaration
            // of a text model; no capability is inferred from the model name.
            text: caps.text === undefined ? { value: true, state: 'declared', source: 'configured-model-catalog' } : caps.text,
            vision: caps.vision,
            nativeTools: caps.nativeTools === undefined ? caps.tools : caps.nativeTools,
            streaming: caps.streaming
          },
          contextWindow,
          pricing,
          latency: {
            ms: metadataFor(row, 'latencyMs', ['latency_ms']) || connection.latency_ms,
            source: row && (caps.latencyMs !== undefined || caps.latency_ms !== undefined) ? 'model-metadata' : (connection.latency_ms == null ? null : 'connection-probe'),
            measuredAt: connection.tested_at || null
          },
          locality,
          metadata: {
            modelSource: model.source || null,
            favorite: !!(model.favorite || (row && row.favorite)),
            contextEvidence: contextWindow === undefined ? evidence(null, { numeric: true }) : undefined
          }
        }));
      }
    }
    return candidates;
  }

  function getCandidate(connectionId, modelId) {
    return listCandidates().find(candidate => candidate.connectionId === connectionId && candidate.modelId === modelId) || null;
  }

  return { listCandidates, getCandidate };
}

module.exports = { createModelCatalog, publicLocality };
