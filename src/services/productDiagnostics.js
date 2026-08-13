'use strict';

const { normalizeSkillDefinition } = require('../skills/skillDefinition');
const { normalizeHookDefinition } = require('../hooks/hookDefinition');
const { normalizeWorkflowDefinition } = require('../workflows/workflowDefinition');

function inventory(list, validate) {
  let invalid = 0;
  for (const item of list) {
    try { validate(item); } catch { invalid++; }
  }
  return { count: list.length, invalid };
}

function connectionState(connection) {
  if (!connection || connection.enabled === false || connection.enabled === 0) return 'UNAVAILABLE';
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
    pendingPermissions, workflowRuntime, agentHub
  } = deps;

  async function inspect({ probeExternal = true, probeComputer = true } = {}) {
    const report = { version: version || 'UNKNOWN', generatedAt: new Date().toISOString() };

    try {
      getDb().prepare('SELECT 1 AS ok').get();
      report.database = { status: 'OK' };
    } catch (error) {
      report.database = { status: 'ERROR', error: error.message };
    }

    let connections = [];
    try { connections = store.connections.list(); } catch { /* database status already explains failure */ }
    report.modelConnections = {
      available: connections.filter(item => connectionState(item) === 'AVAILABLE').length,
      unavailable: connections.filter(item => connectionState(item) === 'UNAVAILABLE').length,
      unknown: connections.filter(item => connectionState(item) === 'UNKNOWN').length,
      items: connections.map(item => ({ id: item.id, name: item.name, provider: item.provider, status: connectionState(item) }))
    };

    let candidates = [];
    try { candidates = modelCatalog.listCandidates().filter(item => item.enabled); } catch { /* degraded below */ }
    const usableCandidates = candidates.filter(item => item.connectionUsability && item.connectionUsability.value === true);
    report.modelRouter = { status: usableCandidates.length ? 'READY' : 'DEGRADED', candidates: candidates.length, usableCandidates: usableCandidates.length };

    let mainAgent = null;
    try { mainAgent = store.agents.list().find(agent => agent.is_main); } catch { /* database status already reported */ }
    const mainCandidate = mainAgent && mainAgent.api_connection_id && mainAgent.model
      ? candidates.find(item => item.connectionId === mainAgent.api_connection_id && item.modelId === mainAgent.model)
      : null;
    report.mainAgent = {
      status: !mainAgent ? 'ERROR' : (mainCandidate && mainCandidate.connectionUsability.value === true ? 'READY' : 'UNKNOWN'),
      agentId: mainAgent ? mainAgent.id : null
    };
    report.dynamicAgent = {
      status: dynamicAgentFactory && typeof dynamicAgentFactory.createInstance === 'function' && typeof dynamicAgentFactory.disposeInstance === 'function' ? 'READY' : 'ERROR',
      activeInstances: dynamicAgentFactory && typeof dynamicAgentFactory.listInstances === 'function' ? dynamicAgentFactory.listInstances().length : null
    };

    try { report.skills = inventory(skillRegistry.list(), normalizeSkillDefinition); }
    catch (error) { report.skills = { count: 0, invalid: null, status: 'ERROR', error: error.message }; }
    try { report.hooks = inventory(hookEngine.registry.list(), normalizeHookDefinition); }
    catch (error) { report.hooks = { count: 0, invalid: null, status: 'ERROR', error: error.message }; }
    try { report.workflows = inventory(workflowEngine.registry.list(), normalizeWorkflowDefinition); }
    catch (error) { report.workflows = { count: 0, invalid: null, status: 'ERROR', error: error.message }; }
    report.generator = {
      status: generatorEngine && generatorEngine.service && typeof generatorEngine.service.generate === 'function' && typeof generatorEngine.service.save === 'function' ? 'READY' : 'ERROR'
    };

    // B20 — Permission Engine 状态来自真实 backend（pending 队列 + 授权记录）
    let grantCount = null;
    try { grantCount = store.permissionGrants.list().length; } catch { /* 无授权表时缺省 */ }
    report.permissionEngine = {
      status: typeof PermissionEngineAvailable() === 'boolean' ? 'READY' : 'ERROR',
      pendingRequests: pendingPermissions && typeof pendingPermissions.size === 'number' ? pendingPermissions.size : 0,
      grants: grantCount
    };

    // B20 — Workflow Runtime 状态（活跃执行计数，来自真实 runtime）
    try {
      const runs = workflowRuntime && typeof workflowRuntime.listRuns === 'function' ? workflowRuntime.listRuns(50) : [];
      report.workflowRuntime = {
        status: workflowRuntime && typeof workflowRuntime.run === 'function' ? 'READY' : 'ERROR',
        activeRuns: runs.filter(r => ['RUNNING', 'WAITING_APPROVAL'].includes(r.status)).length,
        waitingApproval: runs.filter(r => r.status === 'WAITING_APPROVAL').length
      };
    } catch (error) { report.workflowRuntime = { status: 'ERROR', error: error.message }; }

    // B20 — AgentHub 状态（注册适配器数，真实注册表）
    try {
      report.agentHub = {
        status: agentHub && typeof agentHub.detect === 'function' ? 'READY' : 'ERROR',
        registeredAdapters: agentRegistry.list().length
      };
    } catch (error) { report.agentHub = { status: 'ERROR', error: error.message }; }

    if (process.platform !== 'win32') {
      report.computerUse = { status: 'UNSUPPORTED' };
    } else if (!probeComputer) {
      report.computerUse = { status: 'UNKNOWN' };
    } else {
      try {
        const result = await computerManager.listWindows();
        report.computerUse = result && result.ok === true
          ? { status: 'AVAILABLE', windowCount: Array.isArray(result.windows) ? result.windows.length : 0 }
          : { status: 'UNAVAILABLE', error: result && result.error || 'Window discovery failed.' };
      } catch (error) {
        report.computerUse = { status: 'UNAVAILABLE', error: error.message };
      }
    }

    const browserStatus = browserManager.status();
    report.browser = {
      status: browserStatus.available === true ? 'AVAILABLE' : (browserStatus.available === false ? 'UNAVAILABLE' : 'UNKNOWN'),
      installed: browserStatus.installed,
      launched: browserStatus.launched,
      engine: browserStatus.engine || null
    };

    const connectedClients = mcpManager && mcpManager.clients
      ? [...mcpManager.clients.values()].filter(client => client.connected === true).length
      : 0;
    report.mcp = { connected: connectedClients };

    let health = new Map();
    if (probeExternal) {
      try { health = await healthManager.checkAll(); } catch { health = new Map(); }
    }
    report.externalAgents = agentRegistry.list().map(adapter => {
      const cached = health.get(adapter.id) || healthManager.getStatus(adapter.id);
      return {
        id: adapter.id,
        name: adapter.manifest && adapter.manifest.displayName || adapter.id,
        transport: adapter.manifest && adapter.manifest.transport || 'unknown',
        status: externalState(cached),
        health: cached ? cached.status : 'unknown'
      };
    });

    const lockSnapshot = projectLock.snapshot();
    const lockCount = lockSnapshot.writeLocks.length + lockSnapshot.readLocks.reduce((count, item) => count + item.holders.length, 0);
    report.projectLock = { status: lockCount ? 'ACTIVE' : 'FREE', count: lockCount };
    return report;
  }

  return { inspect };
}

module.exports = { createProductDiagnostics, connectionState, externalState };
