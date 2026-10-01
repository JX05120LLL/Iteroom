import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep, isAbsolute } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'
import { reviewSelection } from './review/selection.js'
import { verifyExecutable } from './review/ocr-cli.js'
import { controlledEnv } from './review/ocr-process.js'
import { createFixedReviewCopy } from './review/fixed-review-copy.js'
import { prepareReviewDelegate } from './review/delegate.js'
import { readReviewPreparation, saveReviewPreparation } from './managed-review-snapshot.js'

function request(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'input,requestId'
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(value.requestId)) {
    throw new TaskEntryError('INVALID_REVIEW_INPUT', 400)
  }
  try { return { requestId: value.requestId, input: reviewSelection(value.input) } }
  catch { throw new TaskEntryError('INVALID_REVIEW_INPUT', 400) }
}
function safeError(error) {
  if (error instanceof TaskEntryError) return error
  const code = typeof error.code === 'string' && /^[a-z_]{1,60}$/.test(error.code)
    ? `REVIEW_${error.code.toUpperCase()}` : 'REVIEW_PREPARATION_FAILED'
  return new TaskEntryError(code, ['REVIEW_CLI_UNAVAILABLE', 'REVIEW_PLATFORM_UNVERIFIED'].includes(code) ? 503 : 409)
}

export class ManagedReviewCoordinator {
  constructor(store, { executable = () => process.env.ITEROOM_OCR_BIN,
    verify = verifyExecutable, delegate = prepareReviewDelegate } = {}) {
    this.store = store; this.executable = executable; this.verify = verify; this.delegate = delegate
    this.pending = new Map()
  }

  async prepare(value, { recheckOrigin, verifyInput } = {}) {
    const input = request(value), key = JSON.stringify({ ...input, recheckOrigin })
    const previous = this.pending.get(input.requestId)
    if (previous) {
      if (previous.key !== key) throw new TaskEntryError('REQUEST_ID_CONFLICT', 409)
      return previous.promise
    }
    const owned = { key }
    this.pending.set(input.requestId, owned)
    owned.promise = this.#prepare(input, owned, { recheckOrigin, verifyInput }).finally(() => this.pending.delete(input.requestId))
    return owned.promise
  }

  async #prepare(value, owned, { recheckOrigin, verifyInput }) {
    let sourceHome, copy
    try {
      const receipt = await this.store.create({ requestId: value.requestId, kind: 'review', objective: '审查变更',
        paths: [], reviewInput: value.input }, recheckOrigin ? { recheckOrigin } : {})
      owned.taskId = receipt.task.id
      if (receipt.task.status !== 'queued') throw new TaskEntryError('REVIEW_STATE_CONFLICT', 409)
      if (receipt.task.reviewCleanupPending) throw new TaskEntryError('REVIEW_CLEANUP_UNCONFIRMED', 409)
      let preparation
      try { preparation = await readReviewPreparation(this.store, receipt.task.id, true) }
      catch (error) { if (error.code !== 'REVIEW_NOT_PREPARED') throw error }
      if (!preparation) {
        const location = await this.store.location(), executable = await this.executable()
        if (!isAbsolute(executable ?? '')) throw new TaskEntryError('REVIEW_CLI_UNAVAILABLE', 503)
        const part = relative(location.project, executable)
        if (part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)) {
          throw new TaskEntryError('REVIEW_CLI_LOCATION_UNSAFE', 503)
        }
        await this.verify(executable)
        sourceHome = await mkdtemp(join(tmpdir(), 'iteroom-r4-source-'))
        const home = join(sourceHome, 'home')
        await mkdir(home); await mkdir(join(home, 'hooks'))
        copy = await createFixedReviewCopy({ repository: location.project, productRoot: location.project, home,
          options: { cwd: location.project, env: controlledEnv(home), timeoutMs: 10000, maxOutputBytes: 1024 * 1024 } }, value.input)
        const delegate = await this.delegate({ executable, copy })
        await copy.verify()
        await verifyInput?.(copy.record)
        preparation = await saveReviewPreparation(this.store, receipt.task.id, copy.record, delegate)
      }
      await verifyInput?.(preparation.input)
      const task = await this.store.attachReviewPreparation(receipt.task.id, preparation.id)
      return { created: receipt.created, task, preparation }
    } catch (error) {
      const safe = safeError(error)
      if (owned.taskId && (await this.store.get(owned.taskId)).status === 'queued') {
        await this.store.failReviewPreparation(owned.taskId, /^REVIEW_[A-Z_]{1,60}$/.test(safe.code) ? safe.code : 'REVIEW_PREPARATION_FAILED',
          safe.code === 'REVIEW_TERMINATION_UNCONFIRMED' || safe.code === 'REVIEW_CLEANUP_UNCONFIRMED')
      }
      throw safe
    }
    finally {
      let cleanupFailed = false
      try { await copy?.dispose() } catch { cleanupFailed = true }
      try {
        if (sourceHome) {
          const temp = await realpath(tmpdir()), actual = await realpath(sourceHome)
          const part = relative(temp, actual)
          if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
            throw new TaskEntryError('REVIEW_LOCATION_UNSAFE', 503)
          }
          await rm(actual, { recursive: true, force: true })
        }
      } catch { cleanupFailed = true }
      if (cleanupFailed && owned.taskId) {
        await this.store.failReviewPreparation(owned.taskId, 'REVIEW_CLEANUP_UNCONFIRMED', true)
        throw new TaskEntryError('REVIEW_CLEANUP_UNCONFIRMED', 503)
      }
    }
  }

  preparation(taskId) { return readReviewPreparation(this.store, taskId) }

  async cancel(taskId, requestId) {
    for (const owned of this.pending.values()) {
      if (owned.taskId === taskId) {
        try { await owned.promise } catch { /* preparation failure also finishes its local cleanup */ }
      }
    }
    return this.store.cancelQueuedReview(taskId, requestId)
  }

  async dispose() { await Promise.allSettled([...this.pending.values()].map(owned => owned.promise)) }
}
