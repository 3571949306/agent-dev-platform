'use strict';

const HOOK_HANDLER_NOT_FOUND = 'HOOK_HANDLER_NOT_FOUND';

function handlerError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function createHookHandlerRegistry() {
  const handlers = new Map();

  function register(id, handler) {
    if (typeof id !== 'string' || !id.trim() || typeof handler !== 'function') {
      throw new TypeError('trusted hook registration requires a non-empty id and function');
    }
    handlers.set(id.trim(), handler);
    return id.trim();
  }

  function unregister(id) { return handlers.delete(id); }
  function get(id) { return handlers.get(id) || null; }
  function requireHandler(id) {
    const handler = get(id);
    if (!handler) throw handlerError(HOOK_HANDLER_NOT_FOUND, `trusted handler '${id}' is not registered`);
    return handler;
  }
  function list() { return [...handlers.keys()].sort(); }

  return { register, unregister, get, require: requireHandler, list, has: id => handlers.has(id) };
}

module.exports = { HOOK_HANDLER_NOT_FOUND, createHookHandlerRegistry, handlerError };
