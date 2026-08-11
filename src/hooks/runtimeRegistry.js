'use strict';

let engine = null;

function setHookRuntime(nextEngine) { engine = nextEngine || null; }
function getHookRuntime() { return engine; }

module.exports = { setHookRuntime, getHookRuntime };
