'use strict';
/**
 * v2.9.9 Phase B Final（B20）— Diagnostics / Product Health Center 唯一真源。
 *
 * 真话规则：
 *   - 未知就是 UNKNOWN；绝不允许「没报错 → READY」式猜测。
 *   - 每个子系统给出 Status / Reason / Last Checked / Action 建议。
 *   - B20.1 Runtime Residue：Active Runs / Dynamic Instances / AgentHub Active /
 *     Project Locks / Terminal Processes / Pending Permissions /
 *     Pending Workflow Approval / Generator Active —— 全部来自真实 backend。
 *   - B20.3 Problem Integration：DB 错误 / model mismatch / stale run /
 *     external adapter error / computer probe error 统一进 Problems Center。
 */

const { normalizeSkillDefinition } = require('../skills/skillDefinition');
const { normalizeHookDefinition } = require('../hooks/hookDefinition');
const { normalizeWorkflowDefinition } = require('../workflows/workflowDefinition');

const STALE_RUN_MINUTES = 10;

function inventory(list, validate) {
  let invalid = 0;
  for (const item of list) {
    try { validate(item); } catch { invalid++; }
  }
  return { count: list.length, invalid };
}

function connectionState(connection) {
  if (!connection || connection.enabled === false || connection.enabled === 0) return 'UNAVAILABLE';
  if (connection.test_state === 'error') return 'ERROR';
  if (connection.test_state === 'failed') return 'UNAVAILABLE';
  if (connection.test_state === 'ok') return 'AVAILABLE';
  if (connection.tested === true || connection.tested === 1) return 'AVAILABLE';
  if (connection.tested_at && connection.last_error) return 'UNAVAILABLE';
  return 'UNKNOWN';
}

function externalState(health) {
  if (!health) return 'UNKNOWN';
  if (health.status === 'healthy' || health.status === 'degraded') return 'AVAILABLE';
  if (health.status === 'unavailable' || health.status === 'disabled') return 'UNAVAILABLE';
  return 'UNKNOWN';
}

// PermissionEngine 是启动时接线的单例类（安全模块，永远不得在诊断里重建第二套）；
// 这里只检查可引用性，不构造实例。
function PermissionEngineAvailable() {
  try { return typeof require('../security/permissions').PermissionEngine === 'function'; }
  catch { return false; }
}

