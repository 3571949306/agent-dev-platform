'use strict';

const { normalizeHookDefinition } = require('./hookDefinition');

const HOOK_ALREADY_EXISTS = 'HOOK_ALREADY_EXISTS';
const HOOK_NOT_FOUND = 'HOOK_NOT_FOUND';

function registryError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function createHookRegistry({ store } = {}) {
  function create(input) {
    const definition = normalizeHookDefinition(input);
    if (get(definition.id)) throw registryError(HOOK_ALREADY_EXISTS, `hook '${definition.id}' already exists`);
    return store ? store.create(definition) : { ...definition, enabled: true };
  }

  function get(id) {
    return store && typeof store.get === 'function' ? (store.get(id) || null) : null;
  }

  function list() {
    return store && typeof store.list === 'function'
      ? store.list().sort((a, b) => String(a.id).localeCompare(String(b.id)))
      : [];
  }

  function update(id, patch) {
    const current = get(id);
    if (!current) throw registryError(HOOK_NOT_FOUND, `hook '${id}' not found`);
    const { enabled: _enabled, source: _source, ...persisted } = current;
    const definition = normalizeHookDefinition({ ...persisted, ...(patch || {}), id });
    return store.update(id, definition);
  }

  function remove(id) {
    if (!get(id)) throw registryError(HOOK_NOT_FOUND, `hook '${id}' not found`);
    return store.remove(id);
  }

  function setEnabled(id, enabled) {
    if (!get(id)) throw registryError(HOOK_NOT_FOUND, `hook '${id}' not found`);
    return store.setEnabled(id, enabled);
  }

  return {
    create,
    register: create,
    get,
    list,
    update,
    remove,
    delete: remove,
    enable: id => setEnabled(id, true),
    disable: id => setEnabled(id, false),
    has: id => get(id) !== null
  };
}

module.exports = { HOOK_ALREADY_EXISTS, HOOK_NOT_FOUND, createHookRegistry };
