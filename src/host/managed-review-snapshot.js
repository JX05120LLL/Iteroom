import { constants } from 'node:fs'
import { lstat, realpath, mkdir, open, link, rm } from 'node:fs/promises'
import { join, relative, sep, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskEntryError } from './managed-task-store.js'
import { sha256 } from './review/review-files.js'
import { sensitiveReviewPath } from './review/delegate.js'

const MAX_BYTES = 4 * 1024 * 1024
const inside = (root, path) => {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

async function filePath(store, taskId, create = false, name = 'prepared.json') {
  if (!['prepared.json', 'plan.json', 'result.json'].includes(name)) throw new TaskEntryError('REVIEW_LOCATION_UNSAFE', 503)
  const task = await store.get(taskId), location = await store.location()
  if (task.kind !== 'review') throw new TaskEntryError('REVIEW_STATE_CONFLICT', 409)
  let folder = store.dataHome
  const root = await realpath(folder)
  for (const part of ['managed-reviews-v1', location.projectId, task.id]) {
    folder = join(folder, part)
    if (create) {
      try { await mkdir(folder, { mode: 0o700 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    let info
    try { info = await lstat(folder) }
    catch (error) { if (error.code === 'ENOENT') throw new TaskEntryError('REVIEW_NOT_PREPARED', 409); throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await realpath(folder))) {
      throw new TaskEntryError('REVIEW_LOCATION_UNSAFE', 503)
    }
  }
  return { task, file: join(folder, name) }
}

function validate(value, task) {
  if (!value || value.version !== 1 || value.taskId !== task.id || value.projectId !== task.projectId
    || JSON.stringify(value.input?.selection) !== JSON.stringify(task.reviewInput)
    || !/^[0-9a-f]{64}$/.test(value.input?.inputSha256) || !Array.isArray(value.input?.entries)
    || value.input.entries.length > 100 || !Array.isArray(value.coverage)
    || value.coverage.length !== value.input.entries.length || !Array.isArray(value.groups)
    || value.ocr?.version !== 'v1.12.9' || value.ocr.schemaVersion !== '1'
    || typeof value.ocr.actualCli !== 'boolean') throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
  const selected = new Set()
  for (const [index, entry] of value.input.entries.entries()) {
    const coverage = value.coverage[index], path = entry.new?.path ?? entry.old?.path
    if (!path || coverage.path !== path || !['pending_inference', 'excluded'].includes(coverage.status)
      || coverage.oldPath !== (entry.old?.path ?? null) || coverage.newPath !== (entry.new?.path ?? null)
      || coverage.side !== (entry.new ? 'new' : 'old')) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    if (coverage.status === 'pending_inference') selected.add(path)
    if (coverage.status === 'excluded' && (entry.diff !== null
      || entry.old?.content !== undefined && entry.old.content !== null
      || entry.new?.content !== undefined && entry.new.content !== null)) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    if ([entry.old?.path, entry.new?.path].filter(Boolean).some(sensitiveReviewPath)
      && coverage.status !== 'excluded') throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    for (const side of [entry.old, entry.new].filter(Boolean)) {
      if (side.content !== null && (typeof side.content !== 'string' || sha256(side.content) !== side.contentSha256)) {
        throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
      }
    }
    if (entry.diff !== null && (typeof entry.diff !== 'string' || sha256(entry.diff) !== entry.diffSha256)) {
      throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    }
  }
  const covered = new Set()
  for (const group of value.groups) {
    if (typeof group.rule !== 'string' || sha256(group.rule) !== group.sha256 || !Array.isArray(group.files)) {
      throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    }
    for (const path of group.files) {
      if (!selected.has(path) || covered.has(path)) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
      covered.add(path)
    }
  }
  if (covered.size !== selected.size) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
}

export async function readReviewPreparation(store, taskId, recoverReceipt = false) {
  const task = await store.get(taskId)
  if (!task.reviewSnapshotId && !recoverReceipt) throw new TaskEntryError('REVIEW_NOT_PREPARED', 409)
  const { value, id } = await readReviewDocument(store, taskId, 'prepared.json')
  if (task.reviewSnapshotId && task.reviewSnapshotId !== id) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
  validate(value, task)
  return { ...value, id }
}

export async function readReviewDocument(store, taskId, name) {
  const { file } = await filePath(store, taskId, false, name)
  let handle, bytes
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) {
      throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    if (before.dev !== info.dev || before.ino !== info.ino || before.nlink !== 1) throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    bytes = await handle.readFile()
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409)
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new TaskEntryError('REVIEW_NOT_PREPARED', 409)
    throw error
  } finally { await handle?.close() }
  const id = sha256(bytes)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) }
  catch { throw new TaskEntryError('REVIEW_SNAPSHOT_INVALID', 409) }
  return { value, id }
}

export async function writeReviewDocument(store, taskId, name, value) {
  const { file } = await filePath(store, taskId, true, name)
  const bytes = Buffer.from(JSON.stringify(value))
  if (bytes.length > MAX_BYTES) throw new TaskEntryError('REVIEW_INPUT_LIMIT', 409)
  const temporary = `${file}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null
    try { await link(temporary, file) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { await handle?.close(); await rm(temporary, { force: true }) }
  const receipt = await readReviewDocument(store, taskId, name)
  if (receipt.id !== sha256(bytes)) throw new TaskEntryError('REVIEW_RECORD_CONFLICT', 409)
  return { ...receipt.value, id: receipt.id }
}

export async function saveReviewPreparation(store, taskId, input, delegate) {
  const task = await store.get(taskId)
  const coverage = delegate.coverage.map((item, index) => {
    const entry = input.entries[index]
    return [entry.old?.path, entry.new?.path].filter(Boolean).some(sensitiveReviewPath)
      ? { ...item, status: 'excluded', ocrExcludeReason: 'secret_exclude' } : item
  })
  const selected = new Set(coverage.filter(item => item.status === 'pending_inference').map(item => item.path))
  const groups = delegate.groups.map(group => ({ ...group, files: group.files.filter(path => selected.has(path)) }))
    .filter(group => group.files.length)
  const entries = input.entries.map((entry, index) => coverage[index].status !== 'excluded' ? entry : {
    ...entry, diff: null, old: entry.old && { ...entry.old, content: null }, new: entry.new && { ...entry.new, content: null } })
  const { coverage: ignoredCoverage, groups: ignoredGroups, ...ocr } = delegate
  const value = { version: 1, taskId, projectId: task.projectId, input: { ...input, entries }, ocr, coverage, groups }
  validate(value, task)
  await writeReviewDocument(store, taskId, 'prepared.json', value)
  return readReviewPreparation(store, taskId, true)
}
