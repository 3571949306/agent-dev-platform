'use strict';
/**
 * v2.9.3 Skill Engine — R3 SkillResolver / R4 Tool & Permission Ceiling.
 *
 * resolve({ requestedSkillIds, agentContext, projectContext }) → ResolvedSkillSet
 *   {
 *     ok, errorCode?, reason?,
 *     skills, instructions, requiredTools, optionalTools, deniedTools,
 *     requiredPermissions, modelRequirements, reasons
 *   }
 *
 * Determinism: identical input resolved 100x yields identical output; shuffled
 * requestedSkillIds still produce the same ordered result (dedupe → sort by id →
 * transitive requiresSkills in sorted order, cycle detection).
 *
 * R4 — a Skill can only REQUIRE capabilities, never GRANT them:
 *   - required tool not available / outside agent tool policy → SKILL_REQUIRED_TOOL_UNAVAILABLE
 *   - required permission not already held → SKILL_REQUIRED_PERMISSION_UNAVAILABLE
 *   - Skill A denies + Skill B requires the same tool → SKILL_CONFLICT (fail closed)
 *   - disabled Skill explicitly requested → SKILL_DISABLED
 *   - unknown Skill ID → SKILL_UNKNOWN
 *
 * This resolver performs 0 provider calls by construction.
 */

const { expandToolNames } = require('./skillDefinition');
const { mergeModelRequirements } = require('./modelMerge');
const { MUTATION_SCOPES } = require('../agents/dynamic/permissionPolicy');

const ERROR_CODE = 'SKILL_RESOLVER';
const SKILL_UNKNOWN = 'SKILL_UNKNOWN';
const SKILL_DISABLED = 'SKILL_DISABLED';
const SKILL_DEPENDENCY_CYCLE = 'SKILL_DEPENDENCY_CYCLE';
const SKILL_CONFLICT = 'SKILL_CONFLICT';
const SKILL_REQUIRED_TOOL_UNAVAILABLE = 'SKILL_REQUIRED_TOOL_UNAVAILABLE';
const SKILL_REQUIRED_PERMISSION_UNAVAILABLE = 'SKILL_REQUIRED_PERMISSION_UNAVAILABLE';
const SKILL_MODEL_REQUIREMENTS_CONFLICT = 'SKILL_MODEL_REQUIREMENTS_CONFLICT';

function resolveError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function failed(code, message, reasons) {
  return { ok: false, errorCode: code, error: message, reasons: reasons || [] };
}

function isBuiltinSource(record) {
  return record && (record.source === 'builtin' || (record.metadata && record.metadata.source === 'builtin'));
}

