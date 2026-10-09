import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { reviewSelection } from './review/selection.js'
import { setTimeout as delay } from 'node:timers/promises'

const VERSION = 1
const ID = /^[A-Za-z0-9._:-]{1,100}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'awaiting_review', 'discarded'])
const ACTIVE = new Set(['queued', 'running', 'cancelling', 'applying', 'deleting'])
const EVENT_TYPES = new Set(['baseline', 'created', 'snapshot', 'started', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted', 'discarded', 'applying', 'acceptance', 'deleting', 'draft', 'sandbox', 'execution', 'artifact', 'review'])
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{8,128}$/

export class TaskEntryError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status }
}

/** Retry the already-written metadata replacement, never the task transition or its side effects. */
export async function renameTaskFile(temporary, target, { platform = process.platform, replace = rename, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await replace(temporary, target); return }
    catch (error) {
      if (platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error
      await wait(25 * (attempt + 1))
    }
  }
}

function within(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function prospectiveRealpath(path) {
  const missing = []
  let current = path
  while (true) {
    try { return resolve(await realpath(current), ...missing.reverse()) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(current.slice(parent.length).replace(/^[\\/]/, ''))
      current = parent
    }
  }
}

function validateInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== (value.kind === 'review'
      ? 'kind,objective,paths,requestId,reviewInput' : 'kind,objective,paths,requestId')
    || !ID.test(value.requestId) || !['understand', 'modify', 'review'].includes(value.kind)
    || typeof value.objective !== 'string' || value.objective !== value.objective.trim()
    || value.objective.length < 1 || value.objective.length > 500
    || !Array.isArray(value.paths) || (value.kind === 'review' ? value.paths.length !== 0 : value.paths.length < 1)
    || value.paths.length > 16) {
    throw new TaskEntryError('INVALID_TASK_INPUT', 400)
  }
  const unique = new Set()
  for (const path of value.paths) {
    if (typeof path !== 'string' || path.length < 1 || path.length > 240 || path.includes('\\')
      || path.startsWith('/') || /^[A-Za-z]:/.test(path)
      || value.kind === 'modify' && !/^[A-Za-z0-9._/-]+$/.test(path)) throw new TaskEntryError('INVALID_TASK_INPUT', 400)
    const segments = path.split('/')
    if (segments.some(segment => !segment || segment === '.' || segment === '..'
      || /[\u0000-\u001f\u007f<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
      || /^(?:\.git|\.ssh|\.aws|\.azure|\.kube|\.env(?:\..*)?|\.npmrc|\.pypirc|\.git-credentials|secret(?:s)?(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$/i.test(segment)
      || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(segment)) || unique.has(path.toLowerCase())) {
      throw new TaskEntryError('INVALID_TASK_INPUT', 400)
    }
    unique.add(path.toLowerCase())
  }
  let reviewInput
  if (value.kind === 'review') {
    try { reviewInput = reviewSelection(value.reviewInput) }
    catch { throw new TaskEntryError('INVALID_TASK_INPUT', 400) }
  }
  return { requestId: value.requestId, kind: value.kind, objective: value.objective, paths: [...value.paths],
    ...(reviewInput ? { reviewInput } : {}) }
}

function sameInput(task, input) {
  return task.requestId === input.requestId && task.kind === input.kind
    && task.objective === input.objective && JSON.stringify(task.paths) === JSON.stringify(input.paths)
    && JSON.stringify(task.reviewInput) === JSON.stringify(input.reviewInput)
    && JSON.stringify(task.reviewOrigin) === JSON.stringify(input.reviewOrigin)
    && JSON.stringify(task.recheckOrigin) === JSON.stringify(input.recheckOrigin)
}

export { validateInput as validateManagedTaskInput }

function validRelations(task) {
  const origin = task.reviewOrigin, recheck = task.recheckOrigin
  return (origin === undefined || task.kind === 'modify' && origin && !Array.isArray(origin)
    && Object.keys(origin).sort().join(',') === 'findingId,path,preparationId,reportId,reviewTaskId,sourceSha256'
    && UUID.test(origin.reviewTaskId) && origin.reviewTaskId !== task.id
    && ['findingId', 'preparationId', 'reportId', 'sourceSha256'].every(key => typeof origin[key] === 'string' && /^[0-9a-f]{64}$/.test(origin[key]))
    && Array.isArray(task.paths) && typeof origin.path === 'string' && task.paths.includes(origin.path)
    && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(origin.path))
    && (recheck === undefined || task.kind === 'review' && recheck && !Array.isArray(recheck)
      && Object.keys(recheck).sort().join(',') === 'artifactId,modifyTaskId'
      && UUID.test(recheck.modifyTaskId) && recheck.modifyTaskId !== task.id
      && typeof recheck.artifactId === 'string' && /^[0-9a-f]{64}$/.test(recheck.artifactId))
}

function appendEvent(task, type, previousStatus = task.status, text) {
  const events = task.events ?? [{ seq: 1, type: 'baseline', status: previousStatus, at: task.startedAt ?? task.createdAt }]
  const seq = events.at(-1).seq + 1
  if (seq > 256) throw new TaskEntryError('TASK_EVENT_LIMIT', 409)
  task.events = [...events, { seq, type, status: task.status, at: new Date().toISOString(),
    ...(text === undefined ? {} : { text }) }]
}

function validStoredTask(task, projectId) {
  const cancelledBeforeStart = ['understand', 'modify', 'review'].includes(task?.kind) && ['cancelled', 'deleting'].includes(task.status)
    && task.engineStatus === 'not_started' && task.sessionId === null
    && task.startRequestId === undefined && task.startedAt === undefined
  if (!task || !validRelations(task) || task.version !== VERSION || !UUID.test(task.id) || task.projectId !== projectId
    || !ACTIVE.has(task.status) && !TERMINAL.has(task.status)
    || !['not_started', 'starting', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(task.engineStatus)
    || task.sessionId !== null && task.sessionId !== task.id
    || !Array.isArray(task.executionIds) || (task.kind !== 'modify' && task.executionIds.length !== 0)
    || typeof task.createdAt !== 'string' || !Number.isFinite(Date.parse(task.createdAt))) return false
  if (task.status === 'queued' && (task.engineStatus !== 'not_started' || task.sessionId !== null)
    || task.status !== 'queued' && !cancelledBeforeStart && (!ID.test(task.startRequestId) || task.sessionId !== task.id
      || typeof task.startedAt !== 'string' || !Number.isFinite(Date.parse(task.startedAt)))
    || TERMINAL.has(task.status) && (typeof task.endedAt !== 'string' || !Number.isFinite(Date.parse(task.endedAt)))) return false
  if (task.answer !== undefined && (typeof task.answer !== 'string' || Buffer.byteLength(task.answer) > 65536)
    || task.references !== undefined && (!Array.isArray(task.references) || task.references.length > 16)
    || task.failureCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(task.failureCode)) return false
  if (task.snapshotId !== undefined && task.snapshotId !== null
    && !/^[0-9a-f]{64}$/.test(task.snapshotId)) return false
  if (task.events !== undefined && (!Array.isArray(task.events) || task.events.length < 1
    || task.events.length > 256 || task.events.some((event, index) => !event
      || event.seq !== index + 1 || !EVENT_TYPES.has(event.type)
      || !ACTIVE.has(event.status) && !TERMINAL.has(event.status)
      || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
      || (event.type === 'draft') !== (typeof event.text === 'string')
      || event.text !== undefined && (!event.text || Buffer.byteLength(event.text) > 4096))
    || task.events.at(-1).status !== task.status)) return false
  if (task.draft !== undefined && (typeof task.draft !== 'string'
    || Buffer.byteLength(task.draft) > 65536)) return false
  try { validateInput({ requestId: task.requestId, kind: task.kind, objective: task.objective, paths: task.paths,
    ...(task.kind === 'review' ? { reviewInput: task.reviewInput } : {}) }) }
  catch { return false }
  if (task.readObservations !== undefined) {
    if (!Array.isArray(task.readObservations) || task.readObservations.length > task.paths.length) return false
    const seen = new Set()
    for (const item of task.readObservations) {
      if (!item || !task.paths.includes(item.path) || seen.has(item.path)
        || !/^[0-9a-f]{64}$/.test(item.sha256)
        || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.byteLength > 262144
        || !Number.isSafeInteger(item.lineCount) || item.lineCount < 0
        || typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt))) return false
      seen.add(item.path)
    }
  }
  if (task.references?.some(item => !item || !task.paths.includes(item.path)
    || item.snapshotId !== task.snapshotId || !/^[0-9a-f]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.startLine) || item.startLine < 1
    || !Number.isSafeInteger(item.endLine) || item.endLine < item.startLine)) return false
  if (task.kind === 'understand' && task.status === 'completed' && (task.engineStatus !== 'completed' || !task.answer
    || !task.references?.length || task.failureCode !== undefined)) return false
  if (task.kind === 'understand' && (task.status === 'awaiting_review' || task.sandboxId !== undefined
    || task.executions !== undefined || task.artifactId !== undefined)) return false
  if (task.kind !== 'review' && (task.reviewInput !== undefined || task.reviewSnapshotId !== undefined
    || task.reviewCancelRequestId !== undefined || task.reviewFailureCode !== undefined
    || task.reviewCleanupPending !== undefined || task.reviewPlanId !== undefined
    || task.reviewReportId !== undefined || task.reviewOutcome !== undefined)) return false
  if (task.kind === 'review' && (!['queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted', 'deleting'].includes(task.status)
    || task.snapshotId !== null || task.readObservations?.length || task.answer !== undefined
    || task.references !== undefined || task.draft !== undefined || task.sandboxId !== undefined
    || task.executions !== undefined || task.artifactId !== undefined || task.acceptance !== undefined
    || task.reviewSnapshotId !== undefined && !/^[0-9a-f]{64}$/.test(task.reviewSnapshotId)
    || task.reviewPlanId !== undefined && !/^[0-9a-f]{64}$/.test(task.reviewPlanId)
    || task.reviewReportId !== undefined && !/^[0-9a-f]{64}$/.test(task.reviewReportId)
    || task.reviewOutcome !== undefined && !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(task.reviewOutcome)
    || task.sessionId && (!task.reviewSnapshotId || !task.reviewPlanId)
    || ['running', 'cancelling'].includes(task.status) && !['starting', 'running'].includes(task.engineStatus)
    || ['failed', 'interrupted'].includes(task.status) && task.engineStatus !== task.status
    || task.status === 'cancelled' && !cancelledBeforeStart && task.engineStatus !== 'cancelled'
    || (task.reviewReportId === undefined) !== (task.reviewOutcome === undefined)
    || task.status === 'completed' && (!task.reviewReportId || !['completed', 'partial'].includes(task.reviewOutcome)
      || task.engineStatus !== 'completed')
    || task.reviewCancelRequestId !== undefined && !ID.test(task.reviewCancelRequestId)
    || task.reviewFailureCode !== undefined && !/^REVIEW_[A-Z_]{1,60}$/.test(task.reviewFailureCode)
    || task.reviewCleanupPending !== undefined && typeof task.reviewCleanupPending !== 'boolean'
    || task.reviewCleanupPending && (task.status !== 'queued' || !task.reviewFailureCode))) return false
  if (task.kind === 'modify') {
    if (task.answer !== undefined || task.references !== undefined
      || task.draft !== undefined) return false
    if (task.acceptance !== undefined && (!task.acceptance || !ID.test(task.acceptance.requestId)
      || !['accept', 'rollback'].includes(task.acceptance.mode)
      || task.acceptance.recoveryRequestId !== undefined && !ID.test(task.acceptance.recoveryRequestId)
      || !Array.isArray(task.acceptance.entries) || task.acceptance.entries.length < 1
      || task.acceptance.entries.length > task.paths.length
      || new Set(task.acceptance.entries.map(item => item.path)).size !== task.acceptance.entries.length
      || task.acceptance.entries.some(item => !task.paths.includes(item.path)
        || !/^[0-9a-f]{64}$/.test(item.beforeSha256) || !/^[0-9a-f]{64}$/.test(item.afterSha256)
        || !['pending', 'writing', 'written', 'rolled_back'].includes(item.state)))) return false
    if (task.discardRequestId !== undefined && !ID.test(task.discardRequestId)) return false
    if (task.deleteRequestId !== undefined && !ID.test(task.deleteRequestId)) return false
    if (['applying', 'completed', 'discarded'].includes(task.status) && !task.acceptance
      && task.status !== 'discarded') return false
    if (task.status === 'applying' && task.sandboxStatus !== 'cleaned') return false
    if (task.sandboxId !== undefined && !EXTERNAL_ID.test(task.sandboxId)
      || task.sandboxAllocationPending !== undefined && typeof task.sandboxAllocationPending !== 'boolean'
      || task.sandboxId && task.sandboxAllocationPending
      || task.sandboxStatus !== undefined && !['allocating', 'allocated', 'stopping', 'cleaned', 'cleanup_pending'].includes(task.sandboxStatus)) return false
    if (task.executions !== undefined) {
      if (!Array.isArray(task.executions) || task.executions.length > 32) return false
      if (task.executions.some(item => !item || !EXTERNAL_ID.test(item.id)
        || !['edit', 'test'].includes(item.kind) || typeof item.command !== 'string'
        || !item.command || Buffer.byteLength(item.command) > 4096 || item.cwd !== '/workspace'
        || !['running', 'completed', 'failed', 'timeout', 'interrupted', 'unknown'].includes(item.status)
        || item.status !== 'running' && (!/^[0-9a-f]{64}$/.test(item.outputSha256)
          || !Number.isSafeInteger(item.outputBytes) || item.outputBytes < 0 || item.outputBytes > 65536)
        || item.outputExcerpt !== undefined && (typeof item.outputExcerpt !== 'string'
          || Buffer.byteLength(item.outputExcerpt) > 8192)
        || item.exitCode !== undefined && item.exitCode !== null
          && (!Number.isSafeInteger(item.exitCode) || item.exitCode < 0 || item.exitCode > 255))) return false
      if (JSON.stringify(task.executionIds) !== JSON.stringify(task.executions.map(item => item.id))) return false
    }
    if (task.status === 'awaiting_review' && (task.engineStatus !== 'completed'
      || task.sandboxStatus !== 'cleaned' || !/^[0-9a-f]{64}$/.test(task.artifactId)
      || !Number.isSafeInteger(task.changeCount) || task.changeCount < 1
      || !task.executions?.some(item => item.id === task.verificationId && item.kind === 'test'
        && ['completed', 'failed'].includes(item.status)))) return false
  }
  return true
}

