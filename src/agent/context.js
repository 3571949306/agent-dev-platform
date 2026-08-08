'use strict';
/**
 * Context building helpers: assemble the tool-definition list for an agent
 * (built-in + MCP + sub-agent tools), and a lightweight context summarizer.
 */
const registry = require('../tools/registry');

/**
 * @param agent agent record (has tools[], sub_agent_ids[])
 * @param opts { mcpDefs: [{name,description,input_schema}], subAgents: [{id,name,description}] }
 */
function buildToolDefs(agent, opts = {}) {
  const defs = [];
  const reg = registry.registry;
  for (const name of (agent.tools || [])) {
    const b = reg.get(name);
    if (b) defs.push({ name: b.def.name, description: b.def.description, parameters: b.def.input_schema });
  }
  for (const m of (opts.mcpDefs || [])) {
    defs.push({ name: m.name, description: m.description, parameters: m.input_schema || { type: 'object', properties: {} } });
  }
  for (const sub of (opts.subAgents || [])) {
    defs.push({
      name: 'agent_' + sub.id.replace(/-/g, '_'),
      description: `调用子 Agent「${sub.name}」：${sub.description || '专用 Agent'}。把要交给它处理的具体任务描述传给它，它会返回结构化结果。`,
      parameters: { type: 'object', properties: { task: { type: 'string', description: `交给「${sub.name}」的具体任务或问题` } }, required: ['task'] }
    });
  }
  return defs;
}

/** Map a sub-agent tool name back to its sub-agent id. */
function subAgentIdFromToolName(toolName) {
  if (!toolName.startsWith('agent_')) return null;
  return toolName.slice(6).replace(/_/g, '-');
}

module.exports = { buildToolDefs, subAgentIdFromToolName };
