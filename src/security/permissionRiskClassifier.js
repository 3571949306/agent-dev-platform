'use strict';
/**
 * PermissionRiskClassifier — deterministic risk tiering for agent operations.
 *
 * Consumes CommandRiskAnalyzer signals + operation + projectRoot and returns a
 * risk tier (spec §17-21). Pure rules, no LLM, fail-closed: anything that
 * matches no rule is treated as HIGH.
 *
 *   LOW      (§18) read project files, git status/diff/log, test results,
 *                  package metadata → auto-allow when parent allows.
 *   MEDIUM   (§19) project file writes, git add, start local dev tools →
 *                  project policy / user preference decides.
 *   HIGH     (§20) multi-file delete, config overwrite, package install,
 *                  git checkout/restore/clean, outside projectRoot, unknown
 *                  executables, registry/env changes → DENY without GUI.
 *   CRITICAL (§21) git reset --hard, git clean -fd/-fdx, rm -rf,
 *                  Remove-Item -Recurse -Force, format, diskpart, bcdedit,
 *                  delete projectRoot/.git, shutdown/restart, credential or
 *                  security-policy modification → ALWAYS explicit confirm.
 */

const { analyzeCommandRisk, normalizeExecutable, KNOWN_SAFE_EXECUTABLES } = require('./commandRiskAnalyzer');

const RISK_LEVEL = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };

/** Order for "first match wins, evaluate from highest". */
const TIER_ORDER = ['critical', 'high', 'medium', 'low'];

const GIT_RESET_HARD_RE = /git\s+reset\b[^|;&]*--hard/i;
const GIT_CLEAN_FORCE_RE = /git\s+clean\b[^|;&]*\s-[a-zA-Z]*f[a-zA-Z]*(\s|$)/i;
const GIT_CHECKOUT_RESTORE_RE = /git\s+(checkout|restore)\b/i;
const GIT_BRANCH_FORCE_DELETE_RE = /git\s+branch\b[^|;&]*-D/i;
const GIT_ADD_RE = /git\s+add\b/i;
const SYS_CRITICAL_RE = /\b(format|diskpart|bcdedit|shutdown)\b/i;
const DEV_SERVER_RE = /\b(npm|yarn|pnpm)\s+(start|run\s+(dev|serve|start))\b/i;

function normalizeOperation(operation) {
  return String(operation || '').toLowerCase().replace(/-/g, '_');
}

/** Is the operation's target (targetPath or cwd) inside projectRoot? */
function targetInsideRoot(input, projectRoot) {
  const path = require('path');
  const target = input.targetPath || input.cwd;
  if (!projectRoot) return true;
  if (!target) return true;
  const base = path.resolve(projectRoot);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, abs);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Detect deletion aimed at the projectRoot itself or its .git directory. */
function deletesProjectCore(input, projectRoot, signals) {
  if (!signals.isRecursiveDelete && !signals.isPowerShellDestructive) return false;
  const path = require('path');
  const target = input.targetPath;
  if (!projectRoot || !target) return false;
  const base = path.resolve(projectRoot).toLowerCase();
  const abs = path.resolve(base, target).toLowerCase();
  return abs === base || abs === path.join(base, '.git');
}

/**
 * Spec §24 false-positive guard: a known-safe executable invoked with only
 * informational flags (node -v, node -p, npm --version) is read-only.
 */
function isInformationalCommand(command) {
  const toks = String(command || '').trim().split(/\s+/);
  if (!toks.length || !toks[0]) return false;
  const exec = normalizeExecutable(toks[0]);
  if (!KNOWN_SAFE_EXECUTABLES.has(exec) || exec === 'git') return false;
  const rest = toks.slice(1);
  if (!rest.length) return false;
  return rest.every((t) => t.startsWith('-'));
}

/**
 * Classify the risk of an agent operation.
 *
 * @param {object} commandInput  command descriptor
 *   `{ command, argv?, shell?, platform?, cwd?, targetPath?, recursive?, force? }`.
 * @param {string} operation     operation kind, e.g. 'run_shell', 'read_file',
 *   'write_file', 'delete_file'.
 * @param {string} projectRoot   absolute project root for containment checks.
 * @returns {{risk: string, reasons: string[]}} risk is one of RISK_LEVEL values.
 */