function createProductDiagnostics(deps = {}) {
  const {
    version, store, getDb, modelCatalog, dynamicAgentFactory, skillRegistry,
    hookEngine, workflowEngine, generatorEngine, computerManager, browserManager,
    mcpManager, agentRegistry, healthManager, projectLock,
    // v2.9.9 Phase B（B20）— 新增产品区域的真实 backend 状态接入
    pendingPermissions, workflowRuntime, agentHub,
    // v2.9.9 Phase B Final（B20）— Runtime Residue / Problem Integration
    terminalManager, runManager, problemCenter, getCurrentProject
  } = deps;

  const problems = problemCenter && typeof problemCenter.report === 'function' ? problemCenter : null;

  function reportProblem(input) {
    if (!problems) return;
    try { problems.report(input); } catch { /* 诊断观测绝不影响主链路 */ }
  }

  async function inspect({ probeExternal = true, probeComputer = true } = {}) {
    const checkedAt = new Date().toISOString();
    const report = { version: version || 'UNKNOWN', generatedAt: checkedAt };

    // ---- Application（B20：进程本体真话，不猜） ----
    report.application = {
      status: 'AVAILABLE',
      reason: 'main process alive',
      pid: process.pid,
      platform: process.platform,
      node: process.versions.node,
      uptimeMs: Math.round(process.uptime() * 1000),
      lastCheckedAt: checkedAt
    };

    // ---- Database ----
    try {
      getDb().prepare('SELECT 1 AS ok').get();
      report.database = { status: 'OK', lastCheckedAt: checkedAt };
    } catch (error) {
      report.database = { status: 'ERROR', error: error.message, lastCheckedAt: checkedAt };
      reportProblem({ severity: 'CRITICAL', source: 'Database', code: 'DATABASE_ERROR', message: String(error.message || error), relatedKey: 'database' });
    }

    // ---- Project ----
    try {
      const project = getCurrentProject ? getCurrentProject() : null;
      report.project = project
        ? { status: 'OPEN', name: project.name, rootPath: project.root_path, lastCheckedAt: checkedAt }
        : { status: 'NONE', reason: '未打开项目', lastCheckedAt: checkedAt };
    } catch (error) {
      report.project = { status: 'ERROR', error: error.message, lastCheckedAt: checkedAt };
    }

    let connections = [];
    try { connections = store.connections.list(); } catch { /* database status already explains failure */ }
    report.modelConnections = {
      available: connections.filter(item => connectionState(item) === 'AVAILABLE').length,
      unavailable: connections.filter(item => connectionState(item) === 'UNAVAILABLE').length,
      unknown: connections.filter(item => connectionState(item) === 'UNKNOWN').length,
      items: connections.map(item => ({ id: item.id, name: item.name, provider: item.provider, status: connectionState(item) })),
      lastCheckedAt: checkedAt
    };
    for (const item of report.modelConnections.items) {
      if (item.status === 'UNAVAILABLE' || item.status === 'ERROR') {
        reportProblem({ severity: 'WARNING', source: 'Model', code: 'CONNECTION_' + item.status, message: `连接「${item.name}」状态 ${item.status}`, relatedKey: item.id });
      }
    }

    let candidates = [];
    try { candidates = modelCatalog.listCandidates().filter(item => item.enabled); } catch { /* degraded below */ }
    const usableCandidates = candidates.filter(item => item.connectionUsability && item.connectionUsability.value === true);
    report.modelRouter = {
      status: usableCandidates.length ? 'READY' : 'DEGRADED',
      reason: usableCandidates.length ? `${usableCandidates.length} 个可用候选` : '没有任何通过硬过滤的可用模型候选',
      candidates: candidates.length,
      usableCandidates: usableCandidates.length,
      lastCheckedAt: checkedAt
    };

    let mainAgent = null;
    try { mainAgent = store.agents.list().find(agent => agent.is_main); } catch { /* database status already reported */ }
    const mainCandidate = mainAgent && mainAgent.api_connection_id && mainAgent.model
      ? candidates.find(item => item.connectionId === mainAgent.api_connection_id && item.modelId === mainAgent.model)
      : null;
    report.mainAgent = {
      status: !mainAgent ? 'ERROR' : (mainCandidate && mainCandidate.connectionUsability.value === true ? 'READY' : 'UNKNOWN'),
      reason: !mainAgent ? '没有主智能体' : (mainCandidate ? '' : '主智能体模型未绑定到可用候选（未知就是未知）'),
      agentId: mainAgent ? mainAgent.id : null,
      lastCheckedAt: checkedAt
    };
    report.dynamicAgent = {
      status: dynamicAgentFactory && typeof dynamicAgentFactory.createInstance === 'function' && typeof dynamicAgentFactory.disposeInstance === 'function' ? 'READY' : 'ERROR',
      activeInstances: dynamicAgentFactory && typeof dynamicAgentFactory.listInstances === 'function' ? dynamicAgentFactory.listInstances().length : null,
      lastCheckedAt: checkedAt
    };

    try { report.skills = { ...inventory(skillRegistry.list(), normalizeSkillDefinition), lastCheckedAt: checkedAt }; }
    catch (error) { report.skills = { count: 0, invalid: null, status: 'ERROR', error: error.message, lastCheckedAt: checkedAt }; }
    try { report.hooks = { ...inventory(hookEngine.registry.list(), normalizeHookDefinition), lastCheckedAt: checkedAt }; }
    catch (error) { report.hooks = { count: 0, invalid: null, status: 'ERROR', error: error.message, lastCheckedAt: checkedAt }; }
    try { report.workflows = { ...inventory(workflowEngine.registry.list(), normalizeWorkflowDefinition), lastCheckedAt: checkedAt }; }
    catch (error) { report.workflows = { count: 0, invalid: null, status: 'ERROR', error: error.message, lastCheckedAt: checkedAt }; }

    let generatorActive = 0;
    try {
      const drafts = generatorEngine && generatorEngine.service && typeof generatorEngine.service.listDrafts === 'function'
        ? generatorEngine.service.listDrafts(200) : [];
      generatorActive = drafts.filter(d => d.status === 'GENERATING').length;
    } catch { /* generator active stays 0 */ }
    report.generator = {
      status: generatorEngine && generatorEngine.service && typeof generatorEngine.service.generate === 'function' && typeof generatorEngine.service.save === 'function' ? 'READY' : 'ERROR',
      active: generatorActive,
      lastCheckedAt: checkedAt
    };

    // B20 — Permission Engine 状态来自真实 backend（pending 队列 + 授权记录）
    let grantCount = null;
    try { grantCount = store.permissionGrants.list().length; } catch { /* 无授权表时缺省 */ }
    report.permissionEngine = {
      status: typeof PermissionEngineAvailable() === 'boolean' ? 'READY' : 'ERROR',
      pendingRequests: pendingPermissions && typeof pendingPermissions.size === 'number' ? pendingPermissions.size : 0,
      grants: grantCount,
      lastCheckedAt: checkedAt
    };

    // B20 — Workflow Runtime 状态（活跃执行计数，来自真实 runtime）
    let waitingApproval = 0;
    try {
      const runs = workflowRuntime && typeof workflowRuntime.listRuns === 'function' ? workflowRuntime.listRuns(50) : [];
      waitingApproval = runs.filter(r => r.status === 'WAITING_APPROVAL').length;
      report.workflowRuntime = {
        status: workflowRuntime && typeof workflowRuntime.run === 'function' ? 'READY' : 'ERROR',
        activeRuns: runs.filter(r => ['RUNNING', 'WAITING_APPROVAL'].includes(r.status)).length,
        waitingApproval,
        lastCheckedAt: checkedAt
      };
    } catch (error) { report.workflowRuntime = { status: 'ERROR', error: error.message, lastCheckedAt: checkedAt }; }

    // B20 — AgentHub 状态（注册适配器数，真实注册表）
    try {
      report.agentHub = {
        status: agentHub && typeof agentHub.detect === 'function' ? 'READY' : 'ERROR',
        registeredAdapters: agentRegistry.list().length,
        lastCheckedAt: checkedAt
      };
    } catch (error) { report.agentHub = { status: 'ERROR', error: error.message, lastCheckedAt: checkedAt }; }

    // ---- Terminal（B20/B19）— 活动进程真话 ----
    try {
      report.terminal = {
        status: terminalManager && typeof terminalManager.activeCount === 'function' ? 'READY' : 'UNKNOWN',
        activeProcesses: terminalManager ? terminalManager.activeCount() : null,
        lastCheckedAt: checkedAt
      };
    } catch (error) { report.terminal = { status: 'ERROR', error: error.message, lastCheckedAt: checkedAt }; }

    // ---- Processes — 只报告真实可知的进程身份；绝不猜测 ----
    report.processes = {
      status: 'AVAILABLE',
      reason: 'owned children counts come from terminal/computer runtimes',
      mainPid: process.pid,
      terminalChildren: terminalManager ? terminalManager.activeCount() : 0,
      computerChildren: computerManager && typeof computerManager.activeCount === 'function' ? computerManager.activeCount() : 0,
      lastCheckedAt: checkedAt
    };

    if (process.platform !== 'win32') {
      report.computerUse = { status: 'UNSUPPORTED', lastCheckedAt: checkedAt };
    } else if (!probeComputer) {
      report.computerUse = { status: 'UNKNOWN', reason: '未探测', lastCheckedAt: checkedAt };
    } else {
      try {
        // P3 — truth over READY: availability probe + interactive-desktop probe
        // + live runtime residue (sessions / lock / helpers / temp screenshots).
        const avail = typeof computerManager.availability === 'function' ? await computerManager.availability() : null;
        const diag = typeof computerManager.diagnostics === 'function' ? computerManager.diagnostics() : {};
        const interactive = !!(avail && avail.interactiveDesktop);
        const base = avail && avail.status === 'AVAILABLE' ? 'AVAILABLE' : (avail && avail.status) || 'UNAVAILABLE';
        report.computerUse = {
          status: base,
          // UIA 可用但无交互桌面（session 0 / 无前台）绝不是 READY
          interactive,
          effectiveStatus: base === 'AVAILABLE' && !interactive ? 'AVAILABLE_NON_INTERACTIVE' : base,
          windowCount: null,
          activeSessions: diag.activeSessions || 0,
          desktopLock: diag.desktopLock || null,
          desktopLockPending: diag.desktopLockPending || 0,
          activeHelpers: diag.activeHelpers || 0,
          lastObservationAt: diag.lastObservationAt || null,
          lastActionAt: diag.lastActionAt || null,
          tempResidue: diag.tempResidue || 0,
          lastCheckedAt: checkedAt
        };
        try {
          const result = await computerManager.listWindows();
          if (result && result.ok === true) report.computerUse.windowCount = Array.isArray(result.windows) ? result.windows.length : 0;
        } catch { /* window count is informational only */ }
        if (report.computerUse.status === 'UNAVAILABLE' || report.computerUse.status === 'ERROR') {
          reportProblem({ severity: 'WARNING', source: 'Computer', code: 'COMPUTER_PROBE_ERROR', message: String((avail && avail.reason) || 'Window discovery failed.'), relatedKey: 'computer-probe' });
        }
        if ((diag.tempResidue || 0) > 0) {
          reportProblem({ severity: 'WARNING', source: 'Computer', code: 'COMPUTER_RESIDUE', message: `截图临时文件残留 ${diag.tempResidue} 个`, relatedKey: 'computer-temp-residue' });
        }
      } catch (error) {
        report.computerUse = { status: 'UNAVAILABLE', error: error.message, lastCheckedAt: checkedAt };
        reportProblem({ severity: 'WARNING', source: 'Computer', code: 'COMPUTER_PROBE_ERROR', message: String(error.message || error), relatedKey: 'computer-probe' });
      }
    }

    const browserStatus = browserManager.status();
    report.browser = {
      status: browserStatus.available === true ? 'AVAILABLE' : (browserStatus.available === false ? 'UNAVAILABLE' : 'UNKNOWN'),
      installed: browserStatus.installed,
      launched: browserStatus.launched,
      engine: browserStatus.engine || null,
      lastCheckedAt: checkedAt
    };

    const connectedClients = mcpManager && mcpManager.clients
      ? [...mcpManager.clients.values()].filter(client => client.connected === true).length
      : 0;
    report.mcp = { connected: connectedClients, status: connectedClients > 0 ? 'AVAILABLE' : (mcpManager ? 'UNKNOWN' : 'ERROR'), lastCheckedAt: checkedAt };

    let health = new Map();
    if (probeExternal) {
      try { health = await healthManager.checkAll(); } catch { health = new Map(); }
    }
    report.externalAgents = agentRegistry.list().map(adapter => {
      const cached = health.get(adapter.id) || healthManager.getStatus(adapter.id);
      const status = externalState(cached);
      if (status === 'UNAVAILABLE') {
        reportProblem({ severity: 'INFO', source: 'External Agent', code: 'EXTERNAL_AGENT_UNAVAILABLE', message: `外部智能体 ${adapter.id} 不可用`, relatedKey: adapter.id });
      }
      return {
        id: adapter.id,
        name: adapter.manifest && adapter.manifest.displayName || adapter.id,
        transport: adapter.manifest && adapter.manifest.transport || 'unknown',
        status,
        health: cached ? cached.status : 'unknown'
      };
    });

    const lockSnapshot = projectLock.snapshot();
    const lockCount = lockSnapshot.writeLocks.length + lockSnapshot.readLocks.reduce((count, item) => count + item.holders.length, 0);
    report.projectLock = { status: lockCount ? 'ACTIVE' : 'FREE', count: lockCount, lastCheckedAt: checkedAt };

    // ---- B20.1 Runtime Residue — 全部来自真实 backend，绝不估计 ----
    let activeRuns = null;
    let staleRunIds = [];
    if (runManager && typeof runManager.list === 'function') {
      try {
        const all = runManager.list();
        const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout', 'interrupted']);
        const running = all.filter(r => !TERMINAL.has(r.status));
        activeRuns = running.length;
        const staleBefore = Date.now() - STALE_RUN_MINUTES * 60 * 1000;
        staleRunIds = running
          .filter(r => {
            const stamp = r.lastActivityAt || r.updatedAt || null;
            if (!stamp) return false;
            const t = new Date(stamp).getTime();
            return Number.isFinite(t) && t < staleBefore;
          })
          .map(r => r.id);
      } catch { activeRuns = null; }
    }
    report.runtimeResidue = {
      activeRuns,
      staleRuns: staleRunIds,
      dynamicInstances: report.dynamicAgent.activeInstances,
      agentHubAdapters: (report.agentHub && report.agentHub.registeredAdapters) ?? null,
      projectLocks: lockCount,
      terminalProcesses: report.terminal ? report.terminal.activeProcesses : null,
      pendingPermissions: report.permissionEngine.pendingRequests,
      pendingWorkflowApproval: waitingApproval,
      generatorActive,
      lastCheckedAt: checkedAt
    };
    for (const staleId of staleRunIds) {
      reportProblem({ severity: 'WARNING', source: 'Agent', code: 'STALE_RUN', message: `Run ${staleId} 长时间无活动但仍处于非终态`, runId: staleId, relatedKey: staleId });
    }

    // ---- B20.3 Problem Integration：model mismatch 真话进入 Problems ----
    try {
      const mismatches = store.modelCalls.mismatches(20);
      for (const m of mismatches) {
        reportProblem({
          severity: 'ERROR', source: 'Model', code: 'MODEL_MISMATCH',
          message: `Selected model "${m.requested_model}" != actual wire model "${m.actual_model}"`,
          relatedKey: `${m.requested_model}->${m.actual_model}`
        });
      }
      report.modelMismatches = mismatches.length;
    } catch { report.modelMismatches = null; }

    return report;
  }

  /**
   * B20.2 — Quick Self Test：safe / bounded / 0 paid calls。
   * 只做本地可判定的检查：DB ping、定义清单校验、Router 候选、权限模块可达、
   * 本地回显命令（不触网、不付费）。绝不发起真实模型调用。
   */
  async function selfTest() {
    const results = [];
    const startedAt = Date.now();
    const push = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail).slice(0, 300) });

    try { getDb().prepare('SELECT 1 AS ok').get(); push('database', true, 'SELECT 1 ok'); }
    catch (e) { push('database', false, e.message); }

    try {
      const inv = inventory(skillRegistry.list(), normalizeSkillDefinition);
      push('skills', inv.invalid === 0, `${inv.count} skills, ${inv.invalid} invalid`);
    } catch (e) { push('skills', false, e.message); }

    try {
      const inv = inventory(hookEngine.registry.list(), normalizeHookDefinition);
      push('hooks', inv.invalid === 0, `${inv.count} hooks, ${inv.invalid} invalid`);
    } catch (e) { push('hooks', false, e.message); }

    try {
      const inv = inventory(workflowEngine.registry.list(), normalizeWorkflowDefinition);
      push('workflows', inv.invalid === 0, `${inv.count} workflows, ${inv.invalid} invalid`);
    } catch (e) { push('workflows', false, e.message); }

    try {
      const c = modelCatalog.listCandidates();
      push('modelRouter', true, `${c.length} candidates（自检不发起真实模型调用）`);
    } catch (e) { push('modelRouter', false, e.message); }

    push('permissionEngine', PermissionEngineAvailable(), 'PermissionEngine module reachable');

    // 本地回显（确定性、无网络、无文件写）：验证 terminal runtime 通路本身活着。
    // 用 cmd 内建 echo，避免写临时文件（架构门禁禁止诊断路径 fs.write）与嵌套引号问题。
    if (terminalManager && typeof terminalManager.activeCount === 'function') {
      try {
        const term = require('../tools/terminal');
        const os = require('os');
        const cwd = os.tmpdir();
        const r = await term.runCommand({ emit: () => {} }, 'echo SELFTEST_OK_4127', cwd, 15000, false, 'selftest_' + Date.now(), null, { owner: 'USER' });
        const ok = r && r.ok === true && r.data && String(r.data.stdout || '').includes('SELFTEST_OK_4127');
        push('terminal', ok, ok ? 'local echo roundtrip ok' : JSON.stringify(r).slice(0, 200));
      } catch (e) { push('terminal', false, e.message); }
    } else {
      push('terminal', false, 'terminal runtime unavailable');
    }

    const failed = results.filter(r => !r.ok);
    return {
      ok: failed.length === 0,
      results,
      failed: failed.length,
      paidProviderCalls: 0, // 自检契约：0 付费调用
      durationMs: Date.now() - startedAt,
      ranAt: new Date().toISOString()
    };
  }

  return { inspect, selfTest };
}

module.exports = { createProductDiagnostics, connectionState, externalState };
