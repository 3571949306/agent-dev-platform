'use strict';
/**
 * PermissionRiskClassifier — deterministic risk tiering for agent operations.
 *
 * v2.8.2 §27-§32：canonical path containment 增强。
 *   - targetInsideRoot 不再单独承担安全边界：当调用方注入 pathSecurity 时，
 *     使用 PathSecurity 的 canonical containment 结果（§5 修复）。
 *   - 双层信号（§31）：lexicalOutside → HIGH；canonicalOutside → HIGH；
 *     lexicalInside + canonicalOutside → REPARSE_ESCAPE → HIGH。
 *   - §32：destructive + canonical outside → CRITICAL。
 *   - 向后兼容：未注入 pathSecurity 时回退 lexical（现有调用/测试不破坏），
 *     真实运行时应注入 pathSecurity 启用 canonical 安全。
 *
 *   LOW      (§18) read project files, git status/diff/log, test results,
 *                  package metadata → auto-allow when parent allows.
 *   MEDIUM   (§19) project file writes, git add, start local dev tools →
 *                  project policy / user preference decides.
 *   HIGH     (§20) multi-file delete, config overwrite, package install,
 *                  git checkout/restore/clean, outside projectRoot, unknown
 *                  executables, registry/env changes, REPARSE_ESCAPE → DENY without GUI.
 *   CRITICAL (§21) git reset --hard, git clean -fd/-fdx, rm -rf,
 *                  Remove-Item -Recurse -Force, format, diskpart, bcdedit,
 *                  delete projectRoot/.git, shutdown/restart, credential or
 *                  security-policy modification, destructive + canonical outside → ALWAYS explicit confirm.
 */

const { analyzeCommandRisk, normalizeExecutable, KNOWN_SAFE_EXECUTABLES } = require('./commandRiskAnalyzer');
const pathSecurityDefault = require('./pathSecurity');

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

/**
 * v2.8.2 §27：解析 target 的 containment。
 *   - 注入 pathSecurity 且 projectRoot 有效 → canonical containment（§5 修复）
 *   - 否则回退 lexical（path.resolve + path.relative，向后兼容）
 *
 * 返回 { inside, lexicalInside, canonical, degraded }
 *   inside:         最终 inside 判断（canonical 优先）
 *   lexicalInside:  字符串层 inside（用于 REPARSE_ESCAPE 双层信号）
 *   canonical:      PathContainmentResult 或 null
 *   degraded:       true 表示 canonical 不可用，回退 lexical
 */
function resolveContainment(input, projectRoot, pathSecurity) {
  const path = require('path');
  const target = input.targetPath || input.cwd;
  if (!projectRoot || !target) {
    return { inside: true, lexicalInside: true, canonical: null, degraded: false };
  }
  // lexical 计算（始终可用，用于双层信号）
  const base = path.resolve(projectRoot);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, abs);
  const lexicalInside = !rel.startsWith('..') && !path.isAbsolute(rel);

  // canonical（如果 pathSecurity 注入）
  if (pathSecurity && typeof pathSecurity.checkPathContainment === 'function') {
    try {
      const r = pathSecurity.checkPathContainment(projectRoot, target);
      return {
        inside: r.allowed,
        lexicalInside: r.lexicalInside,
        canonical: r,
        degraded: false
      };
    } catch (e) {
      // ROOT_INVALID（projectRoot 不存在/无效）等：降级到 lexical。
      // 注意：这不是 §23 的 canonicalization fallback（那是针对 target 的）；
      // ROOT_INVALID 表示 root 本身无效，lexical 是保守降级。
      // 真实运行时 projectRoot 应存在；测试环境可能用不存在路径。
      return { inside: lexicalInside, lexicalInside, canonical: null, degraded: true };
    }
  }
  return { inside: lexicalInside, lexicalInside, canonical: null, degraded: true };
}

/**
 * 兼容旧调用：返回 boolean inside。
 * v2.8.2 起推荐使用 resolveContainment 获取双层信号。
 */
