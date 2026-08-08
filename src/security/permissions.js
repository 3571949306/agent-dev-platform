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
  constructor() {
    /** @type {Map<string, string>} scope -> range */
    this.grants = new Map();
    this.projectGrants = new Map();
    this.taskId = null;
  }

  setTask(taskId) { this.taskId = taskId; }
  setProject(projectId) { this.projectId = projectId; }

  evaluate(scope, ctx = {}) {
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

  grant(scope, range) {
    if (!SCOPES.includes(scope)) return;
    if (range === 'once') this.grants.set(scope, 'once');
    else if (range === 'task') this.grants.set(scope, 'task');
    else if (range === 'project') { this.grants.set(scope, 'project'); this.projectGrants.set(scope, 'project'); }
    else if (range === 'always') this.grants.set(scope, 'always');
    else if (range === 'deny') this.grants.set(scope, 'deny');
  }

  listGrants() {
    return Array.from(this.grants.entries()).map(([scope, range]) => ({ scope, range }));
  }

  reset() {
    this.grants.clear();
    this.projectGrants.clear();
  }
}

module.exports = { PermissionEngine, SCOPES, DEFAULT_POLICY, DEFAULT_AGENT_PERMISSIONS };