/** Versioned product task metadata. Does not read project source or start execution. */
export class ManagedTaskStore {
  constructor(dataHome, projectRoot) {
    if (!isAbsolute(dataHome) || !isAbsolute(projectRoot)) throw new TaskEntryError('INVALID_TASK_LOCATION', 400)
    this.dataHome = resolve(dataHome)
    this.projectRoot = resolve(projectRoot)
  }

  async location() {
    const project = await realpath(this.projectRoot)
    if (!(await stat(project)).isDirectory()) throw new TaskEntryError('INVALID_TASK_LOCATION', 400)
    if (within(project, this.dataHome) || within(project, await prospectiveRealpath(this.dataHome))) {
      throw new TaskEntryError('TASK_DATA_HOME_UNSAFE', 400)
    }
    await mkdir(this.dataHome, { recursive: true, mode: 0o700 })
    const realHome = await realpath(this.dataHome)
    if (within(project, realHome)) throw new TaskEntryError('TASK_DATA_HOME_UNSAFE', 400)
    const folder = join(realHome, 'managed-tasks-v1')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    if (within(project, await realpath(folder))) throw new TaskEntryError('TASK_DATA_HOME_UNSAFE', 400)
    const projectId = createHash('sha256').update(project).digest('hex')
    return { project, projectId, file: join(folder, `${projectId}.json`) }
  }

