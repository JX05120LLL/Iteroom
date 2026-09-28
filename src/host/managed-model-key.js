import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'

function within(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Credential remains outside the project and is never returned through HTTP. */
export async function loadManagedModelKey(projectRoot, env = process.env) {
  if (typeof env.DEEPSEEK_API_KEY === 'string' && /^sk-[A-Za-z0-9_-]{6,}$/.test(env.DEEPSEEK_API_KEY)) {
    return env.DEEPSEEK_API_KEY
  }
  const path = env.ITEROOM_MODEL_KEY_FILE
  if (!path) return null
  if (typeof path !== 'string' || !isAbsolute(path)) throw new TaskEntryError('MODEL_KEY_FILE_INVALID', 503)
  try {
    const project = await realpath(projectRoot)
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > 4096n || within(project, await realpath(path))) throw Error('unsafe key file')
    const bytes = await readFile(path)
    const after = await lstat(path, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('key file changed')
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (config?.provider !== 'deepseek-official' || config.baseURL !== 'https://api.deepseek.com'
      || config.model !== 'deepseek-flash' || typeof config.apiKey !== 'string'
      || !/^sk-[A-Za-z0-9_-]{6,}$/.test(config.apiKey)) throw Error('unsupported model config')
    return config.apiKey
  } catch { throw new TaskEntryError('MODEL_KEY_FILE_INVALID', 503) }
}
