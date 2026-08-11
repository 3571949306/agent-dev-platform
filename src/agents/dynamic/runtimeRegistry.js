'use strict';

let factory = null;
let definitionStore = null;

function setDynamicAgentRuntime(nextFactory, nextDefinitionStore) {
  factory = nextFactory || null;
  definitionStore = nextDefinitionStore || null;
}

function getDynamicAgentRuntime() {
  return { factory, definitionStore };
}

module.exports = { setDynamicAgentRuntime, getDynamicAgentRuntime };
