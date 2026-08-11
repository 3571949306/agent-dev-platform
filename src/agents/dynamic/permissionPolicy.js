'use strict';

const MUTATION_SCOPES = new Set([
  'filesystem.write', 'filesystem.delete', 'filesystem.outside_workspace',
  'terminal.write', 'terminal.dangerous', 'terminal.admin', 'git.write',
  'computer', 'clipboard'
]);

class DynamicPermissionEngine {
  constructor({ policy, parent } = {}) {
    this.policy = policy || { readOnly: false, allow: [], deny: [] };
    this.parent = parent || null;
  }

  evaluate(scope, ctx = {}) {
    if (this.policy.readOnly && MUTATION_SCOPES.has(scope)) return 'deny';
    if ((this.policy.deny || []).includes(scope)) return 'deny';
    const parentVerdict = this.parent && typeof this.parent.evaluate === 'function'
      ? this.parent.evaluate(scope, ctx)
      : 'allow';
    if (parentVerdict !== 'allow') return parentVerdict;
    const allow = this.policy.allow || [];
    if (allow.length && !allow.includes(scope)) return 'deny';
    return 'allow';
  }
}

module.exports = { DynamicPermissionEngine, MUTATION_SCOPES };
