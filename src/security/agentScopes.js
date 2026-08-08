'use strict';
/**
 * Which permission scopes a delegated agent actually needs.
 *
 * P0-2: before v2.2.0 the Main → SubAgent → External Agent path bypassed the
 * permission engine completely. An external adapter could drive the user's
 * desktop, run a CLI or hit the network without a single prompt, because the
 * gate only existed for built-in tools.
 *
 * This module is intentionally dependency-free so both the Agent Runtime and
 * the external adapter layer can use the exact same answer — a scope list
 * computed in two places is a scope list that will disagree.
 */

const SUBAGENT_SCOPE = 'subagent';

/** Normalise the adapter kind across the shapes used in the codebase/tests. */
function adapterKind(adapter) {
  if (!adapter) return '';
  return String(adapter.adapter_type || adapter.adapterType || adapter.kind || '').toLowerCase();
}

/**
 * Scopes required to run an external agent adapter.
 * Always includes `subagent`; the rest depends on what the adapter really does.
 *
 * @returns {string[]} de-duplicated scope list, ordered
 */
function externalAgentScopes(adapter) {
  const cfg = (adapter && adapter.config) || {};
  const kind = adapterKind(adapter);
  const scopes = [SUBAGENT_SCOPE];

  if (kind === 'workbuddy') {
    // Drives a real window: moves focus, types, and pastes via the clipboard.
    scopes.push('computer', 'clipboard');
  } else if (kind === 'codex') {
    // The CLI spawns a process that reads and writes the project.
    if (cfg.cliPath) scopes.push('terminal.write', 'filesystem.read', 'filesystem.write');
    // The API mode talks to a remote endpoint.
    if (cfg.connectionId) scopes.push('network');
    // Nothing configured yet — the adapter will fail anyway, but keep the
    // strictest of the two so a later config change cannot sneak through.
    if (!cfg.cliPath && !cfg.connectionId) scopes.push('terminal.write', 'network');
  } else if (kind === 'http') {
    scopes.push('network');
  } else {
    // Unknown adapter: assume the worst rather than waving it through.
    scopes.push('network');
  }

  return Array.from(new Set(scopes));
}

/**
 * Scopes required to invoke a sub-agent tool (`agent_<id>`).
 * Local sub-agents only need `subagent`; external ones add their adapter scopes.
 */
function subAgentScopes(subDef) {
  if (subDef && subDef.type === 'external') return externalAgentScopes(subDef);
  return [SUBAGENT_SCOPE];
}

/**
 * Evaluate a scope list against a permission engine, asking the user when needed.
 *
 * @param engine  PermissionEngine
 * @param scopes  string[]
 * @param ctx     { taskId, projectId }
 * @param ask     async ({scope}) => { decision, range } | null when non-interactive
 * @returns {Promise<{ok:true}|{ok:false,scope:string,reason:'deny'|'user_denied'}>}
 */
async function ensureScopes(engine, scopes, ctx = {}, ask = null) {
  if (!engine) return { ok: true };
  for (const scope of scopes) {
    const verdict = engine.evaluate(scope, ctx);
    if (verdict === 'allow') continue;
    if (verdict === 'deny') return { ok: false, scope, reason: 'deny' };
    // 'ask'
    if (!ask) return { ok: false, scope, reason: 'deny' };
    const decision = await ask({ scope });
    if (!decision || decision.decision === 'deny') return { ok: false, scope, reason: 'user_denied' };
    engine.grant(scope, decision.range || 'once');
  }
  return { ok: true };
}

module.exports = { SUBAGENT_SCOPE, adapterKind, externalAgentScopes, subAgentScopes, ensureScopes };
