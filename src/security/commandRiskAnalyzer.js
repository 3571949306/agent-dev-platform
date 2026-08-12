'use strict';
/**
 * CommandRiskAnalyzer — pure-logic detection of dangerous shell commands.
 *
 * No I/O, no side effects: parses a command into structured risk signals that
 * the PermissionRiskClassifier then turns into a risk tier (spec §23/§24).
 *
 * Windows destructive commands (spec §23): del, erase, rmdir /s, rd /s,
 * Remove-Item, Clear-Content, Move-Item -Force, Copy-Item -Force, reg delete,
 * taskkill, shutdown, format, diskpart, bcdedit, sc delete.
 * Git destructive (spec §23): git reset (--hard), git clean (-f/-fd/-fdx),
 * git checkout, git restore, git branch -D.
 * False-positive guards (spec §24): npm test / lint / build, npx mocha,
 * git diff / status / log / add, node -v / -p, npm -v must NOT be flagged.
 */

/**
 * Split a command string into tokens. Respects single/double quotes and
 * strips backslash escapes (good enough for risk triage; never executes).
 * @param {string} cmd
 * @returns {string[]}
 */
function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '\\' && i + 1 < cmd.length) {
      cur += cmd[i + 1];
      i += 1;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Strip shell chaining (&&, ||, ;, |, &) — every segment is analyzed. */
function splitSegments(tokens) {
  const segments = [];
  let cur = [];
  for (const t of tokens) {
    if (/^(&&|\|\||;|\||&)$/.test(t)) {
      if (cur.length) segments.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length) segments.push(cur);
  return segments;
}

/** Strip privilege/env prefixes: sudo, doas, cmd /c, env VAR=x. */
function stripPrefixes(tokens) {
  let out = tokens.slice();
  let changed = true;
  while (changed && out.length) {
    changed = false;
    const first = out[0].toLowerCase();
    if (first === 'sudo' || first === 'doas') { out = out.slice(1); changed = true; continue; }
    if ((first === 'cmd' || first === 'cmd.exe') && /^\/[ck]$/i.test(out[1] || '')) {
      out = out.slice(2); changed = true; continue;
    }
    if (/^[a-z_][a-z0-9_]*=.*$/i.test(first) && !out[0].includes(' ')) {
      // env VAR=value prefix (bash style)
      out = out.slice(1); changed = true;
    }
  }
  return out;
}

/** Normalize executable name: lowercase, basename, no .exe/.cmd/.bat/.ps1. */
function normalizeExecutable(name) {
  let n = String(name || '');
  n = n.replace(/\\/g, '/').split('/').pop() || '';
  n = n.replace(/\.(exe|cmd|bat|ps1)$/i, '');
  return n.toLowerCase();
}

const PS_ALIASES = {
  del: 'remove-item', erase: 'remove-item', rd: 'remove-item', rmdir: 'remove-item',
  ri: 'remove-item', rm: 'remove-item',
  cp: 'copy-item', mv: 'move-item',
  clc: 'clear-content', clear: 'clear-content',
  sl: 'set-location', cd: 'set-location',
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem',
  cat: 'get-content', type: 'get-content', echo: 'write-output'
};

/**
 * Destructive Windows/PowerShell commands. `needsFlag` requires one of the
 * listed flags to be present (e.g. Move-Item is only destructive with -Force).
 */
const PS_DESTRUCTIVE = [
  { cmd: 'remove-item', label: 'Remove-Item' },
  { cmd: 'clear-content', label: 'Clear-Content' },
  { cmd: 'move-item', label: 'Move-Item -Force', needsFlag: ['-force', '/force'] },
  { cmd: 'copy-item', label: 'Copy-Item -Force', needsFlag: ['-force', '/force'] },
  { cmd: 'reg', label: 'reg delete', needsSub: ['delete'] },
  { cmd: 'sc', label: 'sc delete', needsSub: ['delete', 'stop', 'config'] },
  { cmd: 'sc.exe', label: 'sc delete', needsSub: ['delete', 'stop', 'config'] },
  { cmd: 'taskkill', label: 'taskkill' },
  { cmd: 'shutdown', label: 'shutdown' },
  { cmd: 'format', label: 'format' },
  { cmd: 'diskpart', label: 'diskpart' },
  { cmd: 'bcdedit', label: 'bcdedit' }
];

/** Combined short flags like -rf, -fdx; excludes single-dash long opts. */
const COMBINED_FLAG_RE = /^-[a-zA-Z]{2,}$/;

function hasFlag(args, flag) {
  return args.some((a) => a.toLowerCase() === flag.toLowerCase());
}

function hasCombinedFlag(args, letter) {
  return args.some((a) => COMBINED_FLAG_RE.test(a) && a.includes(letter));
}

const READONLY_GIT_SUB = ['status', 'diff', 'log', 'show', 'branch', 'tag', 'remote', 'config', 'rev-parse'];

const KNOWN_SAFE_EXECUTABLES = new Set([
  // shells / wrappers (their payload is re-analyzed separately)
  'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'wsl',
  // runtimes & version tools
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'python', 'python3', 'pip', 'pip3',
  // git (subcommand analyzed separately)
  'git',
  // read-only / info commands (spec §24 guards)
  'ls', 'dir', 'cat', 'type', 'pwd', 'cd', 'echo', 'which', 'where', 'whereis',
  'hostname', 'whoami', 'date', 'time', 'ver', 'set', 'printenv', 'env', 'head',
  'tail', 'grep', 'findstr', 'find', 'more', 'less', 'wc', 'sort', 'tree',
  'ipconfig', 'ping', 'nslookup', 'netstat', 'systeminfo', 'tasklist',
  // common build/test tooling
  'dotnet', 'gradle', 'gradlew', 'mvn', 'java', 'make', 'cargo', 'go',
  'docker', 'kubectl', 'code', 'sqlite3'
]);

/** Well-known test/lint/build runners (executable + optional next-token). */
const KNOWN_TEST_LINT = [
  { exec: 'npm', next: ['test', 't'] },
  { exec: 'npm', nextRe: /^run$/i, third: ['lint', 'test', 'build', 'check', 'typecheck'] },
  { exec: 'npx', any: ['mocha', 'jest', 'vitest', 'eslint', 'tsc', 'playwright', 'cypress'] },
  { exec: 'yarn', next: ['test', 'lint', 'build'] },
  { exec: 'pnpm', next: ['test', 'lint', 'build'] },
  { exec: 'make', next: ['test', 'lint', 'build'] },
  { exec: 'mocha' }, { exec: 'jest' }, { exec: 'vitest' }, { exec: 'eslint' },
  { exec: 'tsc' }, { exec: 'pytest' }
];

function matchesTestLint(exec, args) {
  for (const spec of KNOWN_TEST_LINT) {
    if (spec.exec !== exec) continue;
    if (!spec.next && !spec.nextRe && !spec.any) return true;
    const next = (args[0] || '').toLowerCase();
    if (spec.next && spec.next.includes(next)) return true;
    if (spec.nextRe && spec.nextRe.test(args[0] || '') && spec.third
      && spec.third.includes((args[1] || '').toLowerCase())) return true;
    if (spec.any && spec.any.includes(next)) return true;
  }
  return false;
}

/** Extract the combined/long flags following a git subcommand. */
function gitFlags(args, start) {
  const flags = [];
  for (let i = start; i < args.length; i += 1) {
    const t = args[i];
    if (t === '--') break;
    if (t.startsWith('-')) flags.push(t);
  }
  return flags.join(' ');
}

function analyzeGit(args, signals) {
  // find subcommand, skipping -C <path> / --git-dir=... style global options
  let idx = 0;
  while (idx < args.length && args[idx].startsWith('-')) idx += 1;
  if (args[idx] === '-C') idx += 2;
  const sub = (args[idx] || '').toLowerCase();
  const rest = args.slice(idx + 1);
  const flagStr = gitFlags(rest, 0);
  const subDisplay = `git ${sub}`;

  if (sub === 'reset') {
    signals.isGitDestructive = true;
    signals.matchedPatterns.push(hasFlag(rest, '--hard')
      ? 'git reset --hard（不可逆丢弃工作区改动）'
      : 'git reset（可能丢失未提交改动）');
  } else if (sub === 'clean') {
    const force = hasFlag(rest, '-f') || hasCombinedFlag(rest, 'f') || hasFlag(rest, '--force');
    if (force) {
      signals.isGitDestructive = true;
      signals.matchedPatterns.push(`git clean ${flagStr || '-f'}（删除未跟踪文件）`);
    }
  } else if (sub === 'checkout') {
    signals.isGitDestructive = true;
    signals.matchedPatterns.push('git checkout（可能覆盖工作区改动）');
  } else if (sub === 'restore') {
    signals.isGitDestructive = true;
    signals.matchedPatterns.push('git restore（可能丢弃工作区/暂存区改动）');
  } else if (sub === 'stash') {
    // v2.9.8 R1：stash 会把用户未提交改动从工作区搬走（含 pop/drop/apply 变体），
    // 属于对用户工作区的隐藏变异，必须进入高风险确认路径。
    signals.isGitDestructive = true;
    signals.matchedPatterns.push(`git stash ${flagStr || ''}（搬走用户未提交改动）`.replace(/\s+/g, ' ').trim());
  } else if (sub === 'switch' && (hasFlag(rest, '-f') || hasFlag(rest, '--force') || hasFlag(rest, '--discard-changes') || hasCombinedFlag(rest, 'f'))) {
    signals.isGitDestructive = true;
    signals.matchedPatterns.push('git switch -f（强制切换丢弃工作区改动）');
  } else if (sub === 'branch' && hasFlag(rest, '-D')) {
    signals.isGitDestructive = true;
    signals.matchedPatterns.push('git branch -D（强制删除分支）');
  } else if (sub === 'push' && (flagStr.includes('--mirror') || (flagStr.includes('--force') && flagStr.includes('--delete')))) {
    signals.isGitDestructive = true;
    signals.matchedPatterns.push(`git push ${flagStr}（远端破坏性推送）`);
  }

  if (sub === 'add') {
    signals.isKnownTestLint = false; // never treat as test/lint
    signals.matchedPatterns.push('git add（暂存改动，可由策略放行）');
  } else if (READONLY_GIT_SUB.includes(sub) && !signals.isGitDestructive) {
    signals.isReadonlyGit = true;
  }
}

function analyzeWindowsDestructive(exec, args, signals) {
  for (const rule of PS_DESTRUCTIVE) {
    if (rule.cmd !== exec) continue;
    if (rule.needsFlag && !rule.needsFlag.some((f) => hasFlag(args, f))) continue;
    if (rule.needsSub) {
      const sub = (args[0] || '').toLowerCase();
      if (!rule.needsSub.includes(sub)) continue;
    }
    signals.isPowerShellDestructive = true;
    signals.matchedPatterns.push(`Windows 破坏性命令：${rule.label}`);
    if (rule.cmd === 'remove-item') {
      // Covers Remove-Item -Recurse -Force, `del /s` and the `rm -rf` alias
      // form. Spec lists "Remove-Item -Recurse" itself as recursive delete.
      const recurse = hasFlag(args, '-recurse') || hasFlag(args, '/s')
        || hasCombinedFlag(args, 'r') || hasCombinedFlag(args, 'R');
      const force = hasFlag(args, '-force') || hasFlag(args, '/force')
        || hasCombinedFlag(args, 'f');
      if (recurse) signals.isRecursiveDelete = true;
      if (recurse && force) signals.matchedPatterns.push('Remove-Item -Recurse -Force（递归强制删除）');
    }
  }
}

function analyzeUnixDelete(exec, args, signals) {
  if (exec !== 'rm') return;
  const recurse = hasFlag(args, '-r') || hasFlag(args, '-R') || hasFlag(args, '--recursive')
    || hasCombinedFlag(args, 'r') || hasCombinedFlag(args, 'R');
  const force = hasFlag(args, '-f') || hasFlag(args, '--force') || hasCombinedFlag(args, 'f');
  if (recurse && force) {
    signals.isRecursiveDelete = true;
    signals.matchedPatterns.push('rm -rf（递归强制删除）');
  } else if (recurse) {
    signals.isRecursiveDelete = true;
    signals.matchedPatterns.push('rm -r（递归删除）');
  }
}

function analyzeCmdDelete(exec, args, signals) {
  const lowerArgs = args.map((a) => a.toLowerCase());
  const hasS = lowerArgs.includes('/s');
  const hasQ = lowerArgs.includes('/q');
  if (exec === 'del' || exec === 'erase') {
    signals.isPowerShellDestructive = true;
    signals.matchedPatterns.push(`Windows 破坏性命令：${exec}${hasS ? ' /s' : ''}`);
    if (hasS) signals.isRecursiveDelete = true;
  } else if ((exec === 'rmdir' || exec === 'rd') && hasS) {
    signals.isPowerShellDestructive = true;
    signals.isRecursiveDelete = true;
    signals.matchedPatterns.push(`Windows 破坏性命令：${exec} /s${hasQ ? ' /q' : ''}（递归删除目录）`);
  }
}

/**
 * v2.8.2 §82-§95：检测链接 / reparse point 创建命令。
 *   - cmd: mklink /J（junction）、mklink /D（目录符号链接）、mklink（文件符号链接）
 *   - powershell: New-Item -ItemType Junction|SymbolicLink
 *   - unix: ln -s
 *
 * 这些操作改变路径拓扑，可让未来路径边界判断失效，至少 HIGH；
 * 若目标 outside project 应升级 CRITICAL（由 PermissionRiskClassifier §83/§84）。
 */
function analyzeLinkCreation(exec, args, signals) {
  if (exec === 'mklink') {
    signals.isLinkCreation = true;
    const lowerArgs = args.map((a) => a.toLowerCase());
    const isJunction = lowerArgs.includes('/j');
    const isDir = lowerArgs.includes('/d');
    signals.matchedPatterns.push(
      `创建 ${isJunction ? 'Junction' : (isDir ? '目录符号链接' : '符号链接')}（mklink，改变路径拓扑）`
    );
  } else if (exec === 'new-item') {
    const lowerArgs = args.map((a) => a.toLowerCase());
    for (let i = 0; i < lowerArgs.length; i += 1) {
      if ((lowerArgs[i] === '-itemtype' || lowerArgs[i] === '/itemtype')
        && i + 1 < lowerArgs.length) {
        const t = lowerArgs[i + 1];
        if (t === 'junction' || t === 'symboliclink' || t === 'symlink') {
          signals.isLinkCreation = true;
          signals.matchedPatterns.push(`创建 ${t}（New-Item -ItemType，改变路径拓扑）`);
        }
      }
    }
  } else if (exec === 'ln') {
    const lowerArgs = args.map((a) => a.toLowerCase());
    if (lowerArgs.includes('-s') || hasCombinedFlag(args, 's') || lowerArgs.includes('--symbolic')) {
      signals.isLinkCreation = true;
      signals.matchedPatterns.push('创建符号链接（ln -s，改变路径拓扑）');
    }
  }
}

/**
 * v2.8.2 §30：lexical outside-root 信号（纯字符串 path.resolve + path.relative）。
 *
 * 注意：本函数只提供 lexical 快速信号，**不是**最终安全 enforcement。
 * 最终 security decision 必须以 PathSecurity（canonicalPath.js）的 canonical
 * containment 结果为准。lexical 信号用于：
 *   - 快速拒绝明显 ../ 逃逸（性能）；
 *   - 与 canonical 信号组合判断 REPARSE_ESCAPE（lexicalInside + canonicalOutside）。
 *
 * signals.targetsOutsideRoot 保持原名以向后兼容，语义为 lexical outside。
 */
function checkOutsideRoot(input, signals) {
  const root = input.projectRoot || input.root;
  const target = input.targetPath;
  if (!root || !target) return;
  const path = require('path');
  const base = path.resolve(root);
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    signals.targetsOutsideRoot = true;
    signals.matchedPatterns.push(`目标路径「${target}」超出项目根目录范围（lexical）`);
  }
}

/** Rewrite `powershell -Command <payload>` / `cmd /c <payload>` segments. */
function unwrapShellPayload(exec, tokens, shellHint) {
  if (exec === 'powershell' || exec === 'pwsh') {
    const i = tokens.findIndex((t) => /^-(command|c|encodedcommand)$/i.test(t));
    if (i >= 0) {
      const payload = tokens.slice(i + 1).join(' ');
      const inner = tokenize(payload);
      if (inner.length) return stripPrefixes(inner);
    }
  }
  if (shellHint && /powershell|pwsh/i.test(shellHint) && PS_ALIASES[exec] && exec !== 'rm') {
    // In PowerShell, `del`/`ri` etc. are aliases for Remove-Item
    return [PS_ALIASES[exec]].concat(tokens.slice(1));
  }
  return null;
}

function defaultSignals() {
  return {
    isGitDestructive: false,
    isPowerShellDestructive: false,
    isRecursiveDelete: false,
    targetsOutsideRoot: false,
    isReadonlyGit: false,
    isKnownTestLint: false,
    isUnknownExecutable: false,
    // v2.8.2 §82-§95：链接 / reparse point 创建会改变路径拓扑，至少 HIGH。
    isLinkCreation: false,
    matchedPatterns: []
  };
}

/**
 * Analyze a shell command for dangerous patterns (pure function, no I/O).
 *
 * @param {object} input
 * @param {string} input.command      the raw command string to analyze.
 * @param {string[]} [input.argv]     optional pre-split argv (fallback input).
 * @param {string} [input.shell]      shell hint: 'powershell' | 'cmd' | 'bash' …
 * @param {string} [input.platform]   'win32' | 'linux' | 'darwin' …
 * @param {string} [input.cwd]        working directory of the command.
 * @param {string} [input.targetPath] file/dir path the command operates on.
 * @param {string} [input.projectRoot] project root used for containment check.
 * @param {boolean} [input.recursive] caller hint: recursive operation.
 * @param {boolean} [input.force]     caller hint: forced operation.
 * @returns {{isGitDestructive:boolean,isPowerShellDestructive:boolean,
 *            isRecursiveDelete:boolean,targetsOutsideRoot:boolean,
 *            isReadonlyGit:boolean,isKnownTestLint:boolean,
 *            isUnknownExecutable:boolean,matchedPatterns:string[]}}
 */
function analyzeCommandRisk(input = {}) {
  const signals = defaultSignals();
  const shellHint = input.shell || '';
  const platform = (input.platform || process.platform || '').toLowerCase();
  const winLike = platform === 'win32' || /powershell|pwsh|cmd/i.test(shellHint);

  let tokens = tokenize(String(input.command || ''));
  if (!tokens.length && Array.isArray(input.argv)) tokens = input.argv.slice();
  const segments = splitSegments(tokens);

  for (const rawSeg of segments) {
    let seg = stripPrefixes(rawSeg);
    if (!seg.length) continue;
    let exec = normalizeExecutable(seg[0]);
    let args = seg.slice(1);

    // Unwrap shells whose payload carries the real command
    const unwrapped = unwrapShellPayload(exec, seg, shellHint);
    if (unwrapped) {
      exec = normalizeExecutable(unwrapped[0]);
      args = unwrapped.slice(1);
    }

    // PowerShell alias resolution (del/ri/rm → Remove-Item, etc.)
    if (winLike && PS_ALIASES[exec] && !KNOWN_SAFE_EXECUTABLES.has(exec)) {
      exec = PS_ALIASES[exec];
    } else if (winLike && exec === 'rm') {
      // On Windows `rm` is the Remove-Item alias; elsewhere it's unix rm
      exec = platform === 'win32' ? 'remove-item' : 'rm';
    }

    if (exec === 'git') {
      analyzeGit(args, signals);
    } else if (winLike || platform === 'win32') {
      analyzeWindowsDestructive(exec, args, signals);
      analyzeCmdDelete(exec, args, signals);
      analyzeUnixDelete(exec, args, signals); // Git-Bash / WSL style rm -rf
    } else {
      analyzeUnixDelete(exec, args, signals);
    }

    // v2.8.2 §93-§95：链接 / reparse point 创建检测（跨平台）
    analyzeLinkCreation(exec, args, signals);

    if (matchesTestLint(exec, args)) {
      signals.isKnownTestLint = true;
      signals.matchedPatterns.push(`已知测试/构建命令：${exec} ${args[0] || ''}`.trim());
    }

    if (exec && !KNOWN_SAFE_EXECUTABLES.has(exec) && !PS_DESTRUCTIVE.some((r) => r.cmd === exec)
      && exec !== 'git' && exec !== 'rm') {
      signals.isUnknownExecutable = true;
      signals.matchedPatterns.push(`未知可执行程序：${seg[0]}`);
    }
  }

  // Caller hints strengthen delete detection (fail closed)
  if (input.recursive && input.force && /delete|remove|del|rm|clean/i.test(String(input.command || ''))) {
    signals.isRecursiveDelete = true;
  }

  checkOutsideRoot(input, signals);
  return signals;
}

module.exports = { analyzeCommandRisk, tokenize, splitSegments, normalizeExecutable, KNOWN_SAFE_EXECUTABLES };