function targetInsideRoot(input, projectRoot, pathSecurity) {
  return resolveContainment(input, projectRoot, pathSecurity).inside;
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
 * @param {string} operation     operation kind
 * @param {string} projectRoot   absolute project root for containment checks.
 * @param {object} [options]      v2.8.2：{ pathSecurity } 注入 PathSecurity 实例
 *   启用 canonical containment 安全边界（§27）。未注入时回退 lexical。
 * @returns {{risk: string, reasons: string[], containment?: object}}
 */
function classifyRisk(commandInput, operation, projectRoot, options) {
  const input = Object.assign({}, commandInput || {});
  if (projectRoot && !input.projectRoot) input.projectRoot = projectRoot;
  const opts = options || {};
  // v2.8.2 §27/§60：默认启用 canonical containment（defaultPathSecurity）。
  // 现有调用方无需改动即获得 canonical 安全边界。projectRoot 无效（如测试用 /p）
  // 时 resolveContainment 内部 catch ROOT_INVALID 回退 lexical，向后兼容。
  const pathSecurity = opts.pathSecurity || pathSecurityDefault;
  const signals = analyzeCommandRisk(input);
  const op = normalizeOperation(operation);
  const cmd = String(input.command || '');
  const containment = resolveContainment(input, projectRoot, pathSecurity);
  const inside = containment.inside;
  const canonical = containment.canonical;

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
  // §32: destructive + canonical outside → CRITICAL
  if (canonical && !canonical.allowed
    && (signals.isRecursiveDelete || signals.isPowerShellDestructive
      || (signals.isGitDestructive && (GIT_RESET_HARD_RE.test(cmd) || GIT_CLEAN_FORCE_RE.test(cmd))))) {
    tiers.critical.push('破坏性操作指向项目根目录之外（canonical 逃逸）');
  }
  // §83/§84: 链接创建 + canonical outside → CRITICAL（可改变未来路径边界逃逸到项目外）
  if (signals.isLinkCreation && canonical && !canonical.allowed) {
    tiers.critical.push('创建指向项目外的链接 / reparse point（可改变路径边界逃逸）');
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
    tiers.high.push('操作目标超出项目根目录范围（lexical）');
  }
  // v2.8.2 §31: canonical 逃逸信号
  if (canonical && !canonical.allowed) {
    if (canonical.errorCode === 'PATH_REPARSE_ESCAPE') {
      tiers.high.push('路径经 Junction / Symlink / Reparse Point 逃逸到项目外（REPARSE_ESCAPE）');
    } else if (canonical.errorCode === 'PATH_OUTSIDE_ROOT') {
      tiers.high.push('操作目标经 canonical 解析后超出项目根目录范围');
    } else if (canonical.errorCode === 'PATH_CANONICALIZATION_FAILED') {
      tiers.high.push('路径 canonicalization 失败（fail-closed，可能为断链 symlink）');
    } else if (canonical.errorCode === 'PATH_TAIL_ESCAPE') {
      tiers.high.push('路径 tail 含逃逸段或祖先非目录（TAIL_ESCAPE）');
    } else if (canonical.errorCode === 'PATH_ROOT_INVALID') {
      tiers.high.push('projectRoot 无效（PATH_ROOT_INVALID）');
    } else {
      tiers.high.push(`canonical 路径检查未通过（${canonical.errorCode}）`);
    }
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
  // §82/§85: 链接 / reparse point 创建至少 HIGH（改变路径拓扑）
  if (signals.isLinkCreation && !tiers.critical.length) {
    tiers.high.push('创建链接 / reparse point（mklink / New-Item -ItemType / ln -s），改变路径拓扑');
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
      return { risk: RISK_LEVEL[tier.toUpperCase()], reasons: tiers[tier], containment };
    }
  }
  // 已知安全可执行程序（无任何破坏模式命中）→ LOW，而非误判 HIGH（spec §18/§24）。
  if (!signals.isUnknownExecutable) {
    return { risk: RISK_LEVEL.LOW, reasons: ['已知安全可执行程序，未命中任何危险模式'], containment };
  }
  if (op && op !== 'run_shell') {
    if (op.includes('read') || op.includes('search') || op.includes('list')) {
      return { risk: RISK_LEVEL.LOW, reasons: ['只读操作，未匹配任何危险模式'], containment };
    }
  }
  return { risk: RISK_LEVEL.HIGH, reasons: ['未识别的操作或未知可执行程序，默认按高风险处理（fail-closed）'], containment };
}

module.exports = {
  classifyRisk,
  RISK_LEVEL,
  // v2.8.2 暴露 containment 解析与默认 pathSecurity，供调用方/测试使用
  resolveContainment,
  targetInsideRoot,
  defaultPathSecurity: pathSecurityDefault
};
