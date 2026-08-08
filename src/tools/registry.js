'use strict';
/**
 * Tool registry — aggregates all built-in tools into a name->definition map.
 * MCP tools and sub-agent tools are merged dynamically by the Agent Runtime.
 */
const fsTools = require('./filesystem').tools;
const searchTools = require('./search').tools;
const patchTools = require('./patch').tools;
const terminalTools = require('./terminal').tools;
const gitTools = require('./git').tools;
const checkpointTools = require('./checkpoint').tools;
const chatTools = require('./chats').tools;

const BUILTIN = [...fsTools, ...searchTools, ...patchTools, ...terminalTools, ...gitTools, ...checkpointTools, ...chatTools];

const registry = new Map();
for (const t of BUILTIN) {
  registry.set(t.name, {
    def: { name: t.name, description: t.description, input_schema: t.input_schema, source: 'builtin', risk_level: t.risk_level },
    exec: t.exec,
    permission: t.permission,
    permissionFor: t.permissionFor,
    risk_level: t.risk_level
  });
}

function getBuiltin(name) { return registry.get(name); }
function listBuiltinDefs() { return [...registry.values()].map(r => r.def); }

module.exports = { BUILTIN, registry, getBuiltin, listBuiltinDefs };
