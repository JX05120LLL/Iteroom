import { setTimeout as delay } from 'node:timers/promises'
import { TaskEntryError } from './managed-task-store.js'
import { readReviewPreparation } from './managed-review-snapshot.js'
import { readReviewPlan, saveReviewPlan, readReviewResult, saveReviewResult } from './managed-review-result.js'
import { buildReviewPlan } from './review/inference-plan.js'
import { parseReviewFindings, failedReviewReport } from './review/findings.js'
import { runManagedReview } from './managed-review-runner.js'

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/
const terminal = task => ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)
async function storeAction(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action() }
    catch (error) {
      if (error.code !== 'TASK_STORE_BUSY' || attempt >= 5) throw error
      await delay(10 * (attempt + 1))
    }
  }
}

/** Starts only fixed, budgeted review context. A model candidate is never a test or acceptance result. */
export class ManagedReviewInference {
  constructor(store, { run = runManagedReview, modelKey = async () => process.env.DEEPSEEK_API_KEY,
    preparer, onError = () => {} } = {}) {
    this.store = store; this.run = run; this.modelKey = modelKey; this.preparer = preparer; this.onError = onError
    this.jobs = new Map(); this.starting = new Map(); this.recovery = null; this.disposed = false
  }

  initialize() { this.recovery ??= this.recoverOrphans(); return this.recovery }

  start(taskId, requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return Promise.reject(new TaskEntryError('INVALID_RUN_INPUT', 400))
    const pending = this.starting.get(taskId)
    if (pending) return pending.requestId === requestId ? pending.promise
      : Promise.reject(new TaskEntryError('RUN_ALREADY_STARTED', 409))
    const promise = this.startOnce(taskId, requestId).finally(() => this.starting.delete(taskId))
    this.starting.set(taskId, { requestId, promise })
    return promise
  }

  async startOnce(taskId, requestId) {
    await this.initialize()
    if (this.disposed) throw new TaskEntryError('ENGINE_OWNER_LOST', 503)
    const task = await this.store.get(taskId)
    if (task.kind !== 'review') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
    if (task.status !== 'queued') {
      if (task.startRequestId === requestId) return task
      throw new TaskEntryError('RUN_ALREADY_STARTED', 409)
    }
    if (task.reviewCleanupPending) throw new TaskEntryError('REVIEW_CLEANUP_UNCONFIRMED', 409)
    const preparation = await readReviewPreparation(this.store, taskId), plan = buildReviewPlan(preparation)
    if (!plan.groups.length) throw new TaskEntryError('REVIEW_NO_CONTEXT', 409)
    const key = await this.modelKey()
    if (typeof key !== 'string' || !key) throw new TaskEntryError('MODEL_NOT_CONFIGURED', 503)
    if (this.disposed) throw new TaskEntryError('ENGINE_OWNER_LOST', 503)
    await saveReviewPlan(this.store, taskId, plan)
    const claim = await storeAction(() => this.store.claimReview(taskId, requestId, plan.id))
    if (!claim.created) return claim.task
    const job = { controller: new AbortController(), finishing: false, cancelRequested: false, promise: null }
    this.jobs.set(taskId, job)
    job.promise = Promise.resolve().then(async () => {
      let report, failureCode, status
      try {
        const result = await this.run({ store: this.store, taskId, provider: 'deepseek', model: 'deepseek-flash', modelKey: key,
          signal: job.controller.signal, ...plan.budgets,
          onReady: () => storeAction(() => this.store.markRunning(taskId)) })
        if (job.cancelRequested || job.controller.signal.aborted) throw new TaskEntryError('ENGINE_CANCELLED', 409)
        if (result?.sessionId !== taskId || result.turnEnd !== 'completed') throw new TaskEntryError('REVIEW_OUTPUT_INVALID', 409)
        report = parseReviewFindings(preparation, plan, result.answer, result.readGroupIds)
        status = report.outcome === 'failed' ? 'failed' : 'completed'
        if (status === 'failed') failureCode = 'REVIEW_CONTEXT_INCOMPLETE'
      } catch (error) {
        failureCode = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'ENGINE_FAILED'
        status = job.cancelRequested || job.controller.signal.aborted ? 'cancelled'
          : ['ENGINE_PROCESS_CLOSED', 'ENGINE_RPC_TIMEOUT'].includes(failureCode) ? 'interrupted' : 'failed'
        report = failedReviewReport(preparation, plan, failureCode, status)
      }
      // The runner has settled and disposed its process. Cancellation after this point waits for the receipt.
      job.finishing = true
      const receipt = await saveReviewResult(this.store, taskId, report)
      return storeAction(() => this.store.finishReview(taskId, receipt.id, report.outcome, status, failureCode))
    }).finally(() => this.jobs.delete(taskId))
    void job.promise.catch(error => this.onError(error))
    return claim.task
  }

  async cancel(taskId, requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
    await this.initialize(); await this.starting.get(taskId)?.promise
    const task = await this.store.get(taskId)
    if (task.kind !== 'review') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
    if (terminal(task)) return task
    if (task.status === 'queued') return this.preparer ? this.preparer.cancel(taskId, requestId)
      : this.store.cancelQueuedReview(taskId, requestId)
    const job = this.jobs.get(taskId)
    if (!job) throw new TaskEntryError('ENGINE_OWNER_LOST', 409)
    if (!job.finishing) {
      job.cancelRequested = true
      try { await storeAction(() => this.store.markCancelling(taskId)) }
      catch (error) { if (!terminal(await this.store.get(taskId))) throw error }
      job.controller.abort()
    }
    await job.promise
    return this.store.get(taskId)
  }

  async whenIdle(taskId) {
    await this.starting.get(taskId)?.promise; await this.jobs.get(taskId)?.promise
    return this.store.get(taskId)
  }

  result(taskId) { return readReviewResult(this.store, taskId) }
  async plan(taskId) {
    const task = await this.store.get(taskId)
    return task.reviewPlanId ? readReviewPlan(this.store, taskId) : buildReviewPlan(await readReviewPreparation(this.store, taskId))
  }

  async recoverOrphans() {
    for (const task of await this.store.list()) {
      if (task.kind !== 'review' || !['running', 'cancelling'].includes(task.status)) continue
      let report
      try { report = await readReviewResult(this.store, task.id, true) }
      catch (error) {
        if (error.code !== 'REVIEW_NOT_PREPARED') throw error
        const preparation = await readReviewPreparation(this.store, task.id), plan = await readReviewPlan(this.store, task.id)
        report = await saveReviewResult(this.store, task.id, failedReviewReport(preparation, plan, 'ENGINE_OWNER_LOST', 'interrupted'))
      }
      const status = ['completed', 'partial'].includes(report.outcome) ? 'completed' : report.outcome
      await storeAction(() => this.store.finishReview(task.id, report.id, report.outcome, status,
        status === 'completed' ? undefined : 'ENGINE_OWNER_LOST'))
    }
  }

  async dispose() {
    this.disposed = true
    await Promise.allSettled([...this.starting.values()].map(item => item.promise))
    for (const job of this.jobs.values()) { job.cancelRequested = true; job.controller.abort() }
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise))
  }
}
