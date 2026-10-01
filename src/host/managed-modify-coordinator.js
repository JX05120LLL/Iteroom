import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { Sandbox, SandboxManager } from '@alibaba-group/opensandbox'
import { TaskEntryError } from './managed-task-store.js'
import { captureManagedSnapshot, readManagedSnapshotFile } from './managed-snapshot.js'
import { openManagedSandbox, exportManagedPatch } from './managed-sandbox.js'
import { saveManagedArtifact } from './managed-artifact.js'
import { runManagedModify } from './managed-engine-runner.js'

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/
const sdk = { Sandbox, SandboxManager }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const within = (parent, child) => {
  const part = relative(parent, child)
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

export async function loadManagedSandboxConfig(projectRoot) {
  const keyPath = process.env.ITEROOM_SANDBOX_KEY_FILE
  const image = process.env.ITEROOM_SANDBOX_IMAGE
  if (!isAbsolute(keyPath ?? '') || !/^node@sha256:[0-9a-f]{64}$/.test(image ?? '')) {
    throw new TaskEntryError('SANDBOX_NOT_CONFIGURED', 503)
  }
  let info, actual
  try { info = await lstat(keyPath); actual = await realpath(keyPath) }
  catch { throw new TaskEntryError('SANDBOX_NOT_CONFIGURED', 503) }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096
    || within(await realpath(projectRoot), actual)) throw new TaskEntryError('SANDBOX_CONFIG_UNSAFE', 503)
  const key = (await readFile(actual, 'utf8')).trim()
  if (!key || key.length > 512) throw new TaskEntryError('SANDBOX_NOT_CONFIGURED', 503)
  return { image, key, connectionConfig: { domain: '127.0.0.1:3088', protocol: 'http',
    apiKey: key, useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 15 } }
}

export async function reconcileManagedSandbox({ store, taskId, config, sdk: adapter = sdk }) {
  const task = await store.get(taskId)
  const manager = adapter.SandboxManager.create({ connectionConfig: config.connectionConfig })
  try {
    const list = await manager.listSandboxInfos({ metadata: { 'iteroom-task-id': taskId }, page: 1, pageSize: 10 })
    if (!Array.isArray(list.items) || list.items.length > 1 || list.pagination?.hasNextPage) {
      throw new TaskEntryError('SANDBOX_RECONCILIATION_UNKNOWN', 503)
    }
    const remote = list.items[0]
    if (remote && remote.metadata?.['iteroom-task-id'] !== taskId
      || task.sandboxId && remote && remote.id !== task.sandboxId) {
      throw new TaskEntryError('SANDBOX_OWNER_MISMATCH', 503)
    }
    if (remote) {
      if (!task.sandboxId) await store.recordSandbox(taskId, remote.id)
      await manager.killSandbox(remote.id)
      let gone = false
      for (let attempt = 0; attempt < 40; attempt++) {
        try { await manager.getSandboxInfo(remote.id) }
        catch (error) { if (error.statusCode === 404) { gone = true; break } throw error }
        await delay(100)
      }
      if (!gone) throw new TaskEntryError('SANDBOX_CLEANUP_UNCONFIRMED', 503)
    }
    const current = await store.get(taskId)
    if (current.sandboxId || current.sandboxAllocationPending) await store.markSandboxCleaned(taskId)
  } finally { await manager.close() }
}

/** Owns a single edit attempt. It never applies a patch to the host project. */
export class ManagedModifyCoordinator {
  constructor(store, { open = openManagedSandbox, run = runManagedModify,
    sandboxConfig = () => loadManagedSandboxConfig(store.projectRoot),
    modelKey = async () => process.env.DEEPSEEK_API_KEY,
    reconcile = reconcileManagedSandbox,
    onError = () => {}, engineLimits = { maxRequests: 4, maxOutputTokens: 512 } } = {}) {
    this.store = store; this.open = open; this.run = run
    this.sandboxConfig = sandboxConfig; this.modelKey = modelKey
    this.reconcile = reconcile; this.onError = onError; this.engineLimits = engineLimits
    this.jobs = new Map(); this.recovery = null
  }

  initialize() { this.recovery ??= this.recoverOrphans(); return this.recovery }

