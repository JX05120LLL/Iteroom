import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, sep, isAbsolute } from 'node:path'
import { readManagedArtifact } from './managed-artifact.js'
import { TaskEntryError } from './managed-task-store.js'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root, path) => {
  const part = relative(root, path)
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** R2 emits one whole-file hunk per changed file. Reject every other patch dialect. */
function materialize(artifact) {
  const lines = artifact.patch.split('\n')
  if (lines.pop() !== '') throw new TaskEntryError('ARTIFACT_INVALID', 409)
  let cursor = 0
  const files = []
  for (const change of artifact.changes) {
    const path = change.path
    if (lines[cursor++] !== `diff --git a/${path} b/${path}`
      || lines[cursor++] !== `--- a/${path}` || lines[cursor++] !== `+++ b/${path}`) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[cursor++] ?? '')
    if (!hunk || ![hunk[1], hunk[3]].every(start => start === '0' || start === '1')) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    const before = [], after = []
    let beforeTrailing = true, afterTrailing = true, previous = ''
    while (cursor < lines.length && !lines[cursor].startsWith('diff --git ')) {
      const line = lines[cursor++]
      if (line.startsWith('-')) { before.push(line.slice(1)); previous = '-' }
      else if (line.startsWith('+')) { after.push(line.slice(1)); previous = '+' }
      else if (line === '\\ No newline at end of file' && previous) {
        if (previous === '-') beforeTrailing = false
        else afterTrailing = false
        previous = ''
      } else throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    if (Number(hunk[2]) !== before.length || Number(hunk[4]) !== after.length
      || hunk[1] !== (before.length ? '1' : '0') || hunk[3] !== (after.length ? '1' : '0')) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    const beforeBytes = Buffer.from(before.join('\n') + (before.length && beforeTrailing ? '\n' : ''))
    const afterBytes = Buffer.from(after.join('\n') + (after.length && afterTrailing ? '\n' : ''))
    if (hash(beforeBytes) !== change.beforeSha256 || beforeBytes.length !== change.beforeBytes
      || hash(afterBytes) !== change.afterSha256 || afterBytes.length !== change.afterBytes) {
      throw new TaskEntryError('ARTIFACT_INVALID', 409)
    }
    files.push({ path, beforeBytes, afterBytes, beforeSha256: change.beforeSha256,
      afterSha256: change.afterSha256 })
  }
  if (cursor !== lines.length) throw new TaskEntryError('ARTIFACT_INVALID', 409)
  return files
}

async function readTarget(project, path) {
  const target = join(project, ...path.split('/'))
  if (!within(project, target) || target === project) throw new TaskEntryError('ACCEPT_PATH_UNSAFE', 409)
  let parent = project
  for (const segment of path.split('/').slice(0, -1)) {
    parent = join(parent, segment)
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink() || !within(project, await realpath(parent))) {
      throw new TaskEntryError('ACCEPT_PATH_UNSAFE', 409)
    }
  }
  let info, handle, bytes
  try {
    info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 262144) {
      throw new TaskEntryError('ACCEPT_PATH_UNSAFE', 409)
    }
    handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1) {
      throw new TaskEntryError('ACCEPT_PATH_UNSAFE', 409)
    }
    bytes = await handle.readFile()
    const after = await handle.stat()
    const current = await lstat(target)
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new TaskEntryError('ACCEPT_CONFLICT', 409)
    }
  } catch (error) {
    if (error.code === 'ENOENT') throw new TaskEntryError('ACCEPT_CONFLICT', 409)
    throw error
  } finally { await handle?.close() }
  return { target, bytes, info }
}

