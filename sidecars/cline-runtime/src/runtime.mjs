import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { safeError, sanitize } from './sanitizer.mjs'

const require = createRequire(import.meta.url)
const SDK_VERSION = '0.0.72'
const TOOL_NAMES = Object.freeze({
  read: ['read_files', 'search_codebase'],
  write: ['editor', 'apply_patch'],
  terminal: ['run_commands'],
  network: ['fetch_web_content']
})

function runtimeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function canonicalDirectory(value, code = 'CLINE_WORKSPACE_INVALID') {
  if (typeof value !== 'string' || !value.trim()) throw runtimeError(code, 'projectRoot is required')
  let canonical
  try {
    canonical = fs.realpathSync.native(value)
  } catch (error) {
    throw runtimeError(code, `projectRoot is not a readable directory: ${error.message}`)
  }
  if (!fs.statSync(canonical).isDirectory()) throw runtimeError(code, 'projectRoot must be a directory')
  return canonical
}

function assertAuthorizedWorkspace(projectRoot, authorizedProjectRoot) {
  const requested = canonicalDirectory(projectRoot)
  const authorized = canonicalDirectory(authorizedProjectRoot || projectRoot, 'CLINE_AUTHORIZED_WORKSPACE_INVALID')
  if (normalizePathForCompare(requested) !== normalizePathForCompare(authorized)) {
    throw runtimeError('CLINE_WORKSPACE_MISMATCH', 'Requested projectRoot does not match the parent-authorized projectRoot')
  }
  return requested
}

function buildToolPolicies(allowedScopes) {
  const scopes = new Set(Array.isArray(allowedScopes) ? allowedScopes.filter(value => typeof value === 'string') : [])
  const policies = { '*': { enabled: false, autoApprove: false } }
  const enable = names => names.forEach(name => { policies[name] = { enabled: true, autoApprove: true } })
  if (scopes.has('filesystem.read')) enable(TOOL_NAMES.read)
  if (scopes.has('filesystem.write')) enable(TOOL_NAMES.write)
  if (scopes.has('terminal.read') || scopes.has('terminal.write')) enable(TOOL_NAMES.terminal)
  if (scopes.has('network')) enable(TOOL_NAMES.network)
  return policies
}

function toolNameFromEvent(event) {
  return typeof event?.toolName === 'string' ? event.toolName : ''
}

function changedPathFromEvent(event, workspace) {
  const name = toolNameFromEvent(event)
  if (name !== 'editor' && name !== 'apply_patch') return null
  const candidates = [event.input?.path, event.input?.filePath, event.input?.file_path]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const absolute = path.resolve(workspace, candidate)
    const relative = path.relative(workspace, absolute)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return absolute
  }
  return null
}

function readInstalledSdkVersion() {
  try {
    const entry = require.resolve('@cline/sdk')
    let cursor = path.dirname(entry)
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(cursor, 'package.json')
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (pkg.name === '@cline/sdk') return pkg.version || null
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  } catch {}
  return null
}

function terminalTypeFromResult(result, cancelReason) {
  if (cancelReason === 'timeout') return 'run.timeout'
  if (cancelReason) return 'run.cancelled'
  const finish = result?.finishReason || result?.status || result?.reason
  if (finish === 'aborted' || finish === 'cancelled') return 'run.cancelled'
  if (finish === 'failed' || result?.error) return 'run.failed'
  if (finish === 'completed' || finish === 'done' || typeof result?.text === 'string' || typeof result?.outputText === 'string') return 'run.result'
  return 'run.failed'
}

export class ClineRuntime {
  constructor({ emit, dataDir } = {}) {
    this.emit = emit || (() => {})
    this.dataDir = dataDir || process.env.CLINE_DATA_DIR || null
    this.sdk = null
    this.active = null
  }

  async loadSdk() {
    if (this.sdk) return this.sdk
    const sdk = await import('@cline/sdk')
    if (!sdk || typeof sdk.ClineCore?.create !== 'function') {
      throw runtimeError('CLINE_SDK_API_MISMATCH', '@cline/sdk does not export a usable ClineCore')
    }
    const installedVersion = readInstalledSdkVersion()
    if (installedVersion && installedVersion !== SDK_VERSION) {
      throw runtimeError('CLINE_SDK_VERSION_MISMATCH', `Expected @cline/sdk ${SDK_VERSION}, found ${installedVersion}`)
    }
    if (this.dataDir && typeof sdk.setClineDir === 'function') {
      sdk.setClineDir(this.dataDir)
    }
    this.sdk = sdk
    return sdk
  }

