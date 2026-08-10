'use strict';
/**
 * v2.8.1 — 统一权限决策审计（spec §31/§32/§78）。
 *
 * 每次权限裁决（无论 GUI 确认还是 headless fail-closed）都在此登记：
 *   runId, agentId, risk, operation, decision, decisionSource, timestamp, command
 *
 * 安全（§78）：命令原文在落库/入内存前经过脱敏，命中凭据模式（token / key /
 * Bearer / AWS / Slack / PEM 私钥头等）的片段被替换为 [REDACTED]，防止凭据
 * 泄漏到审计流 / 日志 / GUI。
 *
 * 存储：内存环形缓冲（最近 500 条，便于运行时查询）+ 持久化到
 * `permission_decisions` 表（spec §81：优先简单，不为此新建复杂 DB）。
 */

const { permissionDecisions } = require('../db/store');

/** 匹配疑似凭据值的正则（与 verificationRegistry 对齐）。 */
const SECRET_VALUE_PATTERN = /(sk-[A-Za-z0-9]|gh[pous]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]+|AKIA[0-9A-Z]{16}|xox[bpoa]-[A-Za-z0-9-]+|-----BEGIN[\s\S]*?END [A-Z ]+-----|Cookie=[^;\s]+|refresh_token[=:]\S+)/gi;

/** 对命令原文脱敏：命中凭据模式的片段替换为 [REDACTED]。 */
function redactCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return cmd || '';
  return cmd.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
}

/** 内存环形缓冲：最近 N 条决策，供运行时/测试查询（非凭据）。 */
const MEM_LIMIT = 500;
const memory = [];

/**
 * 登记一次权限决策。
 * @param {object} entry
 * @param {string} [entry.runId]
 * @param {string} [entry.agentId]
 * @param {string} [entry.risk]            'low'|'medium'|'high'|'critical'
 * @param {string} [entry.operation]       run_shell / write_file / read_file / ...
 * @param {boolean} [entry.decision]       最终是否放行
 * @param {string} [entry.decisionSource]  USER / PROJECT_POLICY / GLOBAL_POLICY / PARENT_DENY / RISK_FAIL_CLOSED / POLICY_DENY
 * @param {string} [entry.command]         原始命令（将被脱敏）
 */
function log(entry = {}) {
  const record = {
    time: new Date().toISOString(),
    runId: entry.runId || '',
    agentId: entry.agentId || '',
    risk: entry.risk || '',
    operation: entry.operation || '',
    decision: entry.decision === true ? 'allow' : (entry.decision === false ? 'deny' : String(entry.decision || '')),
    decisionSource: entry.decisionSource || '',
    command: redactCommand(entry.command)
  };
  memory.push(record);
  if (memory.length > MEM_LIMIT) memory.splice(0, memory.length - MEM_LIMIT);
  try {
    if (permissionDecisions && typeof permissionDecisions.record === 'function') {
      permissionDecisions.record({
        runId: record.runId,
        agentId: record.agentId,
        risk: record.risk,
        operation: record.operation,
        decision: record.decision,
        decisionSource: record.decisionSource,
        command: record.command
      });
    }
  } catch { /* DB 不可用时仅保留内存记录，不阻断主流程 */ }
  return record;
}

/** 返回内存中的最近决策（脱敏后）。 */
function recent(limit) {
  return memory.slice(-(limit || MEM_LIMIT));
}

function clear() { memory.length = 0; }

module.exports = { log, recent, clear, redactCommand };
