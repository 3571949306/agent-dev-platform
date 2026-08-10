import { ClineRuntime } from './runtime.mjs'
import { createMessage, encodeMessage, JsonlDecoder, PROTOCOL_VERSION } from './protocol.mjs'
import { installConsoleRedirect, safeError, sanitize } from './sanitizer.mjs'

installConsoleRedirect()

function send(type, fields = {}) {
  try {
    process.stdout.write(encodeMessage(createMessage(type, sanitize(fields))))
  } catch (error) {
    process.stderr.write(`${JSON.stringify(safeError(error, 'CLINE_PROTOCOL_WRITE_FAILED'))}\n`)
    process.exitCode = 1
  }
}

const runtime = new ClineRuntime({
  dataDir: process.env.CLINE_DATA_DIR,
  emit: (type, fields) => send(type, fields)
})

let shuttingDown = false

async function handle(message) {
  switch (message.type) {
    case 'hello':
      send('hello.ok', {
        requestId: message.requestId,
        payload: { protocol: PROTOCOL_VERSION, nodeVersion: process.versions.node, clineSdkVersion: '0.0.72', runtime: 'ClineCore' }
      })
      return
    case 'runtime.probe': {
      try {
        const result = await runtime.probe()
        send('runtime.probe', { requestId: message.requestId, payload: result })
      } catch (error) {
        send('runtime.error', { requestId: message.requestId, payload: { error: safeError(error) } })
      }
      return
    }
    case 'run.start':
      void runtime.run(message.requestId, message.runId, message.payload || {}).catch(error => {
        send('run.failed', { requestId: message.requestId, runId: message.runId, payload: { error: safeError(error) } })
      })
      return
    case 'run.cancel': {
      const cancelled = await runtime.cancel(message.runId, message.payload?.reason)
      if (!cancelled) send('runtime.error', { requestId: message.requestId, runId: message.runId, payload: { error: { code: 'CLINE_RUN_NOT_FOUND', message: 'No active Cline run matches runId' } } })
      return
    }
    case 'runtime.shutdown':
      if (shuttingDown) return
      shuttingDown = true
      await runtime.shutdown()
      send('runtime.goodbye', { requestId: message.requestId, payload: { ok: true } })
      process.exit(0)
      return
    default:
      send('runtime.error', { requestId: message.requestId, runId: message.runId, payload: { error: { code: 'CLINE_PROTOCOL_UNKNOWN_MESSAGE', message: `Unknown message type: ${message.type}` } } })
  }
}

const decoder = new JsonlDecoder({
  onMessage: message => { void handle(message).catch(error => send('runtime.error', { requestId: message.requestId, runId: message.runId, payload: { error: safeError(error) } })) },
  onWarning: (error, count) => process.stderr.write(`[protocol warning ${count}] ${safeError(error).message}\n`),
  onFatal: error => {
    send('runtime.error', { payload: { error: safeError(error, 'CLINE_PROTOCOL_ERROR') } })
    void runtime.shutdown().finally(() => process.exit(1))
  }
})

process.stdin.on('data', chunk => decoder.push(chunk))
process.stdin.on('end', () => { decoder.end(); void runtime.shutdown().finally(() => process.exit(0)) })
process.stdin.on('error', error => { process.stderr.write(`${safeError(error).message}\n`); void runtime.shutdown().finally(() => process.exit(1)) })
process.once('SIGTERM', () => { void runtime.shutdown().finally(() => process.exit(0)) })
process.once('SIGINT', () => { void runtime.shutdown().finally(() => process.exit(130)) })

function terminateAfterFatal(kind, error) {
  const safe = safeError(error)
  // stderr is diagnostic-only, bounded by the parent manager, and safeError
  // removes credential-shaped values before they can reach CI or crash logs.
  process.stderr.write(`[${kind}] ${safe.code}: ${safe.message}\n`)
  send('runtime.error', { payload: { error: safe } })
  void runtime.shutdown().finally(() => process.exit(1))
}

process.on('uncaughtException', error => terminateAfterFatal('uncaughtException', error))
process.on('unhandledRejection', error => terminateAfterFatal('unhandledRejection', error))

send('hello.ok', {
  payload: { protocol: PROTOCOL_VERSION, nodeVersion: process.versions.node, clineSdkVersion: '0.0.72', runtime: 'ClineCore' }
})