  async probe() {
    const major = Number(process.versions.node.split('.')[0])
    if (!Number.isInteger(major) || major < 22) throw runtimeError('CLINE_NODE_VERSION_UNSUPPORTED', 'Cline runtime requires Node 22 or newer')
    const sdk = await this.loadSdk()
    const core = await sdk.ClineCore.create({
      clientName: 'agent-dev-platform-probe',
      backendMode: 'local',
      capabilities: { requestToolApproval: async () => ({ approved: false, reason: 'Health probe never approves tools' }) }
    })
    try {
      return {
        ok: true,
        runtime: 'ClineCore',
        nodeVersion: process.versions.node,
        clineSdkVersion: readInstalledSdkVersion() || SDK_VERSION,
        coreConstructible: true,
        networkCall: false
      }
    } finally {
      await core.dispose('agent_dev_platform_probe').catch(() => {})
    }
  }

  async run(requestId, runId, payload) {
    if (typeof requestId !== 'string' || !requestId || typeof runId !== 'string' || !runId) {
      throw runtimeError('CLINE_PROTOCOL_ERROR', 'run.start requires requestId and runId')
    }
    if (this.active) throw runtimeError('CLINE_AGENT_BUSY', 'Cline sidecar accepts one active run')
    const workspace = assertAuthorizedWorkspace(payload?.projectRoot, payload?.authorizedProjectRoot)
    const sdk = await this.loadSdk()
    const sessionId = typeof sdk.createSessionId === 'function' ? sdk.createSessionId() : `adp-${crypto.randomUUID()}`
    const toolPolicies = buildToolPolicies(payload?.allowedScopes)
    const changedFiles = new Set()
    const toolInputs = new Map()
    const active = {
      requestId,
      runId,
      sessionId,
      core: null,
      unsubscribe: null,
      cancelReason: null,
      terminalSent: false,
      timer: null,
      credentials: {
        apiKey: payload?.apiKey,
        headers: payload?.headers
      }
    }
    this.active = active
    this.emit('run.started', { requestId, runId, payload: { sessionId, workspace } })

    try {
      const core = await sdk.ClineCore.create({
        clientName: 'agent-dev-platform',
        backendMode: 'local',
        toolPolicies,
        capabilities: {
          requestToolApproval: async request => {
            const policy = toolPolicies[request?.toolName] || toolPolicies['*']
            return policy?.enabled && policy?.autoApprove
              ? { approved: true }
              : { approved: false, reason: 'Blocked by Agent Dev Platform parent-run policy' }
          }
        }
      })
      active.core = core
      active.unsubscribe = core.subscribe(event => {
        const eventSessionId = event?.payload?.sessionId
        if (eventSessionId && eventSessionId !== sessionId) return
        const agentEvent = event?.type === 'agent_event' ? event.payload?.event : null
        if (agentEvent?.type === 'content_start' && agentEvent.contentType === 'tool' && agentEvent.toolCallId) {
          toolInputs.set(agentEvent.toolCallId, agentEvent)
        }
        if (agentEvent?.type === 'content_end' && agentEvent.contentType === 'tool' && !agentEvent.error) {
          const startedTool = toolInputs.get(agentEvent.toolCallId) || agentEvent
          const changedPath = changedPathFromEvent(startedTool, workspace)
          if (changedPath) changedFiles.add(changedPath)
          if (agentEvent.toolCallId) toolInputs.delete(agentEvent.toolCallId)
        }
        this.emit('run.event', { runId, payload: { event: sanitize(event) } })
      }, { sessionId })

      const timeoutMs = Number(payload?.timeoutMs)
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        active.timer = setTimeout(() => { void this.cancel(runId, 'timeout') }, timeoutMs)
      }

      const started = await core.start({
        interactive: false,
        prompt: String(payload?.prompt || ''),
        config: {
          sessionId,
          providerId: String(payload?.providerId || ''),
          modelId: String(payload?.modelId || ''),
          apiKey: active.credentials.apiKey,
          baseUrl: typeof payload?.baseUrl === 'string' ? payload.baseUrl : undefined,
          headers: active.credentials.headers && typeof active.credentials.headers === 'object' ? active.credentials.headers : undefined,
          cwd: workspace,
          workspaceRoot: workspace,
          systemPrompt: typeof payload?.systemPrompt === 'string' ? payload.systemPrompt : '',
          mode: 'act',
          maxIterations: Number.isInteger(payload?.maxIterations) ? payload.maxIterations : 50,
          enableTools: true,
          enableSpawnAgent: false,
          enableAgentTeams: false,
          disableMcpSettingsTools: !(Array.isArray(payload?.allowedScopes) && payload.allowedScopes.includes('mcp'))
        },
        toolPolicies
      })

      const manifestCwd = canonicalDirectory(started?.manifest?.cwd || workspace)
      const manifestRoot = canonicalDirectory(started?.manifest?.workspace_root || workspace)
      if (normalizePathForCompare(manifestCwd) !== normalizePathForCompare(workspace) || normalizePathForCompare(manifestRoot) !== normalizePathForCompare(workspace)) {
        throw runtimeError('CLINE_WORKSPACE_MISMATCH', 'Cline resolved a workspace different from the authorized projectRoot')
      }

      const result = started?.result
      const terminalType = terminalTypeFromResult(result, active.cancelReason)
      const resultPayload = {
        sessionId: started?.sessionId || sessionId,
        manifest: sanitize(started?.manifest),
        result: sanitize({
          status: result?.status,
          finishReason: result?.finishReason,
          text: result?.text,
          outputText: result?.outputText,
          iterations: result?.iterations,
          usage: result?.usage,
          error: result?.error,
          changedFiles: [...changedFiles]
        }),
        provenance: {
          adapter: 'cline',
          runtime: 'ClineCore Sidecar',
          nodeVersion: process.versions.node,
          sdkVersion: readInstalledSdkVersion() || SDK_VERSION,
          sessionId: started?.sessionId || sessionId,
          upstreamCommit: 'b3cee3f973ffe9d023a10c5c414deba68cd6e09d'
        }
      }
      if (terminalType === 'run.failed' && !resultPayload.result?.error) {
        resultPayload.error = { code: 'CLINE_RESULT_INVALID', message: 'ClineCore returned no explicit successful terminal result' }
      }
      this.sendTerminal(terminalType, active, resultPayload)
      return resultPayload
    } catch (error) {
      const terminalType = active.cancelReason === 'timeout' ? 'run.timeout' : active.cancelReason ? 'run.cancelled' : 'run.failed'
      this.sendTerminal(terminalType, active, { error: safeError(error), sessionId })
      return null
    } finally {
      if (active.timer) clearTimeout(active.timer)
      active.unsubscribe?.()
      if (active.core) {
        await active.core.stop(sessionId).catch(() => {})
        await active.core.dispose('agent_dev_platform_run_complete').catch(() => {})
      }
      active.credentials.apiKey = undefined
      active.credentials.headers = undefined
      if (payload && typeof payload === 'object') {
        payload.apiKey = undefined
        payload.headers = undefined
      }
      if (this.active === active) this.active = null
    }
  }

  sendTerminal(type, active, payload) {
    if (active.terminalSent) return false
    active.terminalSent = true
    this.emit(type, { requestId: active.requestId, runId: active.runId, payload: sanitize(payload) })
    return true
  }

  async cancel(runId, reason = 'user_cancel') {
    const active = this.active
    if (!active || active.runId !== runId) return false
    if (!active.cancelReason) {
      active.cancelReason = ['timeout', 'user_cancel', 'parent_cancel', 'shutdown'].includes(reason)
        ? reason
        : 'user_cancel'
    }
    if (active.core) await active.core.abort(active.sessionId, new Error(active.cancelReason)).catch(() => {})
    return true
  }

  async shutdown() {
    const active = this.active
    if (active) {
      active.cancelReason ||= 'shutdown'
      await active.core?.abort(active.sessionId, new Error('runtime shutdown')).catch(() => {})
      await active.core?.stop(active.sessionId).catch(() => {})
      await active.core?.dispose('agent_dev_platform_shutdown').catch(() => {})
      active.credentials.apiKey = undefined
      active.credentials.headers = undefined
      this.active = null
    }
  }
}
