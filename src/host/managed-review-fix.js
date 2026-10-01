import { TaskEntryError, validateManagedTaskInput } from './managed-task-store.js'
import { readManagedProjectFile } from './managed-read-scope.js'
import { captureManagedSnapshot, readManagedSnapshotFile } from './managed-snapshot.js'
import { readReviewPreparation } from './managed-review-snapshot.js'
import { readReviewResult } from './managed-review-result.js'
import { readManagedArtifact } from './managed-artifact.js'
import { ManagedReviewCoordinator } from './managed-review-coordinator.js'

const requestId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value)
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected
const deny = (code, status = 409) => { throw new TaskEntryError(code, status) }
const testTarget = path => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path)

/** Links existing product workflows. Creating a link never starts a model or an execution. */
export class ManagedReviewFix {
  constructor(store, { preparer = new ManagedReviewCoordinator(store) } = {}) {
    this.store = store; this.preparer = preparer; this.pending = new Map()
  }

  #once(value, action) {
    const key = JSON.stringify(value), previous = this.pending.get(value.requestId)
    if (previous) {
      if (previous.key !== key) deny('REQUEST_ID_CONFLICT')
      return previous.promise
    }
    const owned = { key, action: value.action }
    this.pending.set(value.requestId, owned)
    owned.promise = Promise.resolve().then(action).finally(() => this.pending.delete(value.requestId))
    return owned.promise
  }

  async create(value) {
    if (!keys(value, 'findingId,objective,requestId,taskId,testPaths') || !requestId(value.requestId)
      || typeof value.findingId !== 'string' || !/^[0-9a-f]{64}$/.test(value.findingId)
      || !Array.isArray(value.testPaths) || value.testPaths.length < 1 || value.testPaths.length > 15
      || value.testPaths.some(path => typeof path !== 'string' || !/\.test\.[cm]?js$/.test(path))) deny('INVALID_REVIEW_FIX_INPUT', 400)
    const input = { taskId: value.taskId, findingId: value.findingId, requestId: value.requestId, objective: value.objective, testPaths: [...value.testPaths] }
    return this.#once({ action: 'fix', ...input }, async () => {
      const review = await this.store.get(input.taskId)
      if (review.kind !== 'review' || review.status !== 'completed' || !['completed', 'partial'].includes(review.reviewOutcome)) deny('REVIEW_FIX_UNSUPPORTED')
      const report = await readReviewResult(this.store, review.id)
      const preparation = await readReviewPreparation(this.store, review.id)
      const finding = report.findings.find(item => item.id === input.findingId)
      const entry = finding && preparation.input.entries.find(item => item.new?.path === finding.sourcePath)
      if (!finding || finding.location !== 'located' || finding.side !== 'new' || entry?.status !== 'modified'
        || testTarget(finding.sourcePath)) deny('REVIEW_FIX_UNSUPPORTED')
      const taskInput = validateManagedTaskInput({ requestId: input.requestId, kind: 'modify', objective: input.objective,
        paths: [finding.sourcePath, ...input.testPaths] })
      const reviewOrigin = { reviewTaskId: review.id, preparationId: preparation.id, reportId: report.id,
        findingId: finding.id, path: finding.sourcePath, sourceSha256: finding.sourceSha256 }
      const previous = (await this.store.list()).find(task => task.requestId === input.requestId)
      if (!previous) {
        const { project } = await this.store.location()
        for (const path of taskInput.paths) {
          const current = await readManagedProjectFile(project, path)
          if (path === finding.sourcePath && current.sha256 !== finding.sourceSha256) deny('REVIEW_FIX_INPUT_CHANGED')
        }
      }
      const receipt = await this.store.create(taskInput, { reviewOrigin })
      if (!receipt.task.snapshotId && receipt.task.status !== 'queued') deny('REVIEW_FIX_PREPARATION_FAILED')
      await captureManagedSnapshot(this.store, receipt.task.id)
      if ((await readManagedSnapshotFile(this.store, receipt.task.id, finding.sourcePath)).sha256 !== finding.sourceSha256) deny('REVIEW_FIX_INPUT_CHANGED')
      return { created: receipt.created, task: await this.store.get(receipt.task.id) }
    })
  }

  async recheck(value) {
    if (!keys(value, 'requestId,taskId') || !requestId(value.requestId)) deny('INVALID_REVIEW_FIX_INPUT', 400)
    const input = { taskId: value.taskId, requestId: value.requestId }
    return this.#once({ action: 'recheck', ...input }, async () => {
      const task = await this.store.get(input.taskId)
      const recheckOrigin = { modifyTaskId: task.id, artifactId: task.artifactId }
      const previous = (await this.store.list()).find(item => item.requestId === input.requestId)
      if (previous) {
        if (previous.recheckOrigin?.modifyTaskId !== task.id || previous.recheckOrigin?.artifactId !== task.artifactId) deny('REQUEST_ID_CONFLICT')
        if (previous.reviewSnapshotId) return { created: false, task: previous, preparation: await readReviewPreparation(this.store, previous.id) }
      }
      if (task.kind !== 'modify' || task.status !== 'completed' || !task.reviewOrigin || !task.artifactId
        || task.acceptance?.mode !== 'accept' || task.acceptance.entries.some(entry => entry.state !== 'written')) deny('REVIEW_RECHECK_NOT_ACCEPTED')
      const artifact = await readManagedArtifact(this.store, task.id, task.artifactId)
      const expected = new Map()
      const { project } = await this.store.location()
      for (const path of task.paths) {
        const snapshot = await readManagedSnapshotFile(this.store, task.id, path)
        const sha = artifact.changes.find(change => change.path === path)?.afterSha256 ?? snapshot.sha256
        if ((await readManagedProjectFile(project, path)).sha256 !== sha) deny('REVIEW_RECHECK_INPUT_CHANGED')
        expected.set(path, sha)
      }
      if (!artifact.changes.some(change => change.path === task.reviewOrigin.path)) deny('REVIEW_RECHECK_TARGET_MISSING')
      const verifyInput = async record => {
        const current = await this.store.get(task.id)
        if (current.status !== 'completed' || current.acceptance?.mode !== 'accept') deny('REVIEW_RECHECK_NOT_ACCEPTED')
        for (const path of artifact.changes.map(change => change.path)) {
          const entry = record.entries.find(entry => entry.new?.path === path)
          if (!entry) deny('REVIEW_RECHECK_TARGET_MISSING')
          if (entry.new.contentSha256 !== expected.get(path)) deny('REVIEW_RECHECK_INPUT_CHANGED')
        }
        for (const [path, sha] of expected) if ((await readManagedProjectFile(project, path)).sha256 !== sha) deny('REVIEW_RECHECK_INPUT_CHANGED')
      }
      return this.preparer.prepare({ requestId: input.requestId, input: { mode: 'workspace' } }, { recheckOrigin, verifyInput })
    })
  }

  async dispose() { await Promise.allSettled([...this.pending.values()].map(owned => owned.promise)) }

  /** Route actions must wait for their owned capture before cancelling, starting or deleting its record. */
  async whenPrepared(taskId) {
    if (!this.pending.size) return
    const task = await this.store.get(taskId)
    const owned = this.pending.get(task.requestId)
    if (owned) {
      try { await owned.promise } catch { /* a failed preparation also finishes its capture before cancellation */ }
    }
  }
}
