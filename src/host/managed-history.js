import { TaskEntryError } from './managed-task-store.js'
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, relative, sep, isAbsolute } from 'node:path'

const within = (root, path) => {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

async function removeTaskFolder(root, projectId, taskId, project, dataHome) {
  const target = join(root, projectId, taskId)
  let rootInfo, projectInfo, info
  try { rootInfo = await lstat(root) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || !within(await realpath(dataHome), await realpath(root))) {
    throw new TaskEntryError('HISTORY_LOCATION_UNSAFE', 503)
  }
  try { projectInfo = await lstat(join(root, projectId)) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
    throw new TaskEntryError('HISTORY_LOCATION_UNSAFE', 503)
  }
  try { info = await lstat(target) }
  catch (error) { if (error.code === 'ENOENT') return; throw error }
  const actualRoot = await realpath(root)
  const actualTarget = await realpath(target)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || !projectInfo.isDirectory() || projectInfo.isSymbolicLink()
    || !info.isDirectory() || info.isSymbolicLink()
    || !within(await realpath(dataHome), actualRoot) || !within(actualRoot, actualTarget)
    || !within(await realpath(join(root, projectId)), actualTarget)
    || actualTarget === project || actualTarget.startsWith(`${project}${sep}`)) {
    throw new TaskEntryError('HISTORY_LOCATION_UNSAFE', 503)
  }
  let count = 0
  async function inspect(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (++count > 1024 || entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) {
        throw new TaskEntryError('HISTORY_LOCATION_UNSAFE', 503)
      }
      if (entry.isDirectory()) await inspect(join(folder, entry.name))
    }
  }
  await inspect(target)
  await rm(target, { recursive: true, force: true })
}

export class ManagedHistory {
  constructor(store, { removeFolder = removeTaskFolder } = {}) { this.store = store; this.removeFolder = removeFolder }
  async delete(taskId, requestId) {
    await this.store.markHistoryDeleting(taskId, requestId)
    const location = await this.store.location()
    for (const name of ['managed-artifacts-v1', 'managed-snapshots-v1', 'managed-reviews-v1']) {
      const root = join(this.store.dataHome, name)
      try { await this.removeFolder(root, location.projectId, taskId, location.project, this.store.dataHome) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await this.store.forgetHistory(taskId, requestId)
    return { deleted: true, taskId }
  }
}
