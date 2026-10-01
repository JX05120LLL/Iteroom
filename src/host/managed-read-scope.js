import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'

const MAX_FILE_BYTES = 256 * 1024

function within(parent, child) {
  const path = relative(parent, child)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
}

async function inspectPath(project, path) {
  let current = project
  let last
  const segments = path.split('/')
  const target = join(project, ...segments)
  try {
    for (const segment of segments) {
      current = join(current, segment)
      last = await lstat(current, { bigint: true })
      if (last.isSymbolicLink()) throw new TaskEntryError('READ_LINK_DENIED', 403)
      if (current !== target && !last.isDirectory()) {
        throw new TaskEntryError('READ_NOT_REGULAR', 400)
      }
    }
    if (!last.isFile()) throw new TaskEntryError('READ_NOT_REGULAR', 400)
    if (last.nlink > 1n) throw new TaskEntryError('READ_LINK_DENIED', 403)
    if (!within(project, await realpath(current))) throw new TaskEntryError('READ_PATH_DENIED', 403)
    return last
  } catch (error) {
    if (error instanceof TaskEntryError) throw error
    throw new TaskEntryError('READ_UNAVAILABLE', 409)
  }
}

/** Read one exact task-selected UTF-8 file. The observed hash is not a durable content snapshot. */
export async function readManagedFile(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'path,taskId'
    || typeof input.path !== 'string') throw new TaskEntryError('INVALID_READ_INPUT', 400)
  const task = await store.get(input.taskId)
  if (!task.paths.includes(input.path)) throw new TaskEntryError('READ_PATH_DENIED', 403)
  const { project } = await store.location()
  const value = await readManagedProjectFile(project, input.path)
  const { text, ...metadata } = value
  const observation = await store.recordRead(task.id, metadata)
  return { taskId: task.id, ...observation, text }
}

/** Internal reader; callers must first validate the selected path with the task input contract. */
export async function readManagedProjectFile(project, path) {
  const file = join(project, ...path.split('/'))
  const before = await inspectPath(project, path)
  if (before.size > BigInt(MAX_FILE_BYTES)) throw new TaskEntryError('READ_TOO_LARGE', 413)
  let handle
  let bytes
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw new TaskEntryError('READ_INPUT_CHANGED', 409)
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_FILE_BYTES) throw new TaskEntryError('READ_TOO_LARGE', 413)
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw new TaskEntryError('READ_INPUT_CHANGED', 409)
    bytes = buffer.subarray(0, length)
  } catch (error) {
    if (error instanceof TaskEntryError) throw error
    throw new TaskEntryError('READ_UNAVAILABLE', 409)
  } finally { await handle?.close() }
  const after = await inspectPath(project, path)
  if (!sameFile(before, after) || BigInt(bytes.length) !== after.size) throw new TaskEntryError('READ_INPUT_CHANGED', 409)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new TaskEntryError('READ_NOT_TEXT', 415) }
  if (text.includes('\0')) throw new TaskEntryError('READ_NOT_TEXT', 415)
  return {
    path, sha256: createHash('sha256').update(bytes).digest('hex'), text,
    byteLength: bytes.length, lineCount: text ? text.split('\n').length - Number(text.endsWith('\n')) : 0,
  }
}