  async load(location) {
    let state
    try { state = JSON.parse(await readFile(location.file, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') return { version: VERSION, projectId: location.projectId, projectRoot: location.project, tasks: [] }
      throw new TaskEntryError('TASK_STORE_INVALID', 503)
    }
    if (state?.version !== VERSION || state.projectId !== location.projectId
      || state.projectRoot !== location.project || !Array.isArray(state.tasks)
      || state.tasks.length > 100 || state.tasks.some(task => !validStoredTask(task, location.projectId))
      || state.tasks.filter(task => ACTIVE.has(task.status)).length > 1
      || new Set(state.tasks.map(task => task.id)).size !== state.tasks.length
      || new Set(state.tasks.map(task => task.requestId)).size !== state.tasks.length
      || state.tasks.some(task => {
        if (task.reviewOrigin) {
          const parent = state.tasks.find(item => item.id === task.reviewOrigin.reviewTaskId)
          if (parent?.kind !== 'review' || parent.reviewSnapshotId !== task.reviewOrigin.preparationId
            || parent.reviewReportId !== task.reviewOrigin.reportId) return true
        }
        if (task.recheckOrigin) {
          const parent = state.tasks.find(item => item.id === task.recheckOrigin.modifyTaskId)
          if (parent?.kind !== 'modify' || !parent.reviewOrigin || parent.artifactId !== task.recheckOrigin.artifactId) return true
        }
        return false
      })) {
      throw new TaskEntryError('TASK_STORE_INVALID', 503)
    }
    return state
  }

  async save(location, state) {
    const temporary = `${location.file}.${randomUUID()}.tmp`
    let handle
    try {
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(state))
      await handle.sync()
      await handle.close()
      handle = null
      await renameTaskFile(temporary, location.file)
    } finally {
      await handle?.close()
      await rm(temporary, { force: true })
    }
  }

  async create(value, relations = {}) {
    const input = { ...validateInput(value), ...relations }
    if (!relations || typeof relations !== 'object' || Array.isArray(relations)
      || Object.keys(relations).some(key => !['reviewOrigin', 'recheckOrigin'].includes(key))
      || !validRelations(input)) throw new TaskEntryError('INVALID_TASK_INPUT', 400)
    const location = await this.location()
    let lock
    try { lock = await open(`${location.file}.lock`, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') throw new TaskEntryError('TASK_STORE_BUSY', 503)
      throw error
    }
    try {
      const state = await this.load(location)
      const previous = state.tasks.find(task => task.requestId === input.requestId)
      if (previous) {
        if (!sameInput(previous, input)) throw new TaskEntryError('REQUEST_ID_CONFLICT', 409)
        return { created: false, task: previous }
      }
      if (input.reviewOrigin) {
        const parent = state.tasks.find(task => task.id === input.reviewOrigin.reviewTaskId)
        if (parent?.kind !== 'review' || parent.status !== 'completed'
          || parent.reviewSnapshotId !== input.reviewOrigin.preparationId || parent.reviewReportId !== input.reviewOrigin.reportId) {
          throw new TaskEntryError('REVIEW_FIX_UNSUPPORTED', 409)
        }
      }
      if (input.recheckOrigin) {
        const parent = state.tasks.find(task => task.id === input.recheckOrigin.modifyTaskId)
        if (parent?.kind !== 'modify' || parent.status !== 'completed' || !parent.reviewOrigin
          || parent.artifactId !== input.recheckOrigin.artifactId || parent.acceptance?.mode !== 'accept') {
          throw new TaskEntryError('REVIEW_RECHECK_NOT_ACCEPTED', 409)
        }
      }
      if (state.tasks.some(task => ACTIVE.has(task.status) || task.sandboxStatus === 'cleanup_pending'
        || task.status === 'interrupted' && task.acceptance)) {
        throw new TaskEntryError('ACTIVE_TASK_EXISTS', 409)
      }
      if (state.tasks.length >= 100) throw new TaskEntryError('TASK_STORE_FULL', 409)
      const task = { version: VERSION, id: randomUUID(), projectId: location.projectId,
        requestId: input.requestId, kind: input.kind, objective: input.objective, paths: input.paths,
        status: 'queued', engineStatus: 'not_started', sessionId: null, executionIds: [],
        createdAt: new Date().toISOString(), readObservations: [], snapshotId: null }
      if (input.reviewInput) task.reviewInput = input.reviewInput
      if (input.reviewOrigin) task.reviewOrigin = structuredClone(input.reviewOrigin)
      if (input.recheckOrigin) task.recheckOrigin = structuredClone(input.recheckOrigin)
      task.events = [{ seq: 1, type: 'created', status: 'queued', at: task.createdAt }]
      state.tasks.push(task)
      await this.save(location, state)
      return { created: true, task }
    } finally {
      await lock.close()
      await rm(`${location.file}.lock`, { force: true })
    }
  }

  async list() {
    const location = await this.location()
    const state = await this.load(location)
    return state.tasks.slice().reverse()
  }

  async get(id) {
    if (!UUID.test(id)) throw new TaskEntryError('INVALID_TASK_ID', 400)
    const task = (await this.list()).find(item => item.id === id)
    if (!task) throw new TaskEntryError('TASK_NOT_FOUND', 404)
    return task
  }

  async eventsAfter(id, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new TaskEntryError('INVALID_EVENT_CURSOR', 400)
    const task = await this.get(id)
    const events = task.events ?? [{ seq: 1, type: 'baseline', status: task.status, at: task.startedAt ?? task.createdAt }]
    return { events: events.filter(event => event.seq > after), cursor: events.at(-1).seq }
  }

  async attachReviewPreparation(id, snapshotId) {
    if (!/^[0-9a-f]{64}$/.test(snapshotId)) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    return this.updateTask(id, task => {
      if (task.kind !== 'review' || task.status !== 'queued') throw new TaskEntryError('REVIEW_STATE_CONFLICT', 409)
      if (task.reviewCleanupPending) throw new TaskEntryError('REVIEW_CLEANUP_UNCONFIRMED', 409)
      if (task.reviewSnapshotId && task.reviewSnapshotId !== snapshotId) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
      if (task.reviewSnapshotId === snapshotId) return { changed: false, value: task }
      task.reviewSnapshotId = snapshotId
      delete task.reviewFailureCode
      return { changed: true, eventType: 'review', value: task }
    })
  }

  async failReviewPreparation(id, code, cleanupPending = false) {
    if (!/^REVIEW_[A-Z_]{1,60}$/.test(code)) throw new TaskEntryError('INVALID_REVIEW_INPUT', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'review' || task.status !== 'queued') throw new TaskEntryError('REVIEW_STATE_CONFLICT', 409)
      task.reviewFailureCode = code
      task.reviewCleanupPending = Boolean(task.reviewCleanupPending || cleanupPending)
      return { changed: true, eventType: 'review', value: task }
    })
  }

