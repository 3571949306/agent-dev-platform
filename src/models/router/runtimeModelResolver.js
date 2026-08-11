'use strict';

const { normalizeModelRequirements } = require('./modelRequirements');

function unresolved(message) {
  const error = new Error(`RUNTIME_MODEL_UNRESOLVED: ${message}`);
  error.code = 'RUNTIME_MODEL_UNRESOLVED';
  return error;
}

function createRuntimeModelResolver({ router, createModelAdapter, audit } = {}) {
  if (!router || typeof router.select !== 'function') throw new Error('RUNTIME_MODEL_ROUTER_REQUIRED');
  if (typeof createModelAdapter !== 'function') throw new Error('RUNTIME_MODEL_ADAPTER_FACTORY_REQUIRED');

  function resolveRuntimeModel({ mode, requirements = {}, explicit = null, parentModelAdapter = null, parentSelection = null, context = {} } = {}) {
    if (mode === 'inherit_parent') {
      if (!parentModelAdapter || typeof parentModelAdapter.decide !== 'function') throw unresolved('parent ModelAdapter is required');
      return {
        modelAdapter: parentModelAdapter,
        selection: parentSelection || {
          selected: null, mode: 'inherit_parent', requirements: normalizeModelRequirements(requirements),
          score: null, scoreBreakdown: null, reasons: [{ code: 'INHERITED_PARENT_MODEL' }],
          rejectedCandidates: [], fallback: null, routedAt: new Date().toISOString()
        }
      };
    }
    if (!['auto', 'explicit'].includes(mode)) throw unresolved(`unsupported mode ${mode}`);
    const selection = router.select({ mode, requirements, explicit, context });
    const adapter = createModelAdapter(selection, context);
    if (!adapter || typeof adapter.decide !== 'function') throw unresolved('adapter factory returned an invalid ModelAdapter');
    if (!audit || !selection.decisionId) return { modelAdapter: adapter, selection };
    const wrapped = Object.create(adapter);
    wrapped.name = adapter.name;
    wrapped.decide = async input => {
      const started = Date.now();
      try {
        const result = await adapter.decide(input);
        audit.recordOutcome(selection.decisionId, {
          status: 'completed', latencyMs: Date.now() - started,
          inputTokens: result && Number.isFinite(result.inputTokens) ? result.inputTokens : null,
          outputTokens: result && Number.isFinite(result.outputTokens) ? result.outputTokens : null,
          errorCode: null
        });
        return result;
      } catch (error) {
        audit.recordOutcome(selection.decisionId, {
          status: 'failed', latencyMs: Date.now() - started,
          inputTokens: null, outputTokens: null, errorCode: error.code || 'MODEL_REQUEST_FAILED'
        });
        throw error;
      }
    };
    return { modelAdapter: wrapped, selection };
  }

  return { resolveRuntimeModel };
}

module.exports = { createRuntimeModelResolver };
