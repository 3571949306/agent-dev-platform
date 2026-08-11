'use strict';

const crypto = require('crypto');
const { normalizeGeneratorRequest, ARTIFACT_TYPES } = require('./generatorRequest');
const { strictParseCandidate, buildGenerationPrompt, buildRepairPrompt } = require('./generationProtocol');
const { generatorError, errorRecord } = require('./errors');
const { intentEvidence } = require('./generatorAudit');

const GENERATION_TERMINAL = new Set(['READY', 'FAILED', 'CANCELLED', 'SAVED', 'DISCARDED']);
const MAX_REPAIRS = 2;
const MAX_PROVIDER_ATTEMPTS = 3;

function now() { return new Date().toISOString(); }

function createMemoryDraftStore() {
  const rows = new Map();
  return {
    create(input) { rows.set(input.draftId, structuredClone(input)); return this.get(input.draftId); },
    get(id) { return rows.has(id) ? structuredClone(rows.get(id)) : null; },
    list(limit = 100) { return [...rows.values()].slice(-limit).reverse().map(value => structuredClone(value)); },
    update(id, patch) {
      if (!rows.has(id)) return null;
      rows.set(id, { ...rows.get(id), ...structuredClone(patch), updatedAt: patch.updatedAt || now() });
      return this.get(id);
    }
  };
}

