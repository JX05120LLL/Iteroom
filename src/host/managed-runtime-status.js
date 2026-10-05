import { createHash } from 'node:crypto'
import { SandboxManager, createDefaultAdapterFactory } from '@alibaba-group/opensandbox'
import { TaskEntryError } from './managed-task-store.js'
import { loadManagedModelKey } from './managed-model-key.js'
import { loadManagedSandboxConfig } from './managed-modify-coordinator.js'

const defaults = { understand: { maxRequests: 3, maxOutputTokens: 256 },
  modify: { maxRequests: 4, maxOutputTokens: 512 }, review: { maxRequests: 4, maxOutputTokens: 512 } }

async function readProbeResponse(response, signal) {
  signal.throwIfAborted()
  if (!response.body) return response
  const reader = response.body.getReader(), chunks = []
  let cancellation
  const cancel = () => cancellation ??= reader.cancel().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  try {
    let size = 0
    while (true) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > 65536) throw new TaskEntryError('SANDBOX_PROBE_OUTPUT_LIMIT', 503)
      chunks.push(value)
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText,
      headers: response.headers })
  } catch (error) { await cancel(); throw error }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock() }
}

/** Read configuration and optionally check the existing loopback service. Never starts a task. */
export class ManagedRuntimeStatus {
  constructor({ projectRoot, modelKey = () => loadManagedModelKey(projectRoot),
    sandboxConfig = () => loadManagedSandboxConfig(projectRoot), budgets = {}, probe, timeoutMs = 2500, env = process.env }) {
    this.modelKey = modelKey; this.sandboxConfig = sandboxConfig
    this.env = env
    this.budgets = Object.fromEntries(Object.entries(defaults).map(([kind, fallback]) => {
      const value = budgets[kind] ?? fallback
      if (!Number.isInteger(value.maxRequests) || value.maxRequests < 1 || value.maxRequests > 4
        || !Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 512) {
        throw new TaskEntryError('RUNTIME_BUDGET_INVALID', 503)
      }
      return [kind, { maxRequests: value.maxRequests, maxOutputTokens: value.maxOutputTokens }]
    }))
    this.runProbe = probe ?? ((config, options) => this.probe(config, undefined, options))
    this.timeoutMs = timeoutMs; this.pendingProbe = null
  }

  async probe(config, sdk = { SandboxManager, createDefaultAdapterFactory },
    { signal = AbortSignal.timeout(this.timeoutMs) } = {}) {
    if (config.connectionConfig.domain !== '127.0.0.1:3088' || config.connectionConfig.protocol !== 'http') {
      throw new TaskEntryError('SANDBOX_CONFIG_INVALID', 503)
    }
    const factory = sdk.createDefaultAdapterFactory?.()
    const adapterFactory = factory ? { createLifecycleStack(options) {
      const fetch = options.connectionConfig.fetch
      return factory.createLifecycleStack({ ...options, connectionConfig: { ...options.connectionConfig,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input)
          const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
          if (url.origin !== 'http://127.0.0.1:3088' || url.pathname !== '/v1/sandboxes' || method !== 'GET') {
            throw new TaskEntryError('SANDBOX_PROBE_SCOPE_DENIED', 503)
          }
          const requestSignals = [signal, init?.signal, input instanceof Request ? input.signal : undefined].filter(Boolean)
          const combined = AbortSignal.any(requestSignals)
          combined.throwIfAborted()
          return readProbeResponse(await fetch(input, { ...init, redirect: 'error', signal: combined }), combined)
        } } })
    } } : undefined
    const manager = sdk.SandboxManager.create({ connectionConfig: { ...config.connectionConfig,
      requestTimeoutSeconds: Math.max(3, Math.floor(this.timeoutMs / 1000) + 1) },
      ...(adapterFactory ? { adapterFactory } : {}) })
    try {
      const result = await manager.listSandboxInfos({ metadata: { 'iteroom-status-probe': 'true' }, page: 1, pageSize: 1 })
      if (!Array.isArray(result?.items)) throw new TaskEntryError('SANDBOX_SERVICE_UNAVAILABLE', 503)
    } finally { await manager.close() }
  }

  check(config) {
    const key = createHash('sha256').update(JSON.stringify([config.connectionConfig, config.image])).digest('hex')
    if (this.pendingProbe?.key === key) return this.pendingProbe.promise
    const pending = { key }
    const controller = new AbortController()
    const work = Promise.resolve().then(() => this.runProbe(config, { signal: controller.signal }))
    const clear = () => { if (this.pendingProbe === pending) this.pendingProbe = null }
    void work.then(clear, clear)
    pending.promise = (async () => {
      let timer
      try {
        await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new TaskEntryError('SANDBOX_SERVICE_TIMEOUT', 503)
            controller.abort(error); reject(error)
          }, this.timeoutMs)
        })])
        return { service: 'available', code: null }
      } catch (error) {
        return { service: 'unavailable', code: controller.signal.aborted
          || error instanceof TaskEntryError && error.code === 'SANDBOX_SERVICE_TIMEOUT'
          ? 'SANDBOX_SERVICE_TIMEOUT' : 'SANDBOX_SERVICE_UNAVAILABLE' }
      } finally {
        clearTimeout(timer)
      }
    })()
    this.pendingProbe = pending
    return pending.promise
  }

  async inspect({ checkSandbox = false } = {}) {
    const model = { provider: 'deepseek-official', model: 'deepseek-flash', status: 'missing', accountVerified: false }
    try {
      if (await this.modelKey()) model.status = 'configured'
      else if (this.env.DEEPSEEK_API_KEY || this.env.ITEROOM_MODEL_KEY_FILE) model.status = 'invalid'
    }
    catch { model.status = 'invalid' }
    const sandbox = { configuration: 'missing', service: 'not_checked', checkedAt: null, code: 'SANDBOX_NOT_CONFIGURED' }
    let config
    try { config = await this.sandboxConfig(); sandbox.configuration = 'configured'; sandbox.code = null }
    catch (error) {
      if (!(error instanceof TaskEntryError) || error.code !== 'SANDBOX_NOT_CONFIGURED'
        || this.env.ITEROOM_SANDBOX_KEY_FILE || this.env.ITEROOM_SANDBOX_IMAGE) {
        sandbox.configuration = 'invalid'; sandbox.code = 'SANDBOX_CONFIG_INVALID'
      }
    }
    if (config && checkSandbox) {
      Object.assign(sandbox, await this.check(config), { checkedAt: new Date().toISOString() })
    }
    return { model, sandbox, budgets: this.budgets, billVerified: false, scope: 'managed-tasks-only' }
  }
}