  async cancelQueuedReview(id, requestId) {
    if (!ID.test(requestId)) throw new TaskEntryError('INVALID_REVIEW_INPUT', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'review') throw new TaskEntryError('REVIEW_STATE_CONFLICT', 409)
      if (task.reviewCleanupPending) throw new TaskEntryError('REVIEW_CLEANUP_UNCONFIRMED', 409)
      if (task.status === 'cancelled' && task.reviewCancelRequestId === requestId) return { changed: false, value: task }
      if (task.status !== 'queued') throw new TaskEntryError('REVIEW_STATE_CONFLICT', 409)
      task.status = 'cancelled'; task.reviewCancelRequestId = requestId; task.endedAt = new Date().toISOString()
      return { changed: true, value: task }
    })
  }

  async appendDraft(id, text) {
    if (typeof text !== 'string' || !text || Buffer.byteLength(text) > 4096) {
      throw new TaskEntryError('INVALID_DRAFT_CHUNK', 400)
    }
    return this.updateTask(id, task => {
      if (task.status !== 'running') throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      const draft = (task.draft ?? '') + text
      if (Buffer.byteLength(draft) > 65536) throw new TaskEntryError('ENGINE_ANSWER_LIMIT', 409)
      task.draft = draft
      return { changed: true, eventType: 'draft', eventText: text, value: task }
    })
  }

  async recordRead(id, observation) {
    if (!UUID.test(id)) throw new TaskEntryError('INVALID_TASK_ID', 400)
    const location = await this.location()
    let lock
    try { lock = await open(`${location.file}.lock`, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') throw new TaskEntryError('TASK_STORE_BUSY', 503)
      throw error
    }
    try {
      const state = await this.load(location)
      const task = state.tasks.find(item => item.id === id)
      if (!task) throw new TaskEntryError('TASK_NOT_FOUND', 404)
      if (!task.paths.includes(observation?.path)) throw new TaskEntryError('READ_PATH_DENIED', 403)
      const previous = task.readObservations?.find(item => item.path === observation.path)
      if (previous) {
        if (previous.sha256 !== observation.sha256) throw new TaskEntryError('READ_INPUT_CHANGED', 409)
        return previous
      }
      const item = { ...observation, observedAt: new Date().toISOString() }
      task.readObservations = [...(task.readObservations ?? []), item]
      if (!validStoredTask(task, location.projectId)) throw new TaskEntryError('READ_OBSERVATION_INVALID', 400)
      await this.save(location, state)
      return item
    } finally {
      await lock.close()
      await rm(`${location.file}.lock`, { force: true })
    }
  }

  async attachSnapshot(id, snapshotId) {
    if (!UUID.test(id)) throw new TaskEntryError('INVALID_TASK_ID', 400)
    if (!/^[0-9a-f]{64}$/.test(snapshotId)) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
    const location = await this.location()
    let lock
    try { lock = await open(`${location.file}.lock`, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') throw new TaskEntryError('TASK_STORE_BUSY', 503)
      throw error
    }
    try {
      const state = await this.load(location)
      const task = state.tasks.find(item => item.id === id)
      if (!task) throw new TaskEntryError('TASK_NOT_FOUND', 404)
      if (task.snapshotId && task.snapshotId !== snapshotId) throw new TaskEntryError('SNAPSHOT_CONFLICT', 409)
      if (task.snapshotId === snapshotId) return task
      task.snapshotId = snapshotId
      appendEvent(task, 'snapshot')
      await this.save(location, state)
      return task
    } finally {
      await lock.close()
      await rm(`${location.file}.lock`, { force: true })
    }
  }

  async updateTask(id, update) {
    if (!UUID.test(id)) throw new TaskEntryError('INVALID_TASK_ID', 400)
    const location = await this.location()
    let lock
    try { lock = await open(`${location.file}.lock`, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') throw new TaskEntryError('TASK_STORE_BUSY', 503)
      throw error
    }
    try {
      const state = await this.load(location)
      const task = state.tasks.find(item => item.id === id)
      if (!task) throw new TaskEntryError('TASK_NOT_FOUND', 404)
      const previousStatus = task.status
      const result = update(task, state)
      if (result.changed) {
        const type = result.eventType ?? (task.status === 'running' && task.engineStatus === 'starting' ? 'started'
          : task.status === 'running' ? 'running' : task.status
        )
        appendEvent(task, type, previousStatus, result.eventText)
        if (!validStoredTask(task, location.projectId)) throw new TaskEntryError('TASK_STORE_INVALID', 503)
        await this.save(location, state)
      }
      return result.value
    } finally {
      await lock.close()
      await rm(`${location.file}.lock`, { force: true })
    }
  }

  async claimRun(id, requestId) { return this.claim(id, requestId, 'understand') }

  async claimModify(id, requestId) { return this.claim(id, requestId, 'modify') }

  async claimReview(id, requestId, planId) {
    if (!ID.test(requestId) || !/^[0-9a-f]{64}$/.test(planId)) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'review') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
      if (task.status !== 'queued') {
        if (task.startRequestId === requestId) return { changed: false, value: { created: false, task } }
        throw new TaskEntryError('RUN_ALREADY_STARTED', 409)
      }
      if (!task.reviewSnapshotId || task.reviewCleanupPending) throw new TaskEntryError('REVIEW_NOT_PREPARED', 409)
      task.reviewPlanId = planId; task.status = 'running'; task.engineStatus = 'starting'; task.sessionId = task.id
      task.startRequestId = requestId; task.startedAt = new Date().toISOString()
      return { changed: true, value: { created: true, task } }
    })
  }

  async finishReview(id, reportId, outcome, status = 'completed', failureCode) {
    if (!/^[0-9a-f]{64}$/.test(reportId) || !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(outcome)
      || !['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
      || (status === 'completed' ? !['completed', 'partial'].includes(outcome) : outcome !== status)
      || failureCode !== undefined && !/^[A-Z][A-Z0-9_]{1,79}$/.test(failureCode)) {
      throw new TaskEntryError('REVIEW_RESULT_INVALID', 409)
    }
    return this.updateTask(id, task => {
      if (task.kind !== 'review' || !['running', 'cancelling'].includes(task.status)) throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      task.reviewReportId = reportId; task.reviewOutcome = outcome
      task.status = status; task.engineStatus = status; task.endedAt = new Date().toISOString()
      if (failureCode) task.failureCode = failureCode
      return { changed: true, value: task }
    })
  }

  async cancelQueuedUnderstand(id) {
    return this.updateTask(id, task => {
      if (task.kind !== 'understand') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
      if (task.status === 'cancelled' && task.engineStatus === 'not_started') return { changed: false, value: task }
      if (task.status !== 'queued') throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      task.status = 'cancelled'; task.endedAt = new Date().toISOString()
      return { changed: true, value: task }
    })
  }

  async cancelQueuedModify(id) {
    return this.updateTask(id, task => {
      if (task.kind !== 'modify') throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
      if (task.status === 'cancelled' && task.engineStatus === 'not_started') {
        return { changed: false, value: task }
      }
      if (task.status !== 'queued') throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      task.status = 'cancelled'; task.endedAt = new Date().toISOString()
      return { changed: true, value: task }
    })
  }

  async claim(id, requestId, kind) {
    if (!ID.test(requestId)) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
    return this.updateTask(id, task => {
      if (task.kind !== kind) throw new TaskEntryError('RUN_KIND_MISMATCH', 409)
      if (task.status !== 'queued') {
        if (ACTIVE.has(task.status) && task.startRequestId === requestId) {
          return { changed: false, value: { created: false, task } }
        }
        throw new TaskEntryError('RUN_ALREADY_STARTED', 409)
      }
      if (!task.snapshotId) throw new TaskEntryError('SNAPSHOT_NOT_READY', 409)
      task.status = 'running'; task.engineStatus = 'starting'; task.sessionId = task.id
      if (kind === 'modify') { task.sandboxAllocationPending = true; task.sandboxStatus = 'allocating' }
      task.startRequestId = requestId; task.startedAt = new Date().toISOString()
      return { changed: true, value: { created: true, task } }
    })
  }

  async recordSandbox(id, sandboxId) {
    if (!EXTERNAL_ID.test(sandboxId)) throw new TaskEntryError('SANDBOX_ID_INVALID', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || !['running', 'cancelling'].includes(task.status)
        && !(task.status === 'interrupted' && task.sandboxAllocationPending)
        || task.sandboxId && task.sandboxId !== sandboxId) {
        throw new TaskEntryError('SANDBOX_STATE_CONFLICT', 409)
      }
      if (task.sandboxId === sandboxId) return { changed: false, value: task }
      task.sandboxId = sandboxId; task.sandboxStatus = 'allocated'; task.sandboxAllocationPending = false
      return { changed: true, eventType: 'sandbox', value: task }
    })
  }

  async markSandboxCleaned(id) {
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || !task.sandboxId && !task.sandboxAllocationPending) {
        throw new TaskEntryError('SANDBOX_STATE_CONFLICT', 409)
      }
      if (task.sandboxStatus === 'cleaned') return { changed: false, value: task }
      task.sandboxStatus = 'cleaned'; task.sandboxAllocationPending = false
      for (const entry of task.executions ?? []) {
        if (entry.status !== 'running') continue
        entry.status = 'interrupted'; entry.exitCode = null
        entry.outputSha256 = createHash('sha256').update('').digest('hex')
        entry.outputBytes = 0; entry.outputExcerpt = ''
      }
      return { changed: true, eventType: 'sandbox', value: task }
    })
  }

  async markSandboxStopping(id) {
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || !task.sandboxId
        || !['allocated', 'stopping', 'cleanup_pending'].includes(task.sandboxStatus)) {
        throw new TaskEntryError('SANDBOX_STATE_CONFLICT', 409)
      }
      if (task.sandboxStatus === 'stopping') return { changed: false, value: task }
      task.sandboxStatus = 'stopping'
      return { changed: true, eventType: 'sandbox', value: task }
    })
  }

  async markSandboxCleanupPending(id) {
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || !task.sandboxId && !task.sandboxAllocationPending || task.sandboxStatus === 'cleaned') {
        throw new TaskEntryError('SANDBOX_STATE_CONFLICT', 409)
      }
      if (task.sandboxStatus === 'cleanup_pending') return { changed: false, value: task }
      task.sandboxStatus = 'cleanup_pending'
      return { changed: true, eventType: 'sandbox', value: task }
    })
  }

  async recordExecutionStart(id, entry) {
    if (!entry || !EXTERNAL_ID.test(entry.id) || !['edit', 'test'].includes(entry.kind)
      || typeof entry.command !== 'string' || !entry.command || Buffer.byteLength(entry.command) > 4096
      || entry.cwd !== '/workspace') throw new TaskEntryError('EXECUTION_INVALID', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || task.status !== 'running' || task.sandboxStatus !== 'allocated'
        || task.executionIds.includes(entry.id) || task.executionIds.length >= 32) {
        throw new TaskEntryError('EXECUTION_STATE_CONFLICT', 409)
      }
      task.executionIds.push(entry.id)
      task.executions = [...(task.executions ?? []), { ...entry, status: 'running' }]
      return { changed: true, eventType: 'execution', value: task }
    })
  }

  async finishExecution(id, executionId, result) {
    if (!EXTERNAL_ID.test(executionId) || !result
      || !['completed', 'failed', 'timeout', 'interrupted', 'unknown'].includes(result.status)
      || result.status === 'completed' && result.exitCode !== 0
      || result.status === 'failed' && (!Number.isSafeInteger(result.exitCode) || result.exitCode === 0)
      || !/^[0-9a-f]{64}$/.test(result.outputSha256)
      || !Number.isSafeInteger(result.outputBytes) || result.outputBytes < 0 || result.outputBytes > 65536
      || result.outputExcerpt !== undefined && (typeof result.outputExcerpt !== 'string'
        || Buffer.byteLength(result.outputExcerpt) > 8192)) {
      throw new TaskEntryError('EXECUTION_INVALID', 400)
    }
    return this.updateTask(id, task => {
      const entry = task.executions?.find(item => item.id === executionId)
      if (!entry || entry.status !== 'running') throw new TaskEntryError('EXECUTION_STATE_CONFLICT', 409)
      Object.assign(entry, result)
      return { changed: true, eventType: 'execution', value: task }
    })
  }

  async finishModify(id, result) {
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || task.status !== 'running' || task.sandboxStatus !== 'cleaned'
        || !/^[0-9a-f]{64}$/.test(result?.artifactId)
        || !Number.isSafeInteger(result.changeCount) || result.changeCount < 1
        || !task.executions?.some(item => item.id === result.verificationId && item.kind === 'test'
          && ['completed', 'failed'].includes(item.status))) throw new TaskEntryError('MODIFY_RESULT_INVALID', 409)
      task.status = 'awaiting_review'; task.engineStatus = 'completed'; task.endedAt = new Date().toISOString()
      task.artifactId = result.artifactId; task.changeCount = result.changeCount
      task.verificationId = result.verificationId
      return { changed: true, eventType: 'artifact', value: task }
    })
  }

  async beginAcceptance(id, requestId, entries) {
    if (!ID.test(requestId) || !Array.isArray(entries)) throw new TaskEntryError('INVALID_ACCEPT_INPUT', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || task.status !== 'awaiting_review') throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
      task.acceptance = { requestId, mode: 'accept', entries: entries.map(entry => ({ ...entry, state: 'pending' })) }
      task.status = 'applying'
      return { changed: true, eventType: 'acceptance', value: task }
    })
  }

  async discardArtifact(id, requestId) {
    if (!ID.test(requestId)) throw new TaskEntryError('INVALID_ACCEPT_INPUT', 400)
    return this.updateTask(id, task => {
      if (task.kind !== 'modify') throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
      if (task.status === 'discarded' && task.discardRequestId === requestId) return { changed: false, value: task }
      if (task.status !== 'awaiting_review') throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
      task.status = 'discarded'; task.discardRequestId = requestId; task.endedAt = new Date().toISOString()
      return { changed: true, value: task }
    })
  }

  async markHistoryDeleting(id, requestId) {
    if (!ID.test(requestId)) throw new TaskEntryError('INVALID_HISTORY_INPUT', 400)
    return this.updateTask(id, (task, state) => {
      if (state.tasks.some(child => child.reviewOrigin?.reviewTaskId === id || child.recheckOrigin?.modifyTaskId === id)) {
        throw new TaskEntryError('HISTORY_REFERENCED', 409)
      }
      if (task.status === 'deleting' && task.deleteRequestId === requestId) return { changed: false, value: task }
      if (['queued', 'running', 'cancelling', 'applying', 'deleting'].includes(task.status)
        || state.tasks.some(other => other.id !== id && ACTIVE.has(other.status))
        || task.sandboxStatus === 'cleanup_pending' || task.status === 'interrupted' && task.acceptance) {
        throw new TaskEntryError('HISTORY_ACTIVE', 409)
      }
      task.status = 'deleting'; task.deleteRequestId = requestId
      return { changed: true, value: task }
    })
  }

  async forgetHistory(id, requestId) {
    if (!ID.test(requestId)) throw new TaskEntryError('INVALID_HISTORY_INPUT', 400)
    const location = await this.location()
    let lock
    try { lock = await open(`${location.file}.lock`, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') throw new TaskEntryError('TASK_STORE_BUSY', 503)
      throw error
    }
    try {
      const state = await this.load(location)
      const index = state.tasks.findIndex(task => task.id === id)
      if (index < 0) throw new TaskEntryError('TASK_NOT_FOUND', 404)
      if (state.tasks[index].status !== 'deleting' || state.tasks[index].deleteRequestId !== requestId) {
        throw new TaskEntryError('HISTORY_ACTIVE', 409)
      }
      state.tasks.splice(index, 1)
      await this.save(location, state)
    } finally {
      await lock.close()
      await rm(`${location.file}.lock`, { force: true })
    }
  }

  async updateAcceptance(id, action) {
    return this.updateTask(id, task => {
      if (task.kind !== 'modify' || !task.acceptance) throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
      action(task)
      return { changed: true, eventType: 'acceptance', value: task }
    })
  }

  async markRunning(id) {
    return this.updateTask(id, task => {
      if (task.status === 'cancelling') return { changed: false, value: task }
      if (task.status !== 'running') throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      if (task.engineStatus === 'running') return { changed: false, value: task }
      task.engineStatus = 'running'
      return { changed: true, value: task }
    })
  }

  async markCancelling(id) {
    return this.updateTask(id, task => {
      if (task.status === 'cancelling') return { changed: false, value: task }
      if (task.status !== 'running') throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      task.status = 'cancelling'
      return { changed: true, value: task }
    })
  }

  async finishRun(id, result) {
    return this.updateTask(id, task => {
      const references = result?.references
      if (task.status !== 'running' || result?.sessionId !== task.id || result?.turnEnd !== 'completed'
        || typeof result.answer !== 'string' || !result.answer.trim()
        || Buffer.byteLength(result.answer) > 65536 || !Array.isArray(references)
        || references.length < 1 || references.length > 16
        || references.some(ref => !task.paths.includes(ref?.path) || ref.snapshotId !== task.snapshotId
          || !Number.isSafeInteger(ref.startLine) || ref.startLine < 1
          || !Number.isSafeInteger(ref.endLine) || ref.endLine < ref.startLine
          || !task.readObservations?.some(item => item.path === ref.path && item.sha256 === ref.sha256
            && ref.endLine <= item.lineCount))) throw new TaskEntryError('RUN_RESULT_INVALID', 409)
      task.status = 'completed'; task.engineStatus = 'completed'; task.endedAt = new Date().toISOString()
      task.answer = result.answer; task.references = references
      return { changed: true, value: task }
    })
  }

  async failRun(id, failureCode, status = 'failed') {
    if (!['failed', 'cancelled', 'interrupted'].includes(status)
      || !/^[A-Z][A-Z0-9_]{1,79}$/.test(failureCode)) throw new TaskEntryError('INVALID_RUN_RESULT', 400)
    return this.updateTask(id, task => {
      if (TERMINAL.has(task.status)) return { changed: false, value: task }
      if (task.status !== 'running' && task.status !== 'cancelling') throw new TaskEntryError('RUN_STATE_CONFLICT', 409)
      task.status = status; task.engineStatus = status; task.endedAt = new Date().toISOString()
      task.failureCode = failureCode
      return { changed: true, value: task }
    })
  }
}