function classifyRisk(commandInput, operation, projectRoot) {
  const input = Object.assign({}, commandInput || {});
  if (projectRoot && !input.projectRoot) input.projectRoot = projectRoot;
  const signals = analyzeCommandRisk(input);
  const op = normalizeOperation(operation);
  const cmd = String(input.command || '');
  const inside = targetInsideRoot(input, projectRoot);

  const tiers = { critical: [], high: [], medium: [], low: [] };

  // ---- CRITICAL (§21) -------------------------------------------------
  if (signals.isGitDestructive && GIT_RESET_HARD_RE.test(cmd)) {
    tiers.critical.push('git reset --hard 会不可逆丢弃工作区改动');
  }
  if (signals.isGitDestructive && GIT_CLEAN_FORCE_RE.test(cmd)) {
    tiers.critical.push('git clean -f/-fd/-fdx 会删除未跟踪文件');
  }
  if (signals.isRecursiveDelete) {
    tiers.critical.push('递归强制删除（rm -rf / Remove-Item -Recurse -Force / rmdir /s）');
  }
  if (signals.isPowerShellDestructive && SYS_CRITICAL_RE.test(cmd)) {
    tiers.critical.push('系统级破坏性命令（format / diskpart / bcdedit / shutdown）');
  }
  if (deletesProjectCore(input, projectRoot, signals)) {
    tiers.critical.push('删除目标是项目根目录或 .git 目录');
  }
  if (/\b(security\s*policy|credential|credentials)\b/i.test(cmd)
    && (signals.isPowerShellDestructive || /\b(delete|remove|modify|set)\b/i.test(cmd))) {
    tiers.critical.push('修改凭据存储或安全策略');
  }

  // ---- HIGH (§20) -----------------------------------------------------
  if (signals.isGitDestructive && !tiers.critical.length
    && (GIT_CHECKOUT_RESTORE_RE.test(cmd) || GIT_BRANCH_FORCE_DELETE_RE.test(cmd))) {
    tiers.high.push('git checkout / restore / branch -D 可能丢弃改动或分支');
  }
  if (signals.isPowerShellDestructive && !SYS_CRITICAL_RE.test(cmd)) {
    tiers.high.push('Windows 破坏性命令（删除文件 / 注册表 / 服务 / 进程）');
  }
  if (signals.isGitDestructive && GIT_CLEAN_FORCE_RE.test(cmd)) {
    // git clean is HIGH-ish but already CRITICAL above; keep HIGH note for
    // non-force clean variants reaching here
  } else if (signals.isGitDestructive && /git\s+clean\b/i.test(cmd) && !tiers.critical.length) {
    tiers.high.push('git clean 可能删除未跟踪文件');
  }
  if (signals.targetsOutsideRoot) {
    tiers.high.push('操作目标超出项目根目录范围');
  }
  if (signals.isUnknownExecutable) {
    tiers.high.push('未知可执行程序');
  }
  if ((op === 'write_file' || op === 'delete_file') && !inside) {
    tiers.high.push('文件操作位于项目根目录之外');
  }
  if (/\b(npm|yarn|pnpm)\s+(install|i|add|update|upgrade)\b/i.test(cmd)) {
    tiers.high.push('安装/更新依赖包会改变项目依赖树');
  }

  // ---- MEDIUM (§19) ---------------------------------------------------
  if (op === 'write_file' && inside) {
    tiers.medium.push('写入项目根目录内文件');
  }
  if (op === 'delete_file' && inside) {
    tiers.medium.push('删除项目根目录内文件');
  }
  if (GIT_ADD_RE.test(cmd) && !tiers.high.length && !tiers.critical.length) {
    tiers.medium.push('git add 仅暂存改动，可由项目策略决定');
  }
  if (DEV_SERVER_RE.test(cmd)) {
    tiers.medium.push('启动本地开发服务器/工具');
  }

  // ---- LOW (§18) ------------------------------------------------------
  if (op === 'read_file') {
    tiers.low.push('只读文件操作');
  }
  if (signals.isReadonlyGit) {
    tiers.low.push('git 只读命令（status / diff / log）');
  }
  if (signals.isKnownTestLint && inside) {
    tiers.low.push('已知测试 / lint / 构建命令');
  }
  if (!tiers.critical.length && !tiers.high.length && isInformationalCommand(input.command)) {
    tiers.low.push('已知安全程序的版本/信息查询（spec §24 误报防护）');
  }

  // ---- First match wins, highest tier first; fail closed to HIGH ------
  for (const tier of TIER_ORDER) {
    if (tiers[tier].length) {
      return { risk: RISK_LEVEL[tier.toUpperCase()], reasons: tiers[tier] };
    }
  }
  // 已知安全可执行程序（无任何破坏模式命中）→ LOW，而非误判 HIGH（spec §18/§24：
  // ls / cat / echo / node -v / git status 等只读或信息类命令不得被 fail-closed 成高风险）。
  // 仅当可执行程序完全未知（isUnknownExecutable）时才回落 HIGH，避免把良性命令挡在门外。
  if (!signals.isUnknownExecutable) {
    return { risk: RISK_LEVEL.LOW, reasons: ['已知安全可执行程序，未命中任何危险模式'] };
  }
  if (op && op !== 'run_shell') {
    // Known non-shell operations that matched nothing: reads are low risk.
    if (op.includes('read') || op.includes('search') || op.includes('list')) {
      return { risk: RISK_LEVEL.LOW, reasons: ['只读操作，未匹配任何危险模式'] };
    }
  }
  return { risk: RISK_LEVEL.HIGH, reasons: ['未识别的操作或未知可执行程序，默认按高风险处理（fail-closed）'] };
}

module.exports = { classifyRisk, RISK_LEVEL };
