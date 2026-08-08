'use strict';
/**
 * Permission Engine — scopes, default policy, grant ranges, audit log.
 *
 * Decision levels: once | task | project | always | deny
 * Evaluate returns: 'allow' | 'ask' | 'deny'
 */

const SCOPES = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.delete',
  'filesystem.outside_workspace',
  'terminal.read',
  'terminal.write',
  'terminal.dangerous',
  'terminal.admin',
  'git.read',
  'git.write',
  'network',
  'browser',
  'computer',
  'clipboard',
  'mcp',
  'subagent'
];

// Default policy (spec §81)
const DEFAULT_POLICY = {
  filesystem: 'ask',      // delete / outside workspace handled separately
  'filesystem.read': 'allow',
  'filesystem.write': 'allow',
  'filesystem.delete': 'ask',
  'filesystem.outside_workspace': 'ask',
  'terminal.read': 'allow',
  'terminal.write': 'allow',
  'terminal.dangerous': 'ask',
  'terminal.admin': 'ask',
  'git.read': 'allow',
  'git.write': 'ask',
  'network': 'allow',
  'browser': 'ask',
  'computer': 'ask',
  'clipboard': 'ask',
  'mcp': 'allow',
  'subagent': 'allow'
};

const DEFAULT_AGENT_PERMISSIONS = [
  'filesystem.read',
  'filesystem.write',
  'terminal.read',
  'terminal.write',
  'git.read',
  'network',
  'mcp',
  'subagent'
];

class PermissionEngine {
  /**
   * @param opts.store        optional store; when given, `project`/`always`/`deny`
   *                          grants survive an app restart (spec §41).
   * @param opts.projectId    current project, used to scope `project` grants.
   * @param opts.parent       parent engine. A child (sub-agent) can never be more
   *                          privileged than its parent — see `evaluate`.
   */
  constructor(opts = {}) {
    /** @type {Map<string, string>} scope -> range */
    this.grants = new Map();
    this.projectGrants = new Map();
    this.taskId = null;
    this.store = opts.store || null;
    this.projectId = opts.projectId || null;
    this.parent = opts.parent || null;
    if (this.store) this.loadPersisted();
  }

  /** Re-hydrate project/always/deny grants saved in SQLite. */
  loadPersisted() {
    if (!this.store || !this.store.permissionGrants) return;
    let rows = [];
    try { rows = this.store.permissionGrants.list(this.projectId); } catch { return; }
    for (const g of rows) {
      if (g.range === 'project') {
        if (g.project_id && this.projectId && g.project_id !== this.projectId) continue;
        this.grants.set(g.scope, 'project');
        this.projectGrants.set(g.scope, 'project');
      } else if (g.range === 'always' || g.range === 'deny') {
        this.grants.set(g.scope, g.range);
      }
    }
  }

  setTask(taskId) { this.taskId = taskId; }
  setProject(projectId) {
    const changed = this.projectId !== projectId;
    this.projectId = projectId;
    if (changed && this.store) this.loadPersisted();
  }

  /** Verdict from this engine alone, ignoring any parent. */
  evaluateLocal(scope, ctx = {}) {
    if (!SCOPES.includes(scope)) {
      // Unknown scope → ask by default (fail safe)
      return 'ask';
    }
    const grant = this.grants.get(scope);
    if (grant === 'deny') return 'deny';
    if (grant === 'always') return 'allow';
    if (grant === 'project' && (ctx.projectId === this.projectId || ctx.projectId)) {
      // project-level grant applies to whole project session
      if (this.projectGrants.get(scope) === 'project') return 'allow';
    }
    if (grant === 'task' && ctx.taskId && ctx.taskId === this.taskId) return 'allow';
    if (grant === 'once') {
      // once grant is consumed after this evaluation
      this.grants.delete(scope);
      return 'allow';
    }
    const def = DEFAULT_POLICY[scope] || 'ask';
    return def;
  }

  /**
   * A sub-agent must not be able to do something its parent was denied, and it
   * must not silently skip a prompt the parent would have shown. So the final
   * verdict is the STRICTER of (child, parent).
   */
  evaluate(scope, ctx = {}) {
    const mine = this.evaluateLocal(scope, ctx);
    if (!this.parent) return mine;
    const theirs = this.parent.evaluate(scope, ctx);
    return strictest(mine, theirs);
  }

  /**
   * @param opts.persist  set false for grants that must stay in memory (sub-agent
   *                      session grants must never end up in the user's saved policy).
   */
  grant(scope, range, opts = {}) {
    if (!SCOPES.includes(scope)) return;
    if (range === 'once') this.grants.set(scope, 'once');
    else if (range === 'task') this.grants.set(scope, 'task');
    else if (range === 'project') { this.grants.set(scope, 'project'); this.projectGrants.set(scope, 'project'); }
    else if (range === 'always') this.grants.set(scope, 'always');
    else if (range === 'deny') this.grants.set(scope, 'deny');
    // persist the decisions the user expects to outlive the session
    const persist = opts.persist !== false;
    if (persist && this.store && this.store.permissionGrants && (range === 'project' || range === 'always' || range === 'deny')) {
      try { this.store.permissionGrants.save({ scope, range, projectId: this.projectId }); } catch { /* non-fatal */ }
    }
  }

  /** In-memory grant for a delegated session; never written to SQLite. */
  grantSession(scope) { this.grant(scope, 'always', { persist: false }); }

  listGrants() {
    return Array.from(this.grants.entries()).map(([scope, range]) => ({ scope, range }));
  }

  reset() {
    this.grants.clear();
    this.projectGrants.clear();
  }
}

const RANK = { allow: 0, ask: 1, deny: 2 };
function strictest(a, b) { return RANK[a] >= RANK[b] ? a : b; }

module.exports = { PermissionEngine, SCOPES, DEFAULT_POLICY, DEFAULT_AGENT_PERMISSIONS, strictest };
