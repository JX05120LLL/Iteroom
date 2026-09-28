import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, relative, sep, isAbsolute } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'
import { readManagedFile } from './managed-read-scope.js'

const ID = /^[0-9a-f]{64}$/
const MAX_MANIFEST = 16 * 1024

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function within(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function directory(path, project) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || within(project, await realpath(path))) {
    throw new TaskEntryError('SNAPSHOT_LOCATION_UNSAFE', 503)
  }
}

async function paths(store, task) {
  const location = await store.location()
  const root = join(store.dataHome, 'managed-snapshots-v1')
  const project = join(root, location.projectId)
  const final = join(project, task.id)
  return { location, root, project, final }
}

function manifestId(taskId, files) { return sha256(JSON.stringify({ taskId, files })) }

async function loadSnapshot(store, task) {
  const { location, final } = await paths(store, task)
  let dir
  try { dir = await lstat(final) }
  catch (error) {
    if (error.code === 'ENOENT') return null
    throw new TaskEntryError('SNAPSHOT_INVALID', 409)
  }
  if (!dir.isDirectory() || dir.isSymbolicLink() || !within(store.dataHome, await realpath(final))
    || within(location.project, await realpath(final))) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
  let manifest
  try {
    const manifestPath = join(final, 'manifest.json')
    const before = await lstat(manifestPath)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('manifest type')
    const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MANIFEST) throw Error('manifest type or size')
      manifest = JSON.parse(await handle.readFile('utf8'))
      const after = await handle.stat()
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw Error('manifest changed')
    } finally { await handle.close() }
    const afterPath = await lstat(manifestPath)
    if (afterPath.dev !== before.dev || afterPath.ino !== before.ino) throw Error('manifest replaced')
  } catch { throw new TaskEntryError('SNAPSHOT_INVALID', 409) }
  if (manifest?.version !== 1 || manifest.taskId !== task.id || manifest.projectId !== location.projectId
    || !Array.isArray(manifest.files) || manifest.files.length !== task.paths.length
    || !task.paths.every((path, i) => manifest.files[i]?.path === path
      && ID.test(manifest.files[i]?.sha256)
      && Number.isSafeInteger(manifest.files[i]?.byteLength)
      && manifest.files[i].byteLength >= 0 && manifest.files[i].byteLength <= 262144
      && Number.isSafeInteger(manifest.files[i]?.lineCount) && manifest.files[i].lineCount >= 0)
    || manifest.id !== manifestId(task.id, manifest.files)
    || task.snapshotId && task.snapshotId !== manifest.id) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
  return { manifest, final }
}

async function checkedCopy(final, index, file) {
  const path = join(final, `${index}.txt`)
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('copy type')
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.byteLength) throw Error('copy size')
      bytes = await handle.readFile()
      if (bytes.length !== file.byteLength || sha256(bytes) !== file.sha256) throw Error('copy hash')
      const afterRead = await handle.stat()
      if (afterRead.size !== stat.size || afterRead.mtimeMs !== stat.mtimeMs
        || afterRead.ctimeMs !== stat.ctimeMs) throw Error('copy changed during read')
    } finally { await handle.close() }
    const after = await lstat(path)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('copy changed')
    return bytes
  } catch { throw new TaskEntryError('SNAPSHOT_INVALID', 409) }
}

/** Capture only selected UTF-8 inputs. Existing snapshots win; changed workspace files are never recaptured. */
export async function captureManagedSnapshot(store, taskId) {
  const task = await store.get(taskId)
  const initial = await loadSnapshot(store, task)
  if (initial) {
    for (const [index, file] of initial.manifest.files.entries()) await checkedCopy(initial.final, index, file)
    if (!task.snapshotId) await store.attachSnapshot(taskId, initial.manifest.id)
    return initial.manifest
  }
  if (task.snapshotId) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
  const inputs = []
  for (const path of task.paths) inputs.push(await readManagedFile(store, { taskId, path }))
  const files = inputs.map(({ path, sha256, byteLength, lineCount }) => ({ path, sha256, byteLength, lineCount }))
  const { location, root, project, final } = await paths(store, task)
  await directory(root, location.project)
  await directory(project, location.project)
  const lockPath = join(project, `${task.id}.lock`)
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) }
  catch (error) {
    if (error.code === 'EEXIST') throw new TaskEntryError('SNAPSHOT_BUSY', 503)
    throw error
  }
  let temporary
  try {
    const current = await store.get(taskId)
    const existing = await loadSnapshot(store, current)
    if (existing) {
      for (const [index, file] of existing.manifest.files.entries()) await checkedCopy(existing.final, index, file)
      if (!current.snapshotId) await store.attachSnapshot(taskId, existing.manifest.id)
      return existing.manifest
    }
    if (current.snapshotId) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
    const manifest = { version: 1, taskId, projectId: location.projectId,
      id: manifestId(taskId, files), files }
    temporary = await mkdtemp(join(project, `${task.id}.tmp-`))
    for (const [index, input] of inputs.entries()) {
      await writeFile(join(temporary, `${index}.txt`), input.text, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
    await rename(temporary, final)
    temporary = null
    await store.attachSnapshot(taskId, manifest.id)
    return manifest
  } finally {
    if (temporary && within(project, temporary)) await rm(temporary, { recursive: true, force: true })
    await lock.close()
    await rm(lockPath, { force: true })
  }
}

/** A tool must use this API, never the live project path. The returned line numbers refer to the fixed bytes. */
export async function readManagedSnapshotFile(store, taskId, path) {
  const task = await store.get(taskId)
  if (!task.paths.includes(path)) throw new TaskEntryError('SNAPSHOT_PATH_DENIED', 403)
  const loaded = await loadSnapshot(store, task)
  if (!loaded || !task.snapshotId) throw new TaskEntryError('SNAPSHOT_NOT_READY', 409)
  const index = loaded.manifest.files.findIndex(file => file.path === path)
  const file = loaded.manifest.files[index]
  const bytes = await checkedCopy(loaded.final, index, file)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new TaskEntryError('SNAPSHOT_INVALID', 409) }
  if (text.includes('\0')) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
  return { taskId, snapshotId: loaded.manifest.id, ...file, text }
}