  async start(taskId, requestId) {
    await this.initialize()
    if (!REQUEST_ID.test(requestId)) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
    const task = await this.store.get(taskId)
    if (task.kind !== 'modify') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
    if (task.status !== 'queued') {
      if (this.jobs.has(taskId) && task.startRequestId === requestId) return task
      throw new TaskEntryError('RUN_ALREADY_STARTED', 409)
    }
    if (!task.paths.some(path => /\.test\.[cm]?js$/.test(path))
      || !task.paths.some(path => !/\.test\.[cm]?js$/.test(path))) {
      throw new TaskEntryError('SANDBOX_TEST_SCOPE_DENIED', 403)
    }
    const config = await this.sandboxConfig()
    const key = await this.modelKey()
    if (typeof key !== 'string' || !key) throw new TaskEntryError('MODEL_NOT_CONFIGURED', 503)
    await captureManagedSnapshot(this.store, taskId)
    if (task.reviewOrigin && (await readManagedSnapshotFile(this.store, taskId, task.reviewOrigin.path)).sha256 !== task.reviewOrigin.sourceSha256) {
      throw new TaskEntryError('REVIEW_FIX_INPUT_CHANGED', 409)
    }
    const claim = await this.store.claimModify(taskId, requestId)
    if (!claim.created) return claim.task
    const controller = new AbortController()
    const job = { controller, promise: null }
    this.jobs.set(taskId, job)
    job.promise = Promise.resolve().then(async () => {
      let session, cleaned = false
      try {
        session = await this.open({ store: this.store, taskId, sdk, connectionConfig: config.connectionConfig,
          image: config.image })
        if (controller.signal.aborted) throw new TaskEntryError('ENGINE_CANCELLED', 409)
        await this.run({ store: this.store, taskId, sandboxId: session.sandbox.id,
          sandboxKey: config.key, provider: 'deepseek', model: 'deepseek-flash', modelKey: key,
          signal: controller.signal, ...this.engineLimits,
          onReady: () => this.store.markRunning(taskId) })
        const current = await this.store.get(taskId)
        const verification = current.executions?.filter(entry => entry.kind === 'test'
          && ['completed', 'failed'].includes(entry.status)).at(-1)
        if (!verification) throw new TaskEntryError('MODIFY_VERIFICATION_MISSING', 503)
        const artifact = await exportManagedPatch(session)
        const saved = await saveManagedArtifact(this.store, taskId, artifact)
        await session.cleanup(); cleaned = true
        return await this.store.finishModify(taskId, { artifactId: saved.id,
          changeCount: saved.changeCount, verificationId: verification.id })
      } catch (error) {
        this.onError(error)
        try {
          if (session && !cleaned) await session.cleanup()
          else if (!session) await this.reconcile({ store: this.store, taskId, config, sdk })
        } catch (cleanupError) {
          const current = await this.store.get(taskId)
          if (current.sandboxId || current.sandboxAllocationPending) await this.store.markSandboxCleanupPending(taskId)
          this.onError(cleanupError)
        }
        const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code ?? '') ? error.code : 'MODIFY_FAILED'
        const current = await this.store.get(taskId)
        const status = current.sandboxStatus === 'cleanup_pending' || code === 'SANDBOX_EXECUTION_UNKNOWN'
          ? 'interrupted' : controller.signal.aborted ? 'cancelled' : 'failed'
        return await this.store.failRun(taskId, code, status)
      } finally { this.jobs.delete(taskId) }
    })
    void job.promise.catch(error => this.onError(error))
    return claim.task
  }

  async cancel(taskId, requestId) {
    await this.initialize()
    if (!REQUEST_ID.test(requestId)) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
    const task = await this.store.get(taskId)
    if (task.kind !== 'modify') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
    if (task.status === 'queued') return this.store.cancelQueuedModify(taskId)
    if (!['running', 'cancelling'].includes(task.status)) return task
    const job = this.jobs.get(taskId)
    if (!job) {
      try { await this.reconcile({ store: this.store, taskId,
        config: await this.sandboxConfig(), sdk }) }
      catch (error) {
        if (task.sandboxId || task.sandboxAllocationPending) await this.store.markSandboxCleanupPending(taskId)
        this.onError(error)
      }
      return this.store.failRun(taskId, 'SANDBOX_OWNER_LOST', 'interrupted')
    }
    await this.store.markCancelling(taskId)
    job.controller.abort()
    await job.promise
    return this.store.get(taskId)
  }

  async whenIdle(taskId) { await this.jobs.get(taskId)?.promise; return this.store.get(taskId) }

  async reconcileTask(taskId, requestId) {
    await this.initialize()
    if (!REQUEST_ID.test(requestId)) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
    const task = await this.store.get(taskId)
    if (task.kind !== 'modify' || task.sandboxStatus !== 'cleanup_pending') {
      throw new TaskEntryError('SANDBOX_STATE_CONFLICT', 409)
    }
    await this.reconcile({ store: this.store, taskId,
      config: await this.sandboxConfig(), sdk })
    return this.store.get(taskId)
  }

  async recoverOrphans() {
    for (const task of await this.store.list()) {
      if (task.kind !== 'modify' || !['running', 'cancelling'].includes(task.status)
        && task.sandboxStatus !== 'cleanup_pending'
        || this.jobs.has(task.id)) continue
      try { await this.reconcile({ store: this.store, taskId: task.id,
        config: await this.sandboxConfig(), sdk }) }
      catch (error) {
        if (task.sandboxId || task.sandboxAllocationPending) await this.store.markSandboxCleanupPending(task.id)
        this.onError(error)
      }
      if (['running', 'cancelling'].includes(task.status)) {
        await this.store.failRun(task.id, 'SANDBOX_OWNER_LOST', 'interrupted')
      }
    }
  }

  async dispose() {
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise))
  }
}
