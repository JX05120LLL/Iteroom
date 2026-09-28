import fs, { lstat, realpath, readFile, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { failure } from './ocr-process.mjs'

const validState = (state, identity) => state && typeof state === 'object' && !Array.isArray(state)
  && Object.keys(state).length === 2 && state.identity === identity
  && Number.isSafeInteger(state.attempts) && state.attempts >= 0 && state.attempts <= 6
async function ordinaryFile(path) {
  let stat
  try { stat = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw failure('model_budget_file_unsafe')
  return true
}

// R0-only private experiment storage; no credential or request-body storage.
export async function openModelBudgetJournal({ root, identity }) {
  if (typeof root !== 'string' || !isAbsolute(root) || dirname(resolve(root)) !== resolve(tmpdir())
    || !/^iteroom-r0-model-budget-[A-Za-z0-9-]+$/.test(basename(root))
    || typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity)) throw failure('unmanaged_model_budget_root')
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== resolve(root)) throw failure('unmanaged_model_budget_root')
  const record = join(root, 'budget.json'), lockPath = join(root, 'budget.lock'), nonce = randomUUID()
  let lock
  try { lock = await fs.open(lockPath, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw failure('model_budget_locked')
    throw failure('model_budget_lock_failed')
  }
  let state, poisoned = false, closing = false, closed = false, queue = Promise.resolve()
  const persist = async next => {
    await ordinaryFile(record)
    const temporary = join(root, `.budget-${nonce}.tmp`)
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync() } finally { await handle.close() }
    await ordinaryFile(record)
    await rename(temporary, record)
    state = Object.freeze({ ...next })
  }
  const release = async () => {
    // Do not remove a replaced/foreign lock even on the failure path.
    try {
      if (!await ordinaryFile(lockPath) || await readFile(lockPath, 'utf8') !== nonce) throw failure('model_budget_lock_changed')
    } finally { await lock.close() }
    await unlink(lockPath); closed = true
  }
  try {
    await lock.writeFile(nonce); await lock.sync()
    if (await ordinaryFile(record)) {
      const stat = await lstat(record)
      if (stat.size > 512) throw failure('model_budget_record_invalid')
      try { state = JSON.parse(await readFile(record, 'utf8')) } catch { throw failure('model_budget_record_invalid') }
      if (!validState(state, identity)) throw failure('model_budget_record_invalid')
      state = Object.freeze(state)
    } else await persist({ identity, attempts: 0 })
  } catch (error) {
    try { await release() } catch (cleanupError) { error.cleanupCode = cleanupError.code ?? 'model_budget_release_failed' }
    throw error
  }
  return {
    get state() { return Object.freeze({ ...state }) },
    commit(next) {
      // Capture primitive state now; callers cannot mutate it while queued.
      if (!validState(next, identity)) return Promise.reject(failure('model_budget_sequence_invalid'))
      const requested = { identity, attempts: next.attempts }
      const pending = queue.then(async () => {
        if (poisoned || closing || closed) throw failure('model_budget_write_failed')
        if (requested.attempts !== state.attempts + 1) throw failure('model_budget_sequence_invalid')
        try { await persist(requested) } catch { poisoned = true; throw failure('model_budget_write_failed') }
      })
      queue = pending.catch(() => {})
      return pending
    },
    async close() {
      if (closed) return
      closing = true; await queue; await release()
    },
  }
}
