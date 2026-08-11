'use strict';
/**
 * v2.9.3 Skill Engine — R2 SkillRegistry + Persistence.
 *
 * Registry boundary:
 *   Persistent SkillDefinition (store.skillDefinitions / skill_definitions table)
 *     ↓
 *   SkillRegistry (register / unregister / get / list / enable / disable)
 *     ↓
 *   Resolved runtime representation (SkillResolver → ResolvedSkillSet)
 *
 * Runtime objects (activeSkillRuntime / ModelAdapter / PermissionEngine) are
 * NEVER persisted and never stored here.
 *
 * Built-in skills are seeded on first access and are immutable (update/delete
 * rejected with SKILL_BUILTIN); enable/disable still works for them.
 */

const { normalizeSkillDefinition } = require('./skillDefinition');

const ERROR_CODE = 'SKILL_REGISTRY';
const SKILL_ALREADY_EXISTS = 'SKILL_ALREADY_EXISTS';
const SKILL_NOT_FOUND = 'SKILL_NOT_FOUND';
const SKILL_BUILTIN = 'SKILL_BUILTIN';

function regError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function createSkillRegistry({ store, builtins = [] } = {}) {
  let seeded = false;

  function ensureBuiltins() {
    if (seeded) return;
    seeded = true;
    if (!store || typeof store.get !== 'function') return;
    for (const definition of builtins) {
      if (store.get(definition.id)) continue;
      try { store.create({ ...definition, metadata: { ...(definition.metadata || {}), source: 'builtin' } }); } catch { /* best effort */ }
    }
  }

  function register(input) {
    const definition = normalizeSkillDefinition(input);
    if (store && typeof store.get === 'function') {
      if (store.get(definition.id)) throw regError(SKILL_ALREADY_EXISTS, `skill '${definition.id}' already exists`);
      return store.create(definition);
    }
    return { ...definition, enabled: true, source: 'user' };
  }

  function unregister(id) {
    const record = get(id);
    if (!record) throw regError(SKILL_NOT_FOUND, `skill '${id}' not found`);
    if (record.source === 'builtin' || (record.metadata && record.metadata.source === 'builtin')) {
      throw regError(SKILL_BUILTIN, `built-in skill '${id}' cannot be deleted`);
    }
    if (!store || typeof store.remove !== 'function') return true;
    return store.remove(id);
  }

  function get(id) {
    ensureBuiltins();
    if (!store || typeof store.get !== 'function') return null;
    return store.get(id) || null;
  }

  function list() {
    ensureBuiltins();
    if (!store || typeof store.list !== 'function') return [];
    return store.list().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  function enable(id) {
    if (!store || typeof store.setEnabled !== 'function') return null;
    const record = store.setEnabled(id, true);
    if (!record) throw regError(SKILL_NOT_FOUND, `skill '${id}' not found`);
    return record;
  }

  function disable(id) {
    if (!store || typeof store.setEnabled !== 'function') return null;
    const record = store.setEnabled(id, false);
    if (!record) throw regError(SKILL_NOT_FOUND, `skill '${id}' not found`);
    return record;
  }

  function create(input) {
    return register(input);
  }

  function update(id, patch) {
    const record = get(id);
    if (!record) throw regError(SKILL_NOT_FOUND, `skill '${id}' not found`);
    if (record.source === 'builtin' || (record.metadata && record.metadata.source === 'builtin')) {
      throw regError(SKILL_BUILTIN, `built-in skill '${id}' cannot be modified`);
    }
    if (!store || typeof store.update !== 'function') return null;
    return store.update(id, patch);
  }

  function remove(id) {
    return unregister(id);
  }

  function has(id) {
    return get(id) !== null;
  }

  return {
    register, unregister, create, update, remove,
    get, list, enable, disable, has
  };
}

module.exports = {
  ERROR_CODE, SKILL_ALREADY_EXISTS, SKILL_NOT_FOUND, SKILL_BUILTIN,
  createSkillRegistry
};