function createSkillResolver({ registry } = {}) {
  if (!registry || typeof registry.get !== 'function') {
    throw new Error('SKILL_RESOLVER_REGISTRY_REQUIRED');
  }

  /** Load + expand requested ids to an ordered, deduped skill list (deterministic). */
  function collect(requestedSkillIds) {
    const roots = [...new Set((requestedSkillIds || []).map(id => String(id).trim()).filter(Boolean))].sort();
    const reasons = [];
    const visited = new Set();
    const order = [];
    const stack = [];

    function visit(id) {
      if (visited.has(id)) return;
      if (stack.includes(id)) throw resolveError(SKILL_DEPENDENCY_CYCLE, `skill dependency cycle: ${[...stack, id].join(' → ')}`);
      const record = registry.get(id);
      if (!record) throw resolveError(SKILL_UNKNOWN, `skill '${id}' not found`);
      if (!record.enabled) throw resolveError(SKILL_DISABLED, `skill '${id}' is disabled`);
      stack.push(id);
      const deps = (record.requiresSkills || []).slice().sort();
      for (const dep of deps) visit(dep);
      stack.pop();
      visited.add(id);
      order.push(record);
    }

    for (const id of roots) visit(id);
    return { order, reasons };
  }

  /**
   * Full resolution with R4 agent-context validation.
   * @param {object} input
   *   { requestedSkillIds: string[],
   *     agentContext: {
   *       toolPolicy: { allow: string[], deny: string[] },
   *       permissionPolicy: { readOnly: boolean, allow: string[], deny: string[] },
   *       permissionCheck?: (scope: string) => boolean,   // e.g. PermissionEngine.evaluate()==='allow'
   *       availableTools?: string[]                       // platform tool availability
   *     },
   *     projectContext?: object }
   */
  function resolve({ requestedSkillIds = [], agentContext = {}, projectContext = null } = {}) {
    const reasons = [];
    let order;
    try {
      const collected = collect(requestedSkillIds);
      order = collected.order;
    } catch (error) {
      return failed(error.code, error.message, reasons);
    }
    if (!order.length) {
      return { ok: true, skills: [], instructions: [], requiredTools: [], optionalTools: [], deniedTools: [], requiredPermissions: [], modelRequirements: null, reasons: [{ code: 'SKILL_NONE_REQUESTED' }] };
    }

    // R5 stable order: the final set is always sorted by skillId, regardless of
    // requested order or requiresSkills traversal order (deterministic).
    order = [...order].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const toolPolicy = agentContext.toolPolicy || {};
    const allowTools = new Set(expandToolNames(toolPolicy.allow || []));
    const denyTools = new Set(expandToolNames(toolPolicy.deny || []));
    const permissionPolicy = agentContext.permissionPolicy || {};
    const permissionCheck = typeof agentContext.permissionCheck === 'function' ? agentContext.permissionCheck : null;
    const availableTools = agentContext.availableTools === undefined
      ? null
      : new Set(expandToolNames(agentContext.availableTools));

    const skills = order.map(record => {
      const { enabled, source, ...definition } = record;
      void enabled; void source;
      return definition;
    });

    // Aggregate (union, sorted) — deterministic regardless of input order.
    const requiredTools = [...new Set(order.flatMap(s => expandToolNames(s.toolRequirements.required || [])))].sort();
    const optionalTools = [...new Set(order.flatMap(s => expandToolNames(s.toolRequirements.optional || [])))].sort();
    const deniedTools = [...new Set(order.flatMap(s => expandToolNames(s.toolRequirements.denied || [])))].sort();
    const requiredPermissions = [...new Set(order.flatMap(s => s.permissionRequirements.required || []))].sort();
    const instructions = order.map(s => ({ skillId: s.id, instructions: s.instructions }));

    // R4 cross-skill conflict: deny ∩ require on the same concrete tool → fail closed.
    const requiredSet = new Set(requiredTools);
    const conflictTools = deniedTools.filter(tool => requiredSet.has(tool));
    if (conflictTools.length) {
      const detail = conflictTools.join(', ');
      return failed(SKILL_CONFLICT, `skill requirements conflict on tool(s): ${detail}`, [
        { code: SKILL_CONFLICT, tools: conflictTools }
      ]);
    }

    // R4 required tools: must be inside agent tool policy AND platform availability.
    for (const tool of requiredTools) {
      if (allowTools.size && !allowTools.has(tool)) {
        return failed(SKILL_REQUIRED_TOOL_UNAVAILABLE, `skill requires tool '${tool}' which is outside the agent tool policy`, [
          { code: SKILL_REQUIRED_TOOL_UNAVAILABLE, tool }
        ]);
      }
      if (denyTools.has(tool)) {
        return failed(SKILL_REQUIRED_TOOL_UNAVAILABLE, `skill requires tool '${tool}' which is denied by the agent tool policy`, [
          { code: SKILL_REQUIRED_TOOL_UNAVAILABLE, tool }
        ]);
      }
      if (availableTools && !availableTools.has(tool)) {
        return failed(SKILL_REQUIRED_TOOL_UNAVAILABLE, `skill requires tool '${tool}' which is unavailable on the platform`, [
          { code: SKILL_REQUIRED_TOOL_UNAVAILABLE, tool }
        ]);
      }
    }

    // R4 required permissions: the agent must ALREADY hold them; skill cannot grant.
    const readOnly = permissionPolicy.readOnly === true;
    const allowScopes = permissionPolicy.allow || [];
    const denyScopes = permissionPolicy.deny || [];
    for (const scope of requiredPermissions) {
      if (readOnly && MUTATION_SCOPES.has(scope)) {
        return failed(SKILL_REQUIRED_PERMISSION_UNAVAILABLE, `skill requires permission '${scope}' but the agent is read-only`, [
          { code: SKILL_REQUIRED_PERMISSION_UNAVAILABLE, scope }
        ]);
      }
      if (denyScopes.includes(scope)) {
        return failed(SKILL_REQUIRED_PERMISSION_UNAVAILABLE, `skill requires permission '${scope}' which is denied for the agent`, [
          { code: SKILL_REQUIRED_PERMISSION_UNAVAILABLE, scope }
        ]);
      }
      if (allowScopes.length && !allowScopes.includes(scope)) {
        return failed(SKILL_REQUIRED_PERMISSION_UNAVAILABLE, `skill requires permission '${scope}' which is outside the agent permission allow-list`, [
          { code: SKILL_REQUIRED_PERMISSION_UNAVAILABLE, scope }
        ]);
      }
      if (permissionCheck && !permissionCheck(scope)) {
        return failed(SKILL_REQUIRED_PERMISSION_UNAVAILABLE, `skill requires permission '${scope}' which is not currently granted to the agent`, [
          { code: SKILL_REQUIRED_PERMISSION_UNAVAILABLE, scope }
        ]);
      }
    }

    // R6 merge: agent requirements first, then each skill (sorted) — strict merge.
    let modelRequirements;
    try {
      modelRequirements = mergeModelRequirements(
        agentContext.modelRequirements || {},
        ...order.map(s => s.modelRequirements)
      );
    } catch (error) {
      return failed(error.code || SKILL_MODEL_REQUIREMENTS_CONFLICT, error.message, [
        { code: SKILL_MODEL_REQUIREMENTS_CONFLICT, message: error.message }
      ]);
    }

    reasons.push({ code: 'SKILL_RESOLVED', count: order.length });
    reasons.push(...order.map(s => ({ code: 'SKILL_LOADED', skillId: s.id })));
    return {
      ok: true,
      skills,
      instructions,
      requiredTools,
      optionalTools,
      deniedTools,
      requiredPermissions,
      modelRequirements,
      reasons
    };
  }

  /**
   * Model-only merge (IPC routing path): no tool/permission validation, 0 provider calls.
   * Used to fold Skill ModelRequirements into Main Agent routing before the run starts;
   * the run itself performs the full R4 validation via resolve().
   */
  function resolveModelMerge(requestedSkillIds = [], agentModelRequirements = {}) {
    const reasons = [];
    let order;
    try {
      const collected = collect(requestedSkillIds);
      order = collected.order;
    } catch (error) {
      return { ok: false, errorCode: error.code, error: error.message, modelRequirements: null, reasons };
    }
    if (!order.length) {
      return { ok: true, modelRequirements: null, reasons: [{ code: 'SKILL_NONE_REQUESTED' }] };
    }
    try {
      const merged = mergeModelRequirements(agentModelRequirements, ...order.map(s => s.modelRequirements));
      return { ok: true, modelRequirements: merged, reasons: [{ code: 'SKILL_MODEL_MERGED', count: order.length }] };
    } catch (error) {
      return { ok: false, errorCode: error.code || SKILL_MODEL_REQUIREMENTS_CONFLICT, error: error.message, modelRequirements: null, reasons };
    }
  }

  return { resolve, resolveModelMerge };
}

module.exports = {
  ERROR_CODE, SKILL_UNKNOWN, SKILL_DISABLED, SKILL_DEPENDENCY_CYCLE, SKILL_CONFLICT,
  SKILL_REQUIRED_TOOL_UNAVAILABLE, SKILL_REQUIRED_PERMISSION_UNAVAILABLE,
  SKILL_MODEL_REQUIREMENTS_CONFLICT,
  createSkillResolver
};
