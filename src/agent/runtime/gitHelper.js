'use strict';
/**
 * v2.6.0 Main Agent Runtime — git helper（spawn git 子进程的 Promise 包装）。
 * 与 src/tools/git.js 的 gitExec 等价，但返回 { code, out, err } 供 checkpoint 使用。
 * v2.9.8 R2：支持 opts.env（如 GIT_INDEX_FILE 临时索引）实现非变异快照。
 */
const { spawn } = require('child_process');

function execGit(cwd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, windowsHide: true, env: opts.env ? { ...process.env, ...opts.env } : process.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { err += d.toString(); });
    child.on('error', e => resolve({ code: -1, out: '', err: e.message }));
    child.on('close', code => resolve({ code, out, err }));
  });
}

module.exports = { execGit };
