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
 * R3 — compatibility is REAL, not metadata. Every requested skill is checked against
 *   agentContext.agentType, projectContext.platform, projectContext.signals:
 *     - required skill incompatible → SKILL_INCOMPATIBLE (fail closed)
 *     - optional skill incompatible → skipped (SKILL_OPTIONAL_SKIPPED_INCOMPATIBLE)
 *
 * R4 — a Skill can only REQUIRE capabilities, never GRANT them:
 *   - required tool not available / outside agent tool policy → SKILL_REQUIRED_TOOL_UNAVAILABLE
 *   - required permission not already held → SKILL_REQUIRED_PERMISSION_UNAVAILABLE
 *   - Skill A denies + Skill B requires the same tool → SKILL_CONFLICT (fail closed)
 *   - disabled Skill explicitly requested → SKILL_DISABLED
 *   - unknown Skill ID → SKILL_UNKNOWN
 *
 * resolveWithOptions({ requiredSkillIds, optionalSkillIds, agentContext, projectContext })
 *   applies R3/R4 to required skills (fail closed) and optional skills (skip on failure),
 *   then re-resolves the combined final set ONCE so cross-skill conflicts and model
 *   merges are re-verified over the whole set (optional skills are never silently lost).
 *
 * This resolver performs 0 provider calls by construction.
 */

const fs = require('fs');
const path = require('path');
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
const SKILL_INCOMPATIBLE = 'SKILL_INCOMPATIBLE';
const SKILL_OPTIONAL_SKIPPED_INCOMPATIBLE = 'SKILL_OPTIONAL_SKIPPED_INCOMPATIBLE';

/* ------------------------------------------------------------------ */
/* R3 — platform / agent-type / project-signal compatibility helpers  */
/* ------------------------------------------------------------------ */

/** Normalize process.platform ('win32'/'darwin'/'linux') to the canonical skill
 *  compatibility token ('windows'/'darwin'/'linux'). Already-canonical values pass through. */
function normalizePlatform(value) {
  if (value === 'win32') return 'windows';
  if (value === 'darwin') return 'darwin';
  if (value === 'linux') return 'linux';
  if (value === 'freebsd') return 'freebsd';
  return value;
}

/**
 * Compute the deterministic set of project signals for a project root.
 * Signals: 'file:<relativePath>', 'extension:<ext>', 'package:<name>'.
 * Bounded walk (depth 4, ≤ 8000 files) so production use stays cheap.
 */
function computeProjectSignals(projectRoot) {
  const signals = new Set();
  if (!projectRoot || typeof projectRoot !== 'string') return signals;
  let count = 0;
  const MAX = 8000;
  function walk(dir, depth) {
    if (depth > 4 || count > MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count > MAX) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
        walk(full, depth + 1);
      } else {
        count++;
        const rel = path.relative(projectRoot, full).split(path.sep).join('/');
        signals.add(`file:${rel}`);
        const ext = path.extname(entry.name).toLowerCase();
        if (ext) signals.add(`extension:${ext}`);
      }
    }
  }
  try { walk(projectRoot, 0); } catch { /* best effort */ }
  try {
    const pkgRaw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw);
    if (pkg && typeof pkg.name === 'string' && pkg.name) signals.add(`package:${pkg.name}`);
  } catch { /* no package.json */ }
  return signals;
}

/**
 * At least one of the required signals must be present in the project.
 * projectContext.signals (precomputed array) takes precedence (test-friendly &
 * deterministic); otherwise signals are computed from projectContext.projectRoot.
 */
function projectSignalsMatch(required, projectContext) {
  if (!required || !required.length) return true;
  let present;
  if (projectContext && Array.isArray(projectContext.signals)) {
    present = new Set(projectContext.signals);
  } else {
    present = computeProjectSignals(projectContext && projectContext.projectRoot);
  }
  return required.some(req => present.has(req));
}

/**
 * Evaluate a skill's compatibility against the resolve inputs.
 * Returns { ok:true } or { ok:false, field, value, allowed }.
 * Semantics (deterministic):
 *   - agentTypes  non-empty → agentContext.agentType must be included (default 'native')
 *   - platforms   non-empty → resolved platform must be included
 *   - projectSignals non-empty → at least one signal must match the project
 */