async function replaceTarget(project, file, expected, replacement) {
  const current = await readTarget(project, file.path)
  if (hash(current.bytes) !== expected) throw new TaskEntryError('ACCEPT_CONFLICT', 409)
  const temporary = join(dirname(current.target), `.iteroom-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', current.info.mode & 0o777)
    await handle.writeFile(replacement)
    await handle.sync()
    await handle.close(); handle = null
    const latest = await readTarget(project, file.path)
    if (latest.info.dev !== current.info.dev || latest.info.ino !== current.info.ino
      || hash(latest.bytes) !== expected) throw new TaskEntryError('ACCEPT_CONFLICT', 409)
    await rename(temporary, current.target)
  } finally { await handle?.close(); await rm(temporary, { force: true }) }
}

async function verifyTargets(project, files, side) {
  for (const file of files) {
    const current = await readTarget(project, file.path)
    if (hash(current.bytes) !== (side === 'before' ? file.beforeSha256 : file.afterSha256)) {
      throw new TaskEntryError('ACCEPT_CONFLICT', 409)
    }
  }
}

export class ManagedAcceptance {
  constructor(store, { afterWrite = async () => {} } = {}) {
    this.store = store; this.afterWrite = afterWrite; this.active = new Set(); this.decisions = new Set()
  }

  async #withDecision(taskId, action) {
    if (this.decisions.has(taskId)) throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
    this.decisions.add(taskId)
    try { return await action() }
    finally { this.decisions.delete(taskId) }
  }

  async initialize() {
    for (const task of await this.store.list()) {
      if (task.status === 'applying' && !this.active.has(task.id)) {
        await this.store.updateAcceptance(task.id, current => { current.status = 'interrupted'; current.endedAt = new Date().toISOString() })
      }
    }
  }

  async files(taskId) {
    const task = await this.store.get(taskId)
    if (task.kind !== 'modify' || !task.artifactId) throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
    const artifact = await readManagedArtifact(this.store, taskId, task.artifactId)
    return { task, files: materialize(artifact), project: (await this.store.location()).project }
  }

  async preview(taskId) {
    const { task, files, project } = await this.files(taskId)
    if (!['awaiting_review', 'applying', 'interrupted', 'completed', 'discarded'].includes(task.status)) {
      throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
    }
    const result = []
    for (const file of files) {
      let status = 'conflict'
      try {
        const current = await readTarget(project, file.path)
        const digest = hash(current.bytes)
        status = digest === file.beforeSha256 ? 'ready' : digest === file.afterSha256 ? 'applied' : 'conflict'
      } catch (error) {
        if (!(error instanceof TaskEntryError)) throw error
      }
      result.push({ path: file.path, status })
    }
    return { taskId, files: result, verification: task.executions?.find(item => item.id === task.verificationId) ?? null }
  }

  async accept(taskId, requestId) {
    return this.#withDecision(taskId, () => this.#acceptCandidate(taskId, requestId))
  }

  async #acceptCandidate(taskId, requestId) {
    await this.initialize()
    const { task, files, project } = await this.files(taskId)
    if (task.status === 'completed' && task.acceptance?.requestId === requestId) return task
    if (task.status !== 'awaiting_review') throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
    const preview = await this.preview(taskId)
    if (preview.files.some(item => item.status !== 'ready')) throw new TaskEntryError('ACCEPT_CONFLICT', 409)
    this.active.add(taskId)
    try {
      await this.store.beginAcceptance(taskId, requestId, files.map(file => ({ path: file.path,
        beforeSha256: file.beforeSha256, afterSha256: file.afterSha256 })))
    } catch (error) { this.active.delete(taskId); throw error }
    try {
      for (const [index, file] of files.entries()) {
        await this.store.updateAcceptance(taskId, current => { current.acceptance.entries[index].state = 'writing' })
        await replaceTarget(project, file, file.beforeSha256, file.afterBytes)
        await this.store.updateAcceptance(taskId, current => { current.acceptance.entries[index].state = 'written' })
        await this.afterWrite(index)
      }
      await verifyTargets(project, files, 'after')
      return await this.store.updateAcceptance(taskId, current => {
        current.status = 'completed'; current.endedAt = new Date().toISOString()
      })
    } catch (error) {
      await this.store.updateAcceptance(taskId, current => {
        current.status = 'interrupted'; current.endedAt = new Date().toISOString()
      })
      throw error
    } finally { this.active.delete(taskId) }
  }

  async discard(taskId, requestId) {
    return this.#withDecision(taskId, async () => {
      await this.initialize()
      const task = await this.store.get(taskId)
      if (task.artifactId) await this.files(taskId)
      return this.store.discardArtifact(taskId, requestId)
    })
  }

  async recover(taskId, requestId, mode) {
    return this.#withDecision(taskId, () => this.#recoverCandidate(taskId, requestId, mode))
  }

  async #recoverCandidate(taskId, requestId, mode) {
    await this.initialize()
    if (!['finish', 'rollback'].includes(mode)) throw new TaskEntryError('INVALID_ACCEPT_INPUT', 400)
    const { task, files, project } = await this.files(taskId)
    if (['completed', 'discarded'].includes(task.status)
      && task.acceptance?.recoveryRequestId === requestId
      && task.acceptance.mode === (mode === 'rollback' ? 'rollback' : 'accept')) return task
    if (task.status !== 'interrupted' || !task.acceptance || this.active.has(taskId)) {
      throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
    }
    if (task.acceptance.recoveryRequestId && (task.acceptance.recoveryRequestId !== requestId
      || task.acceptance.mode !== (mode === 'rollback' ? 'rollback' : 'accept'))) {
      throw new TaskEntryError('ACCEPT_STATE_CONFLICT', 409)
    }
    const preview = await this.preview(taskId)
    if (preview.files.some(item => item.status === 'conflict')) throw new TaskEntryError('ACCEPT_CONFLICT', 409)
    this.active.add(taskId)
    try {
      await this.store.updateAcceptance(taskId, current => {
        current.status = 'applying'; current.acceptance.mode = mode === 'rollback' ? 'rollback' : 'accept'
        current.acceptance.recoveryRequestId = requestId
      })
    } catch (error) { this.active.delete(taskId); throw error }
    try {
      for (const [index, file] of files.entries()) {
        const targetHash = mode === 'rollback' ? file.beforeSha256 : file.afterSha256
        const fromHash = mode === 'rollback' ? file.afterSha256 : file.beforeSha256
        const current = await readTarget(project, file.path)
        if (hash(current.bytes) === targetHash) {
          await this.store.updateAcceptance(taskId, state => {
            state.acceptance.entries[index].state = mode === 'rollback' ? 'rolled_back' : 'written'
          })
          continue
        }
        await this.store.updateAcceptance(taskId, state => { state.acceptance.entries[index].state = 'writing' })
        await replaceTarget(project, file, fromHash, mode === 'rollback' ? file.beforeBytes : file.afterBytes)
        await this.store.updateAcceptance(taskId, state => {
          state.acceptance.entries[index].state = mode === 'rollback' ? 'rolled_back' : 'written'
        })
        await this.afterWrite(index)
      }
      await verifyTargets(project, files, mode === 'rollback' ? 'before' : 'after')
      return await this.store.updateAcceptance(taskId, current => {
        current.status = mode === 'rollback' ? 'discarded' : 'completed'
        current.endedAt = new Date().toISOString()
      })
    } catch (error) {
      await this.store.updateAcceptance(taskId, current => {
        current.status = 'interrupted'; current.endedAt = new Date().toISOString()
      })
      throw error
    } finally { this.active.delete(taskId) }
  }
}