function createGeneratorService(options = {}) {
  const draftStore = options.draftStore || createMemoryDraftStore();
  const adapters = options.adapterRegistry;
  const capabilityCatalog = options.capabilityCatalog;
  const resolveRuntimeModel = options.resolveRuntimeModel;
  const audit = options.audit;
  const active = new Map();
  const requestTimeoutMs = options.requestTimeoutMs || 120000;
  const totalTimeoutMs = options.totalTimeoutMs || 300000;

  if (!adapters || typeof adapters.get !== 'function') throw new Error('GENERATOR_ADAPTER_REGISTRY_REQUIRED');
  if (!capabilityCatalog || typeof capabilityCatalog.build !== 'function') throw new Error('GENERATOR_CAPABILITY_CATALOG_REQUIRED');
  if (typeof resolveRuntimeModel !== 'function') throw new Error('GENERATOR_MODEL_RESOLVER_REQUIRED');

  function getDraft(draftId) { return draftStore.get(draftId); }
  function listDrafts(limit) { return draftStore.list(limit); }

  function updateIfGenerating(control, patch) {
    const current = getDraft(control.draftId);
    if (!current || GENERATION_TERMINAL.has(current.status) || control.cancelled || control.timedOut) return current;
    return draftStore.update(control.draftId, { ...patch, updatedAt: now() });
  }

  function recordAudit(control, status, draft, extra = {}) {
    if (!audit || typeof audit.record !== 'function') return;
    const validationCodes = draft && draft.validation && draft.validation.errors
      ? draft.validation.errors.map(error => error.code)
      : [];
    audit.record({
      generationId: control.generationId,
      draftId: control.draftId,
      artifactType: control.artifactType,
      status,
      attemptCount: draft && draft.attempts || 0,
      repairCount: draft && draft.repairCount || 0,
      routeDecisionId: draft && draft.routeDecisionId || null,
      selectedConnectionId: draft && draft.selectedModel && draft.selectedModel.connectionId || null,
      selectedModelId: draft && draft.selectedModel && draft.selectedModel.modelId || null,
      validationCodes,
      savedArtifactId: extra.savedArtifactId || null,
      intentHash: control.intentHash,
      intentLength: control.intentLength,
      durationMs: Date.now() - control.startedAt
    });
  }

  function validateCandidate(adapter, candidate, capabilityContext) {
    try {
      const normalized = adapter.validate(candidate, capabilityContext);
      adapter.validateReferences(normalized, capabilityContext);
      return { candidate: normalized, validation: { valid: true, errors: [], warnings: [] } };
    } catch (error) {
      return { candidate, validation: { valid: false, errors: [errorRecord(error)], warnings: [] } };
    }
  }

  function failDraft(control, error, validation = null) {
    const current = getDraft(control.draftId);
    if (!current || ['CANCELLED', 'SAVED', 'DISCARDED'].includes(current.status)) return current;
    const failed = draftStore.update(control.draftId, {
      status: 'FAILED',
      validation: validation || current.validation,
      errorCode: error.code || 'GENERATOR_FAILED',
      error: String(error.message || error).slice(0, 1000),
      terminalAt: now(),
      updatedAt: now()
    });
    recordAudit(control, 'FAILED', failed);
    return failed;
  }

  function modelCall(modelAdapter, prompt, abortController, iteration) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(generatorError('GENERATOR_TIMEOUT', 'generation request timed out'));
      }, requestTimeoutMs);
    });
    return Promise.race([
      modelAdapter.decide({
        system: prompt.system,
        context: prompt.context,
        iteration,
        abortSignal: abortController.signal
      }),
      timeout
    ]).finally(() => clearTimeout(timer));
  }

  async function execute(control, request) {
    const totalTimer = setTimeout(() => {
      control.timedOut = true;
      control.abortController.abort();
      failDraft(control, generatorError('GENERATOR_TIMEOUT', 'total generation timeout exceeded'));
    }, totalTimeoutMs);
    try {
      const adapter = adapters.get(request.artifactType);
      const capabilityContext = capabilityCatalog.build();
      const contract = adapter.getGenerationContract(capabilityContext);
      const resolved = resolveRuntimeModel({
        mode: request.mode === 'explicit_model' ? 'explicit' : 'auto',
        requirements: {
          required: { text: true },
          preferences: { latency: 'balanced', cost: 'balanced' }
        },
        explicit: request.explicitModel,
        context: {
          agentId: 'ai-generator',
          projectId: request.context.projectId,
          timeoutMs: requestTimeoutMs,
          agent: { id: 'ai-generator', name: 'AI Generator', max_tokens: 8192 }
        }
      });
      if (control.cancelled || control.timedOut) return getDraft(control.draftId);
      const selected = resolved.selection && resolved.selection.selected;
      updateIfGenerating(control, {
        selectedModel: selected ? { connectionId: selected.connectionId, modelId: selected.modelId } : null,
        routeDecisionId: resolved.selection && resolved.selection.decisionId || null
      });
      let prompt = buildGenerationPrompt({ request, contract, capabilityContext });
      let previousOutput = '';
      let lastValidation = { valid: false, errors: [], warnings: [] };

      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
        if (control.cancelled || control.timedOut) return getDraft(control.draftId);
        updateIfGenerating(control, {
          status: attempt === 1 ? 'GENERATING' : 'REPAIRING',
          attempts: attempt,
          repairCount: attempt - 1
        });
        let parsed = null;
        try {
          const result = await modelCall(resolved.modelAdapter, prompt, control.abortController, attempt);
          if (control.cancelled || control.timedOut || GENERATION_TERMINAL.has(getDraft(control.draftId).status)) {
            return getDraft(control.draftId);
          }
          updateIfGenerating(control, { status: 'VALIDATING' });
          previousOutput = result && result.text !== undefined ? String(result.text) : '';
          parsed = strictParseCandidate(previousOutput);
          const checked = validateCandidate(adapter, parsed, capabilityContext);
          lastValidation = checked.validation;
          if (checked.validation.valid) {
            const ready = updateIfGenerating(control, {
              status: 'READY',
              candidate: checked.candidate,
              validation: checked.validation,
              attempts: attempt,
              repairCount: attempt - 1,
              errorCode: null,
              error: null,
              terminalAt: now()
            });
            recordAudit(control, 'READY', ready);
            return ready;
          }
        } catch (error) {
          if (control.cancelled || control.timedOut) return getDraft(control.draftId);
          if (error.code === 'GENERATOR_TIMEOUT') throw error;
          lastValidation = { valid: false, errors: [errorRecord(error)], warnings: [] };
        }
        updateIfGenerating(control, { candidate: parsed, validation: lastValidation });
        if (attempt < MAX_PROVIDER_ATTEMPTS) {
          prompt = buildRepairPrompt({ previousOutput, errors: lastValidation.errors, capabilityContext, contract });
        }
      }
      return failDraft(control, generatorError('GENERATOR_REPAIR_EXHAUSTED', 'candidate remained invalid after two repairs'), lastValidation);
    } catch (error) {
      if (control.cancelled || control.timedOut) return getDraft(control.draftId);
      return failDraft(control, error);
    } finally {
      clearTimeout(totalTimer);
    }
  }

  function generate(input) {
    const generationId = crypto.randomUUID();
    const draftId = crypto.randomUUID();
    const rawIntent = input && typeof input.intent === 'string' ? input.intent : '';
    const evidence = intentEvidence(rawIntent);
    const artifactType = input && ARTIFACT_TYPES.includes(input.artifactType) ? input.artifactType : 'unknown';
    const control = {
      generationId,
      draftId,
      artifactType,
      intentHash: evidence.intentHash,
      intentLength: evidence.intentLength,
      startedAt: Date.now(),
      cancelled: false,
      timedOut: false,
      abortController: new AbortController(),
      promise: null
    };
    let request;
    try { request = normalizeGeneratorRequest(input); }
    catch (error) {
      const failed = draftStore.create({
        draftId, generationId, artifactType, status: 'FAILED', candidate: null,
        validation: { valid: false, errors: [errorRecord(error)], warnings: [] },
        attempts: 0, repairCount: 0, selectedModel: null, routeDecisionId: null,
        errorCode: error.code, error: String(error.message).slice(0, 1000),
        createdAt: now(), updatedAt: now(), terminalAt: now()
      });
      recordAudit(control, 'FAILED', failed);
      return failed;
    }
    control.artifactType = request.artifactType;
    const draft = draftStore.create({
      draftId, generationId, artifactType: request.artifactType, status: 'GENERATING', candidate: null,
      validation: { valid: false, errors: [], warnings: [] }, attempts: 0, repairCount: 0,
      selectedModel: null, routeDecisionId: null, errorCode: null, error: null,
      createdAt: now(), updatedAt: now(), terminalAt: null
    });
    active.set(draftId, control);
    control.promise = execute(control, request).finally(() => active.delete(draftId));
    return draft;
  }

  async function wait(draftId) {
    const control = active.get(draftId);
    if (control && control.promise) await control.promise;
    return getDraft(draftId);
  }

  function validate(draftId) {
    const draft = getDraft(draftId);
    if (!draft) throw generatorError('GENERATOR_DRAFT_NOT_FOUND', draftId);
    if (['CANCELLED', 'DISCARDED', 'SAVED'].includes(draft.status)) {
      throw generatorError('GENERATOR_DRAFT_TERMINAL', `${draftId} is ${draft.status}`);
    }
    if (!draft.candidate) throw generatorError('GENERATOR_DRAFT_HAS_NO_CANDIDATE', draftId);
    const adapter = adapters.get(draft.artifactType);
    const capabilityContext = capabilityCatalog.build();
    const checked = validateCandidate(adapter, draft.candidate, capabilityContext);
    return draftStore.update(draftId, {
      candidate: checked.candidate,
      validation: checked.validation,
      status: checked.validation.valid ? 'READY' : 'FAILED',
      errorCode: checked.validation.valid ? null : checked.validation.errors[0].code,
      error: checked.validation.valid ? null : checked.validation.errors[0].message,
      updatedAt: now(),
      terminalAt: now()
    });
  }

  function save(draftId) {
    const draft = getDraft(draftId);
    if (!draft) throw generatorError('GENERATOR_DRAFT_NOT_FOUND', draftId);
    if (draft.status !== 'READY' || !draft.candidate) throw generatorError('GENERATOR_DRAFT_NOT_READY', draftId);
    const adapter = adapters.get(draft.artifactType);
    const capabilityContext = capabilityCatalog.build();
    const checked = validateCandidate(adapter, draft.candidate, capabilityContext);
    if (!checked.validation.valid) {
      const failed = draftStore.update(draftId, {
        status: 'FAILED', validation: checked.validation,
        errorCode: checked.validation.errors[0].code,
        error: checked.validation.errors[0].message,
        updatedAt: now(), terminalAt: now()
      });
      recordAudit({
        generationId: draft.generationId, draftId, artifactType: draft.artifactType,
        intentHash: null, intentLength: 0, startedAt: Date.now()
      }, 'FAILED', failed);
      throw generatorError(checked.validation.errors[0].code, checked.validation.errors[0].message);
    }
    let saved;
    try {
      saved = adapter.save(checked.candidate, capabilityContext);
    } catch (error) {
      const failed = draftStore.update(draftId, {
        status: 'FAILED', errorCode: error.code || 'GENERATOR_SAVE_FAILED',
        error: String(error.message || error).slice(0, 1000), updatedAt: now(), terminalAt: now()
      });
      recordAudit({
        generationId: draft.generationId, draftId, artifactType: draft.artifactType,
        intentHash: null, intentLength: 0, startedAt: Date.now()
      }, 'FAILED', failed);
      throw error;
    }
    const updated = draftStore.update(draftId, {
      status: 'SAVED', candidate: checked.candidate, validation: checked.validation,
      savedArtifactId: checked.candidate.id, updatedAt: now(), terminalAt: now()
    });
    const control = {
      generationId: draft.generationId, draftId, artifactType: draft.artifactType,
      intentHash: null, intentLength: 0, startedAt: Date.now()
    };
    recordAudit(control, 'SAVED', updated, { savedArtifactId: checked.candidate.id });
    return { draft: updated, artifact: saved };
  }

  function discard(draftId) {
    const draft = getDraft(draftId);
    if (!draft) throw generatorError('GENERATOR_DRAFT_NOT_FOUND', draftId);
    if (draft.status === 'SAVED') throw generatorError('GENERATOR_DRAFT_ALREADY_SAVED', draftId);
    const control = active.get(draftId);
    if (control) {
      control.cancelled = true;
      control.abortController.abort();
    }
    return draftStore.update(draftId, { status: 'DISCARDED', updatedAt: now(), terminalAt: now() });
  }

  function cancel(draftId) {
    const draft = getDraft(draftId);
    if (!draft) throw generatorError('GENERATOR_DRAFT_NOT_FOUND', draftId);
    if (GENERATION_TERMINAL.has(draft.status)) return draft;
    const control = active.get(draftId);
    if (control) {
      control.cancelled = true;
      control.abortController.abort();
    }
    const cancelled = draftStore.update(draftId, {
      status: 'CANCELLED', errorCode: 'GENERATOR_CANCELLED', error: 'generation cancelled',
      updatedAt: now(), terminalAt: now()
    });
    if (control) recordAudit(control, 'CANCELLED', cancelled);
    return cancelled;
  }

  return { generate, wait, getDraft, listDrafts, validate, save, discard, cancel, active, validateCandidate };
}

module.exports = {
  GENERATION_TERMINAL,
  MAX_REPAIRS,
  MAX_PROVIDER_ATTEMPTS,
  createMemoryDraftStore,
  createGeneratorService
};
