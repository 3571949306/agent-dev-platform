'use strict';
/**
 * v2.6.0 Main Agent Runtime — Deterministic Fake Coding Model（spec §35）。
 *
 * 不让自动测试调用真实 API。FakeCodingModel 按预定义 Action Sequence 返回：
 *   read file → run test → patch → run test → complete
 *
 * Unit / E2E / CI 完全 deterministic。
 *
 * 两种使用方式：
 *   1. 脚本模式：传入 actions 数组，每次 decide() 弹出下一个。
 *   2. 智能模式：传入 decideFn(context, iteration)，根据上下文返回 action。
 */

/**
 * 创建一个 FakeCodingModel。
 * @param {Array<{type, args, thought?}>|Function} script 动作序列或 decideFn
 * @param {object} opts { name }
 */
function createFakeCodingModel(script, opts = {}) {
  const queue = Array.isArray(script) ? script.slice() : null;
  const decideFn = typeof script === 'function' ? script : null;
  let callCount = 0;

  return {
    name: opts.name || 'FakeCodingModel',
    callCount: () => callCount,
    async decide({ context, iteration, abortSignal }) {
      callCount++;
      // 中止时仍返回下一个 action（loop 会检查 abortSignal）；模拟一点延迟更真实
      await delay(1);
      let action;
      if (decideFn) {
        action = decideFn({ context, iteration, callCount });
      } else if (queue && queue.length) {
        action = queue.shift();
      } else {
        // 脚本耗尽：默认 complete（避免无限循环）
        action = { type: 'complete', args: { summary: '脚本耗尽，自动完成' } };
      }
      return { action: { type: action.type, args: action.args || {}, thought: action.thought || '' } };
    }
  };
}

/**
 * 构建一个「修复 add 函数」的标准成功脚本（spec §34/§37）。
 * 顺序：read_file → run_tests(FAIL) → patch_file(修复) → run_tests(PASS) → complete
 * @param {object} opts { file, command, brokenLine, fixedLine }
 */
function buildFixAddScript(opts = {}) {
  const file = opts.file || 'src/math.js';
  const command = opts.command || 'npm test';
  const broken = opts.brokenLine || '  return a - b;';
  const fixed = opts.fixedLine || '  return a + b;';
  return [
    { type: 'read_file', args: { path: file }, thought: '先读取 math.js 了解当前实现' },
    { type: 'run_tests', args: { command }, thought: '运行测试确认当前失败' },
    {
      type: 'patch_file',
      args: {
        path: file,
        patch: `@@ -1,3 +1,3 @@\n function add(a, b) {\n-${broken}\n+${fixed}\n }`
      },
      thought: '修复 add 函数：把减法改成加法'
    },
    { type: 'run_tests', args: { command }, thought: '再次运行测试确认通过' },
    { type: 'complete', args: { summary: '修复 add 函数，测试通过' } }
  ];
}

/**
 * 构建「修复 add 函数」带 Repair Loop 的脚本（spec §28 Case 28）。
 * 第一次 patch 故意仍失败（改成乘法），第二次 patch 才正确（加法）。
 */
function buildRepairLoopScript(opts = {}) {
  const file = opts.file || 'src/math.js';
  const command = opts.command || 'npm test';
  const broken = opts.brokenLine || '  return a - b;';
  const wrongFix = opts.wrongFixLine || '  return a * b;';
  const fixed = opts.fixedLine || '  return a + b;';
  return [
    { type: 'read_file', args: { path: file }, thought: '读取 math.js' },
    { type: 'run_tests', args: { command }, thought: '运行测试（预期失败）' },
    {
      type: 'patch_file',
      args: { path: file, patch: `@@ -1,3 +1,3 @@\n function add(a, b) {\n-${broken}\n+${wrongFix}\n }` },
      thought: '第一次修复（故意错误：改成乘法）'
    },
    { type: 'run_tests', args: { command }, thought: '再次运行测试（仍失败）' },
    {
      type: 'patch_file',
      args: { path: file, patch: `@@ -1,3 +1,3 @@\n function add(a, b) {\n-${wrongFix}\n+${fixed}\n }` },
      thought: '第二次修复（正确：改成加法）'
    },
    { type: 'run_tests', args: { command }, thought: '运行测试（通过）' },
    { type: 'complete', args: { summary: '修复 add 函数，测试通过' } }
  ];
}

/**
 * 构建「模型提前 complete 但 required 验证失败」脚本（spec §30 Case 30）。
 * 模型写一个错误版本后直接 complete，但 verification 的 npm test 仍失败。
 */
function buildPrematureCompleteScript(opts = {}) {
  const file = opts.file || 'src/math.js';
  const command = opts.command || 'npm test';
  const broken = opts.brokenLine || '  return a - b;';
  const wrongFix = opts.wrongFixLine || '  return a / b;';
  return [
    { type: 'read_file', args: { path: file }, thought: '读取 math.js' },
    {
      type: 'patch_file',
      args: { path: file, patch: `@@ -1,3 +1,3 @@\n function add(a, b) {\n-${broken}\n+${wrongFix}\n }` },
      thought: '改了一处（但仍错误）'
    },
    { type: 'complete', args: { summary: '我改好了' } }
    // verification npm test 会失败 → 不得 completed → REPAIRING
  ];
}

/**
 * 构建一个「Hang 命令」脚本（spec §29 Case 29 Stop）。
 * 模型发出一个长时间运行的命令，用户点击停止。
 *
 * 注意：之前的 `node -e "setTimeout(()=>{},60000)"` 在 Windows cmd.exe 下会被
 * 引号/括号规则吃掉，node 实际收到空脚本并立即 exit 0，导致 cancel 测试在
 * 300ms abort 触发前就「完成」了。改用平台原生阻塞命令，确保命令在 abort
 * 触发时仍在运行（terminal 的 onAbort 会 taskkill 整棵进程树）。
 */
function buildHangScript(opts = {}) {
  const defaultHang = process.platform === 'win32'
    ? 'ping -n 61 127.0.0.1 > nul'   // Windows：ping 61 次 ≈ 60s
    : 'sleep 60';                     // POSIX
  const command = opts.hangCommand || defaultHang;
  return [
    { type: 'run_command', args: { command, timeout_ms: 60000 }, thought: '运行长命令（用于测试停止）' }
  ];
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  createFakeCodingModel,
  buildFixAddScript,
  buildRepairLoopScript,
  buildPrematureCompleteScript,
  buildHangScript
};