function checkCompatibility(skill, agentContext, projectContext) {
  const compat = skill.compatibility || {};
  const agentTypes = compat.agentTypes || [];
  if (agentTypes.length) {
    const agentType = (agentContext && agentContext.agentType) ? agentContext.agentType : 'native';
    if (!agentTypes.includes(agentType)) {
      return { ok: false, field: 'agentType', value: agentType, allowed: agentTypes };
    }
  }
  const platforms = compat.platforms || [];
  if (platforms.length) {
    const platform = normalizePlatform((projectContext && projectContext.platform) || process.platform);
    if (!platforms.includes(platform)) {
      return { ok: false, field: 'platform', value: platform, allowed: platforms };
    }
  }
  const signals = compat.projectSignals || [];
  if (signals.length) {
    if (!projectSignalsMatch(signals, projectContext)) {
      return { ok: false, field: 'projectSignal', value: signals, allowed: [] };
    }
  }
  return { ok: true };
}

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

    // R3 — compatibility is REAL (not metadata). A required skill that is
    // incompatible with the agent type / platform / project fails closed.
    for (const record of order) {
      const compat = checkCompatibility(record, agentContext, projectContext);
      if (!compat.ok) {
        return failed(SKILL_INCOMPATIBLE, `skill '${record.id}' is incompatible (${compat.field}=${JSON.stringify(compat.value)} not in ${JSON.stringify(compat.allowed)})`, [
          { code: SKILL_INCOMPATIBLE, skillId: record.id, field: compat.field, value: compat.value, allowed: compat.allowed }
        ]);
      }
    }

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

  /**
   * R4A — resolve required + optional skills into ONE effective set.
   *
   *   - required skills are resolved with full R3/R4 validation (incompatible /
   *     unknown / disabled / tool / permission / conflict → fail closed).
   *   - each optional skill is evaluated individually; ANY failure (incompatible,
   *     unknown, disabled, tool, permission, conflict) is SKIPPED — never fatal —
   *     and recorded in `skipped`.
   *   - the FINAL set = resolved required + resolved compatible optional is then
   *     re-resolved ONCE so cross-skill deny/require conflicts, tool/permission
   *     ceilings and model merges are re-verified over the whole set. A resolved
   *     optional skill that produces a security conflict only AFTER entering the
   *     final set fails closed (it is never silently dropped).
   *
   * Returns the same ResolvedSkillSet shape as resolve(), plus `skipped` (array of
   * { id, code, reason } describing every optional skill that was skipped).
   */
  function resolveWithOptions({ requiredSkillIds = [], optionalSkillIds = [], agentContext = {}, projectContext = null } = {}) {
    const skipped = [];
    for (const id of optionalSkillIds) {
      const single = resolve({ requestedSkillIds: [id], agentContext, projectContext });
      if (!single.ok) skipped.push({ id, code: single.errorCode, reason: single.error });
    }
    const keptOptional = optionalSkillIds.filter(id => !skipped.some(s => s.id === id));
    const finalIds = [...requiredSkillIds, ...keptOptional];
    const finalRes = resolve({ requestedSkillIds: finalIds, agentContext, projectContext });
    if (!finalRes.ok) {
      finalRes.reasons = [...(finalRes.reasons || []), { code: 'SKILL_OPTIONAL_SKIPPED', skipped }];
      finalRes.skipped = skipped;
      return finalRes; // ok:false — propagate SKILL_* (fail closed)
    }
    finalRes.reasons.push({ code: 'SKILL_OPTIONAL_SKIPPED', skipped });
    finalRes.skipped = skipped;
    return finalRes;
  }

  return { resolve, resolveModelMerge, resolveWithOptions };
}

module.exports = {
  ERROR_CODE, SKILL_UNKNOWN, SKILL_DISABLED, SKILL_DEPENDENCY_CYCLE, SKILL_CONFLICT,
  SKILL_REQUIRED_TOOL_UNAVAILABLE, SKILL_REQUIRED_PERMISSION_UNAVAILABLE,
  SKILL_MODEL_REQUIREMENTS_CONFLICT, SKILL_INCOMPATIBLE, SKILL_OPTIONAL_SKIPPED_INCOMPATIBLE,
  normalizePlatform, checkCompatibility,
  createSkillResolver
};
