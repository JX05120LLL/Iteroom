import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, join, relative, sep, isAbsolute } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'
import { readManagedSnapshotFile } from './managed-snapshot.js'

const HEX = /^[0-9a-f]{64}$/
const digest = value => createHash('sha256').update(value).digest('hex')
const inside = (parent, child) => {
  const part = relative(parent, child)
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

async function validateSnapshot(store, task, candidate) {
  for (const item of candidate.changes) {
    if (/\.test\.[cm]?js$/.test(item.path)) throw new TaskEntryError('ARTIFACT_INVALID', 409)
    const source = await readManagedSnapshotFile(store, task.id, item.path)
    if (item.beforeSha256 !== source.sha256 || item.beforeBytes !== source.byteLength) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
  }
}

async function folder(store, taskId, create) {
  const location = await store.location()
  const root = join(dirname(dirname(location.file)), 'managed-artifacts-v1')
  const target = join(root, location.projectId, taskId)
  if (create) await mkdir(target, { recursive: true, mode: 0o700 })
  for (const path of [root, join(root, location.projectId), target]) {
    let info
    try { info = await lstat(path) }
    catch (error) { if (error.code === 'ENOENT') throw new TaskEntryError('ARTIFACT_NOT_FOUND', 404); throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || inside(location.project, await realpath(path))) {
      throw new TaskEntryError('ARTIFACT_LOCATION_UNSAFE', 503)
    }
  }
  return target
}

function validate(candidate, task) {
  if (!candidate || candidate.version !== 1 || candidate.taskId !== task.id
    || candidate.snapshotId !== task.snapshotId || !Array.isArray(candidate.changes)
    || candidate.changes.length < 1 || candidate.changes.length > task.paths.length
    || typeof candidate.patch !== 'string' || !candidate.patch
    || Buffer.byteLength(candidate.patch) > 1024 * 1024 || !candidate.patch.isWellFormed()
    || !HEX.test(candidate.sha256) || candidate.sha256 !== digest(candidate.patch)) {
    throw new TaskEntryError('ARTIFACT_INVALID', 409)
  }
  const seen = new Set()
  for (const item of candidate.changes) {
    if (!item || !task.paths.includes(item.path) || seen.has(item.path) || item.kind !== 'modified'
      || !HEX.test(item.beforeSha256) || !HEX.test(item.afterSha256)
      || !Number.isSafeInteger(item.beforeBytes) || item.beforeBytes < 0 || item.beforeBytes > 262144
      || !Number.isSafeInteger(item.afterBytes) || item.afterBytes < 0 || item.afterBytes > 262144) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    seen.add(item.path)
  }
}

export async function saveManagedArtifact(store, taskId, candidate) {
  const task = await store.get(taskId)
  if (task.kind !== 'modify' || !task.snapshotId) throw new TaskEntryError('ARTIFACT_TASK_INVALID', 409)
  validate(candidate, task)
  await validateSnapshot(store, task, candidate)
  const id = digest(JSON.stringify(candidate))
  const target = join(await folder(store, taskId, true), `${id}.json`)
  const temporary = `${target}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(candidate))
    await handle.sync()
    await handle.close(); handle = null
    try { await link(temporary, target) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { await handle?.close(); await rm(temporary, { force: true }) }
  await readManagedArtifact(store, taskId, id)
  return { id, changeCount: candidate.changes.length, sha256: candidate.sha256 }
}

export async function readManagedArtifact(store, taskId, artifactId) {
  if (!HEX.test(artifactId)) throw new TaskEntryError('ARTIFACT_ID_INVALID', 400)
  const task = await store.get(taskId)
  const target = join(await folder(store, taskId, false), `${artifactId}.json`)
  let bytes
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024 + 8192) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || opened.size !== info.size) {
        throw new TaskEntryError('ARTIFACT_INVALID', 409)
      }
      bytes = await handle.readFile()
      const after = await handle.stat()
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw new TaskEntryError('ARTIFACT_INVALID', 409)
      }
    } finally { await handle.close() }
  } catch (error) {
    if (error.code === 'ENOENT') throw new TaskEntryError('ARTIFACT_NOT_FOUND', 404)
    throw error
  }
  let candidate
  try { candidate = JSON.parse(bytes.toString('utf8')) } catch { throw new TaskEntryError('ARTIFACT_INVALID', 409) }
  if (digest(bytes) !== artifactId) throw new TaskEntryError('ARTIFACT_INVALID', 409)
  validate(candidate, task)
  await validateSnapshot(store, task, candidate)
  return candidate
}
