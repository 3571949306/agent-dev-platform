'use strict';

const { normalizeWorkflowDefinition } = require('./workflowDefinition');

function registryError(code, message) {
  const error = new Error(code + ': ' + message);
  error.code = code;
  return error;
}

function createWorkflowRegistry({ store } = {}) {
  const memory = new Map();
  function get(id) {
    if (store && typeof store.get === 'function') return store.get(id) || null;
    return memory.get(id) || null;
  }
  function list() {
    const values = store && typeof store.list === 'function' ? store.list() : [...memory.values()];
    return values.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  function create(input) {
    const definition = normalizeWorkflowDefinition(input);
    if (get(definition.id)) throw registryError('WORKFLOW_ALREADY_EXISTS', "workflow '" + definition.id + "' already exists");
    if (store) return store.create(definition);
    const record = { ...definition, enabled: true };
    memory.set(definition.id, record);
    return record;
  }
  function update(id, patch) {
    const current = get(id);
    if (!current) throw registryError('WORKFLOW_NOT_FOUND', "workflow '" + id + "' not found");
    const { enabled: _enabled, ...persisted } = current;
    const definition = normalizeWorkflowDefinition({ ...persisted, ...(patch || {}), id });
    if (store) return store.update(id, definition);
    const record = { ...definition, enabled: current.enabled !== false };
    memory.set(id, record);
    return record;
  }
  function remove(id) {
    if (!get(id)) throw registryError('WORKFLOW_NOT_FOUND', "workflow '" + id + "' not found");
    if (store) return store.remove(id);
    return memory.delete(id);
  }
  function setEnabled(id, enabled) {
    const current = get(id);
    if (!current) throw registryError('WORKFLOW_NOT_FOUND', "workflow '" + id + "' not found");
    if (store) return store.setEnabled(id, enabled);
    const record = { ...current, enabled: !!enabled };
    memory.set(id, record);
    return record;
  }
  return {
    create,
    get,
    list,
    update,
    remove,
    delete: remove,
    enable: id => setEnabled(id, true),
    disable: id => setEnabled(id, false)
  };
}

module.exports = { createWorkflowRegistry };
