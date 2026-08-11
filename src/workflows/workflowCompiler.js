'use strict';

const { normalizeWorkflowDefinition } = require('./workflowDefinition');

function compileWorkflow(input) {
  const definition = normalizeWorkflowDefinition(input);
  const byId = new Map(definition.steps.map(step => [step.id, step]));
  const levels = new Map();
  function levelOf(id) {
    if (levels.has(id)) return levels.get(id);
    const step = byId.get(id);
    const level = step.dependsOn.length
      ? Math.max(...step.dependsOn.map(levelOf)) + 1
      : 0;
    levels.set(id, level);
    return level;
  }
  const steps = definition.steps
    .map(step => ({ ...step, level: levelOf(step.id) }))
    .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    workflowId: definition.id,
    definition,
    steps,
    order: steps.map(step => step.id)
  };
}

module.exports = { compileWorkflow };
