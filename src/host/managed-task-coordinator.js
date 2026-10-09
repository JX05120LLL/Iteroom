import { TaskEntryError } from './managed-task-store.js'
import { captureManagedSnapshot } from './managed-snapshot.js'
import { runManagedUnderstand } from './managed-engine-runner.js'
import { setTimeout as delay } from 'node:timers/promises'

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/

async function storeAction(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action() }
    catch (error) {
      if (error?.code !== 'TASK_STORE_BUSY' || attempt >= 5) throw error
      await delay(10 * (attempt + 1))
    }
  }
}

/** Owns at most one local read-only engine run per project; task data remains authoritative. */
export class ManagedTaskCoordinator {
  constructor(store, { run = runManagedUnderstand, modelKey = async () => process.env.DEEPSEEK_API_KEY,
    onError = () => {}, engineLimits = {} } = {}) {
    if (!engineLimits || typeof engineLimits !== 'object' || Array.isArray(engineLimits)
      || Object.keys(engineLimits).some(key => key !== 'maxRequests' && key !== 'maxOutputTokens')) {
      throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
    }
    const limits = {
      maxRequests: engineLimits.maxRequests ?? 3,
      maxOutputTokens: engineLimits.maxOutputTokens ?? 256,
    }
    if (!Number.isSafeInteger(limits.maxRequests) || limits.maxRequests < 1 || limits.maxRequests > 4
      || !Number.isSafeInteger(limits.maxOutputTokens) || limits.maxOutputTokens < 1
      || limits.maxOutputTokens > 512) throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
    this.store = store
    this.run = run
    this.modelKey = modelKey
    this.onError = onError
    this.engineLimits = limits
    this.jobs = new Map()
    this.starting = new Map()
    this.cancelling = new Map()
    this.disposed = false
    this.recovery = null
  }

  initialize() {
    this.recovery ??= this.recoverOrphans()
    return this.recovery
  }

  start(taskId, requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      return Promise.reject(new TaskEntryError('INVALID_RUN_INPUT', 400))
    }
    if (this.cancelling.has(taskId)) return Promise.reject(new TaskEntryError('RUN_STATE_CONFLICT', 409))
    const pending = this.starting.get(taskId)
    if (pending) return pending.requestId === requestId ? pending.promise
      : Promise.reject(new TaskEntryError('RUN_ALREADY_STARTED', 409))
    const controller = new AbortController()
    const promise = this.startOnce(taskId, requestId, controller).finally(() => this.starting.delete(taskId))
    this.starting.set(taskId, { requestId, controller, promise })
    return promise
  }

  async startOnce(taskId, requestId, controller) {
    await this.initialize()
    if (this.disposed) throw new TaskEntryError('ENGINE_OWNER_LOST', 503)
    if (controller.signal.aborted) throw new TaskEntryError('ENGINE_CANCELLED', 409)
    const task = await this.store.get(taskId)
    if (task.kind !== 'understand') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
    if (task.status !== 'queued') {
      if (this.jobs.has(taskId) && task.startRequestId === requestId) return task
      throw new TaskEntryError('RUN_ALREADY_STARTED', 409)
    }
    const key = await this.modelKey()
    if (controller.signal.aborted) throw new TaskEntryError('ENGINE_CANCELLED', 409)
    if (typeof key !== 'string' || !key) throw new TaskEntryError('MODEL_NOT_CONFIGURED', 503)
    await captureManagedSnapshot(this.store, taskId)
    if (controller.signal.aborted) throw new TaskEntryError('ENGINE_CANCELLED', 409)
    const claim = await this.store.claimRun(taskId, requestId)
    if (!claim.created) return claim.task
    if (controller.signal.aborted) {
      return storeAction(() => this.store.failRun(taskId, 'ENGINE_CANCELLED', 'cancelled'))
    }
    const job = { controller, promise: null }
    this.jobs.set(taskId, job)
    job.promise = Promise.resolve().then(async () => {
      try {
        if (controller.signal.aborted) throw new TaskEntryError('ENGINE_CANCELLED', 409)
        const result = await this.run({ store: this.store, taskId,
          provider: 'deepseek', model: 'deepseek-flash', modelKey: key, signal: controller.signal,
          ...this.engineLimits,
          onReady: () => storeAction(() => this.store.markRunning(taskId)),
          onText: text => storeAction(() => this.store.appendDraft(taskId, text)) })
        return await storeAction(() => this.store.finishRun(taskId, result))
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
          ? error.code : 'ENGINE_FAILED'
        const status = controller.signal.aborted ? 'cancelled'
          : code === 'ENGINE_PROCESS_CLOSED' || code === 'ENGINE_RPC_TIMEOUT' ? 'interrupted' : 'failed'
        try { return await storeAction(() => this.store.failRun(taskId, code, status)) }
        catch (storeError) { this.onError(storeError); throw storeError }
      } finally { this.jobs.delete(taskId) }
    })
    void job.promise.catch(error => this.onError(error))
    return claim.task
  }

  cancel(taskId, requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      return Promise.reject(new TaskEntryError('INVALID_RUN_INPUT', 400))
    }
    const pending = this.cancelling.get(taskId)
    if (pending) return pending
    const promise = this.cancelOnce(taskId).finally(() => this.cancelling.delete(taskId))
    this.cancelling.set(taskId, promise)
    return promise
  }

  async cancelOnce(taskId) {
    await this.initialize()
    const pending = this.starting.get(taskId)
    if (pending) {
      pending.controller.abort()
      await pending.promise.catch(() => {})
    }
    const task = await this.store.get(taskId)
    if (task.kind !== 'understand') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task
    const job = this.jobs.get(taskId)
    if (!job) {
      if (task.status === 'queued') return storeAction(() => this.store.cancelQueuedUnderstand(taskId))
      if (task.status === 'running' || task.status === 'cancelling') {
        return this.store.failRun(taskId, 'ENGINE_OWNER_LOST', 'interrupted')
      }
      throw new TaskEntryError('RUN_NOT_STARTED', 409)
    }
    await storeAction(() => this.store.markCancelling(taskId))
    job.controller.abort()
    await job.promise
    return this.store.get(taskId)
  }

  async whenIdle(taskId) {
    await this.starting.get(taskId)?.promise
    await this.jobs.get(taskId)?.promise
    return this.store.get(taskId)
  }

  async recoverOrphans() {
    for (const task of await this.store.list()) {
      if (task.kind === 'understand' && (task.status === 'running' || task.status === 'cancelling') && !this.jobs.has(task.id)) {
        await storeAction(() => this.store.failRun(task.id, 'ENGINE_OWNER_LOST', 'interrupted'))
      }
    }
  }

  async dispose() {
    this.disposed = true
    for (const pending of this.starting.values()) pending.controller.abort()
    await Promise.allSettled([...this.starting.values()].map(pending => pending.promise))
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise))
    await Promise.allSettled([...this.cancelling.values()])
  }
}
