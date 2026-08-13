'use strict';
/**
 * Git tools — status / diff / log / show / branch / add / commit / create_branch / checkout.
 * Destructive ops (reset --hard, clean -fd, force push) escalate permission.
 */
const { spawn } = require('child_process');
const { guard } = require('../security/pathguard');

function ok(data) { return { ok: true, data }; }
function fail(code, message, retryable = false) { return { ok: false, error: { code, message, retryable } }; }

const DESTRUCTIVE = [/\bgit\s+reset\s+--hard\b/i, /\bgit\s+clean\s+-fd\b/i, /\bgit\s+push\b.*--force/i, /\bgit\s+checkout\s+\.\b/i];
function isDestructive(cmd) { return DESTRUCTIVE.some(re => re.test(cmd)); }

function gitExec(ctx, args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: ctx.projectRoot, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('error', e => resolve(fail('GIT_FAILED', e.message)));
    child.on('close', code => resolve(code === 0 ? ok({ output: out, exit_code: 0 }) : fail('GIT_ERROR', (err || out).trim() || `exit ${code}`, false)));
  });
}

const tools = [
  { name: 'git_status', description: '查看工作区状态（git status）。', risk_level: 'low', permission: 'git.read',
    input_schema: { type: 'object', properties: {} },
    async exec(ctx) { const r = await gitExec(ctx, ['status', '--porcelain', '-b']); return r.ok ? ok({ status: r.data.output }) : r; } },
  { name: 'git_diff', description: '查看未提交的改动（git diff）。', risk_level: 'low', permission: 'git.read',
    input_schema: { type: 'object', properties: { staged: { type: 'boolean', default: false } } },
    async exec(ctx, args) { const r = await gitExec(ctx, args.staged ? ['diff', '--cached'] : ['diff']); return r.ok ? ok({ diff: r.data.output }) : r; } },
  { name: 'git_log', description: '查看提交历史。', risk_level: 'low', permission: 'git.read',
    input_schema: { type: 'object', properties: { limit: { type: 'number', default: 20 } } },
    async exec(ctx, args) { const r = await gitExec(ctx, ['log', '--oneline', `-n${args.limit || 20}`]); return r.ok ? ok({ log: r.data.output }) : r; } },
  { name: 'git_show', description: '查看某次提交或文件的详细内容。', risk_level: 'low', permission: 'git.read',
    input_schema: { type: 'object', properties: { ref: { type: 'string', description: 'commit/branch/文件' } }, required: ['ref'] },
    async exec(ctx, args) { const r = await gitExec(ctx, ['show', args.ref]); return r.ok ? ok({ content: r.data.output }) : r; } },
  { name: 'git_branch', description: '列出分支。', risk_level: 'low', permission: 'git.read',
    input_schema: { type: 'object', properties: {} },
    async exec(ctx) { const r = await gitExec(ctx, ['branch', '-a']); return r.ok ? ok({ branches: r.data.output }) : r; } },
  { name: 'git_add', description: '暂存文件（git add）。', risk_level: 'medium', permission: 'git.write',
    input_schema: { type: 'object', properties: { files: { type: 'string', description: '文件（. 表示全部）', default: '.' } } },
    async exec(ctx, args) { const r = await gitExec(ctx, ['add', args.files || '.']); return r.ok ? ok({ added: args.files || '.' }) : r; } },
  { name: 'git_commit', description: '提交改动（git commit -m）。', risk_level: 'high', permission: 'git.write',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    async exec(ctx, args) { const r = await gitExec(ctx, ['commit', '-m', args.message]); return r.ok ? ok({ result: r.data.output }) : r; } },
  { name: 'git_create_branch', description: '创建并切换到新分支。', risk_level: 'high', permission: 'git.write',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async exec(ctx, args) { const r = await gitExec(ctx, ['checkout', '-b', args.name]); return r.ok ? ok({ branch: args.name }) : r; } },
  { name: 'git_checkout', description: '切换分支或恢复文件。', risk_level: 'high', permission: 'git.write',
    input_schema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    async exec(ctx, args) { const r = await gitExec(ctx, ['checkout', args.ref]); return r.ok ? ok({ checkout: args.ref }) : r; } }
];

function gitDestructive(cmd) { return isDestructive(cmd); }

module.exports = { tools, gitDestructive, gitExec };
