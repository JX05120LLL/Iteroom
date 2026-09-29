import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'
import { managedEnginePatch, managedModifyPatch } from './managed-engine-profile.js'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024
const MAX_ANSWER_BYTES = 64 * 1024
const SYSTEM_PROMPT = 'You are Iteroom, a read-only code assistant. Read selected fixed files with iteroom_read_snapshot, then answer concisely in at most 120 Chinese characters or 80 English words. Use the actual returned line range for citations. Do not repeat failed reads or discuss unavailable context at length. Never claim tests or commands ran.'

function within(parent, child) {
  const path = relative(parent, child)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function progressPipe(child, onText) {
  const pipe = child.stdio[3]
  if (!pipe) throw new TaskEntryError('ENGINE_PROGRESS_PIPE_MISSING', 503)
  let line = '', pending = '', total = 0, failure, timer
  let tail = Promise.resolve()
  const fail = error => {
    failure ??= error
    child.kill()
  }
  const flush = () => {
    clearTimeout(timer); timer = undefined
    if (!pending || !onText) { pending = ''; return }
    const text = pending; pending = ''
    tail = tail.then(() => onText(text)).catch(error => fail(error))
  }
  pipe.setEncoding('utf8')
  pipe.on('data', chunk => {
    if (failure) return
    line += chunk
    let newline
    while ((newline = line.indexOf('\n')) !== -1) {
      const raw = line.slice(0, newline); line = line.slice(newline + 1)
      let frame
      try { frame = JSON.parse(raw) } catch { fail(new TaskEntryError('ENGINE_PROGRESS_INVALID', 503)); return }
      if (Object.keys(frame ?? {}).sort().join(',') !== 'text,type' || frame.type !== 'text'
        || typeof frame.text !== 'string' || !frame.text || Buffer.byteLength(frame.text) > 4096) {
        fail(new TaskEntryError('ENGINE_PROGRESS_INVALID', 503)); return
      }
      total += Buffer.byteLength(frame.text)
      if (total > MAX_ANSWER_BYTES) { fail(new TaskEntryError('ENGINE_PROGRESS_LIMIT', 503)); return }
      pending += frame.text
      if (Buffer.byteLength(pending) >= 512) flush()
      else if (!timer) timer = setTimeout(flush, 150)
    }
    if (Buffer.byteLength(line) > 8192) fail(new TaskEntryError('ENGINE_PROGRESS_INVALID', 503))
  })
  return {
    async drain() {
      flush(); await tail
      if (failure) throw failure
      if (line) throw new TaskEntryError('ENGINE_PROGRESS_INVALID', 503)
    },
    async dispose() { flush(); await tail },
  }
}

function client(child, timeoutMs, signal) {
  const pending = new Map(), notifications = [], listeners = new Set()
  let nextId = 0, stdout = '', bytes = 0, stderrBytes = 0, ended = false, fatal
  const wake = () => { for (const listener of listeners) listener() }
  const fail = error => {
    fatal ??= error
    for (const pendingRequest of pending.values()) { clearTimeout(pendingRequest.timer); pendingRequest.reject(fatal) }
    pending.clear(); wake()
  }
  const exit = new Promise(resolveExit => {
    child.once('error', () => fail(new TaskEntryError('ENGINE_START_FAILED', 503)))
    child.once('close', code => {
      ended = true; resolveExit(code)
      fail(new TaskEntryError('ENGINE_PROCESS_CLOSED', 503))
    })
  })
  child.stdin.on('error', () => fail(new TaskEntryError('ENGINE_PIPE_CLOSED', 503)))
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length
    if (stderrBytes > 65536) { fail(new TaskEntryError('ENGINE_DIAGNOSTICS_LIMIT', 503)); child.kill() }
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > MAX_PROTOCOL_BYTES) { fail(new TaskEntryError('ENGINE_OUTPUT_LIMIT', 503)); child.kill(); return }
    stdout += chunk
    let newline
    while ((newline = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, newline).trim()
      stdout = stdout.slice(newline + 1)
      if (!line) continue
      try {
        const frame = JSON.parse(line)
        if (frame.jsonrpc !== '2.0') throw Error('bad frame')
        if (frame.id !== undefined) {
          const request = pending.get(frame.id)
          if (!request) throw Error('unknown request')
          pending.delete(frame.id); clearTimeout(request.timer)
          if (frame.error) request.reject(new TaskEntryError('ENGINE_RPC_FAILED', 503))
          else request.resolve(frame.result)
        } else if (frame.method === 'session.event' || frame.method === 'session.status') {
          notifications.push(frame)
          if (notifications.length > 2048) throw Error('notification limit')
          wake()
        } else throw Error('unexpected notification')
      } catch {
        fail(new TaskEntryError('ENGINE_PROTOCOL_INVALID', 503)); child.kill(); break
      }
    }
  })
  const abort = () => { fail(new TaskEntryError('ENGINE_CANCELLED', 409)); child.kill() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    if (fatal) { reject(fatal); return }
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new TaskEntryError('ENGINE_RPC_TIMEOUT', 503)) }, timeoutMs)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
  })
  const waitTurn = sessionId => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish(new TaskEntryError('ENGINE_TURN_TIMEOUT', 503)), timeoutMs)
    const finish = error => {
      clearTimeout(timer); listeners.delete(check)
      error ? reject(error) : resolveWait(notifications.filter(frame => frame.method === 'session.event'
        && frame.params?.sessionId === sessionId).map(frame => frame.params.event))
    }
    const check = () => {
      const own = notifications.filter(frame => frame.params?.sessionId === sessionId)
      const end = own.some(frame => frame.method === 'session.event' && frame.params.event?.type === 'turn/end')
      const statuses = own.filter(frame => frame.method === 'session.status').map(frame => frame.params.status)
      if (end && statuses.includes('running') && statuses.at(-1) === 'idle') finish()
      else if (fatal) finish(fatal)
    }
    listeners.add(check); check()
  })
  return { request, waitTurn,
    async shutdown() {
      if (!ended && !fatal) await request('shutdown')
      const timer = setTimeout(() => child.kill(), 3000)
      try { return await exit } finally { clearTimeout(timer) }
    },
    async dispose() {
      signal?.removeEventListener('abort', abort)
      if (!ended) {
        child.kill()
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
        try { await exit } finally { clearTimeout(timer) }
      }
      for (const pendingRequest of pending.values()) clearTimeout(pendingRequest.timer)
    },
  }
}

function summarize(events, task) {
  const end = events.findLast(event => event.type === 'turn/end')
  if (end?.data?.reason?.kind !== 'completed') throw new TaskEntryError('ENGINE_TURN_FAILED', 503)
  const answers = events.filter(event => event.type === 'assistant/message')
    .map(event => event.data?.message?.content?.filter(block => block.type === 'text').map(block => block.text).join(''))
    .filter(Boolean)
  const answer = answers.at(-1)
  if (!answer || Buffer.byteLength(answer) > MAX_ANSWER_BYTES) throw new TaskEntryError('ENGINE_ANSWER_INVALID', 503)
  const references = []
  for (const event of events.filter(item => item.type === 'tool/result')) {
    for (const block of event.data?.message?.content ?? []) {
      if (block.type !== 'tool-result') continue
      if (block.isError) throw new TaskEntryError('ENGINE_TOOL_FAILED', 503)
      for (const part of block.content ?? []) {
        if (part.type !== 'text') continue
        const match = /^Source: ([^\r\n]+)\nSnapshot: ([0-9a-f]{64})\nSHA-256: ([0-9a-f]{64})\nLines: (\d+)-(\d+)\n/.exec(part.text)
        if (!match || !task.paths.includes(match[1]) || match[2] !== task.snapshotId) {
          throw new TaskEntryError('ENGINE_REFERENCE_INVALID', 503)
        }
        const reference = { path: match[1], snapshotId: match[2], sha256: match[3],
          startLine: Number(match[4]), endLine: Number(match[5]) }
        if (!references.some(item => JSON.stringify(item) === JSON.stringify(reference))) references.push(reference)
      }
    }
  }
  if (!references.length) throw new TaskEntryError('ENGINE_NO_SOURCE_READ', 503)
  return { sessionId: task.id, turnEnd: 'completed', answer, references }
}

/** A single attempt: once its private home is created, restart must inspect history rather than replay. */
export async function runManagedUnderstand({ store, taskId, provider, model, modelKey,
  mockAdapterPath, signal, onReady, onText, onProcess, maxRequests = 3,
  maxOutputTokens = 256, timeoutMs = 120000 } = {}) {
  if (!store || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 4
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 512) {
    throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
  }
  if (mockAdapterPath) {
    if (provider !== 'iteroom-r1-mock' || model !== 'synthetic' || !isAbsolute(mockAdapterPath)) {
      throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
    }
  } else if (provider !== 'deepseek' || model !== 'deepseek-flash'
    || typeof modelKey !== 'string' || !modelKey) throw new TaskEntryError('MODEL_NOT_CONFIGURED', 503)
  const task = await store.get(taskId)
  if (!task.snapshotId) throw new TaskEntryError('SNAPSHOT_NOT_READY', 409)
  const selectedPaths = task.paths.map(path => {
    const lines = task.readObservations?.find(item => item.path === path)?.lineCount
    if (!Number.isSafeInteger(lines) || lines < 0) throw new TaskEntryError('SNAPSHOT_INVALID', 409)
    return `${path} (${lines} lines)`
  })
  const location = await store.location()
  const root = join(store.dataHome, 'managed-engine-v1')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || within(location.project, await realpath(root))) throw new TaskEntryError('ENGINE_LOCATION_UNSAFE', 503)
  const home = join(root, task.id)
  try { await mkdir(home, { mode: 0o700 }) }
  catch (error) {
    if (error.code === 'EEXIST') throw new TaskEntryError('ENGINE_ALREADY_ATTEMPTED', 409)
    throw error
  }
  const patch = managedEnginePatch({ dataHome: store.dataHome, projectRoot: location.project,
    taskId, mockAdapterPath })
  await writeFile(join(home, 'managed.patch.yml'), patch, { flag: 'wx', mode: 0o600 })
  const env = { DSH_HOME: home, DSH_SYSTEM_PROMPT: SYSTEM_PROMPT,
    ITEROOM_PROGRESS_FD: '3', ITEROOM_MODEL_MAX_REQUESTS: String(maxRequests),
    ITEROOM_MODEL_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value
  }
  if (modelKey) env.DEEPSEEK_API_KEY = modelKey
  const child = spawn(process.execPath, [cli, '--profile', 'sdk-minimal', '--patch', join(home, 'managed.patch.yml')], {
    cwd: location.project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  const rpc = client(child, timeoutMs, signal)
  const progress = progressPipe(child, onText)
  try {
    await onProcess?.(child.pid)
    const hello = await rpc.request('initialize', { cwd: location.project, provider, model,
      maxTokens: maxOutputTokens })
    if (hello?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new TaskEntryError('ENGINE_IDENTITY_INVALID', 503)
    const receipt = await rpc.request('session/prompt', { sessionId: task.id,
      contentBlocks: [{ type: 'text', text: `${task.objective}\nSelected fixed paths and exact line counts: ${selectedPaths.join(', ')}. Read the fixed snapshot before answering; request at most 120 lines per tool call.` }] })
    if (typeof receipt?.messageId !== 'string') throw new TaskEntryError('ENGINE_PROMPT_UNACKNOWLEDGED', 503)
    await onReady?.()
    const events = await rpc.waitTurn(task.id)
    const result = summarize(events, task)
    if (await rpc.shutdown() !== 0) throw new TaskEntryError('ENGINE_EXIT_FAILED', 503)
    await progress.drain()
    return result
  } finally { await rpc.dispose(); await progress.dispose() }
}

/** One isolated edit attempt. The Host owns allocation, verification and artifact export. */
export async function runManagedModify({ store, taskId, sandboxId, sandboxKey, provider, model, modelKey,
  mockAdapterPath, signal, onReady, maxRequests = 4, maxOutputTokens = 512, timeoutMs = 120000 } = {}) {
  if (!store || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 4
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 512
    || typeof sandboxKey !== 'string' || !sandboxKey) throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
  if (mockAdapterPath) {
    if (provider !== 'iteroom-r2-mock' || model !== 'synthetic' || !isAbsolute(mockAdapterPath)) {
      throw new TaskEntryError('ENGINE_CONFIG_INVALID', 400)
    }
  } else if (provider !== 'deepseek' || model !== 'deepseek-flash'
    || typeof modelKey !== 'string' || !modelKey) throw new TaskEntryError('MODEL_NOT_CONFIGURED', 503)
  const task = await store.get(taskId)
  if (task.kind !== 'modify' || task.sandboxId !== sandboxId || !task.snapshotId) {
    throw new TaskEntryError('SANDBOX_TASK_INVALID', 409)
  }
  const location = await store.location()
  const root = join(store.dataHome, 'managed-engine-v1')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || within(location.project, await realpath(root))) throw new TaskEntryError('ENGINE_LOCATION_UNSAFE', 503)
  const home = join(root, task.id)
  try { await mkdir(home, { mode: 0o700 }) }
  catch (error) {
    if (error.code === 'EEXIST') throw new TaskEntryError('ENGINE_ALREADY_ATTEMPTED', 409)
    throw error
  }
  await writeFile(join(home, 'managed.patch.yml'), managedModifyPatch({ dataHome: store.dataHome,
    projectRoot: location.project, taskId, sandboxId, mockAdapterPath }), { flag: 'wx', mode: 0o600 })
  const selected = task.paths.map(path => `${path} (${task.readObservations?.find(item => item.path === path)?.lineCount ?? '?'} lines)`)
  const env = { DSH_HOME: home,
    DSH_SYSTEM_PROMPT: 'You are Iteroom, working only in an isolated sandbox. Read the fixed selected source and test. Replace the selected non-test file with the smallest correction, then call iteroom_run_tests. Report the actual execution result briefly. Do not claim the host project changed. Do not run unrelated commands.',
    ITEROOM_SANDBOX_API_KEY: sandboxKey,
    ITEROOM_MODEL_MAX_REQUESTS: String(maxRequests), ITEROOM_MODEL_MAX_OUTPUT_TOKENS: String(maxOutputTokens) }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value
  }
  if (modelKey) env.DEEPSEEK_API_KEY = modelKey
  const child = spawn(process.execPath, [cli, '--profile', 'sdk-minimal', '--patch', join(home, 'managed.patch.yml')], {
    cwd: location.project, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  const rpc = client(child, timeoutMs, signal)
  const progress = progressPipe(child)
  try {
    const hello = await rpc.request('initialize', { cwd: location.project, provider, model,
      maxTokens: maxOutputTokens })
    if (hello?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new TaskEntryError('ENGINE_IDENTITY_INVALID', 503)
    const receipt = await rpc.request('session/prompt', { sessionId: task.id,
      contentBlocks: [{ type: 'text', text: `${task.objective}\nSelected fixed paths: ${selected.join(', ')}. Read source and test first. Use only the offered sandbox tools. Call iteroom_run_tests after the edit. Keep the final answer short.` }] })
    if (typeof receipt?.messageId !== 'string') throw new TaskEntryError('ENGINE_PROMPT_UNACKNOWLEDGED', 503)
    await onReady?.()
    const events = await rpc.waitTurn(task.id)
    const end = events.findLast(event => event.type === 'turn/end')
    if (end?.data?.reason?.kind !== 'completed') throw new TaskEntryError('ENGINE_TURN_FAILED', 503)
    const answer = events.filter(event => event.type === 'assistant/message')
      .map(event => event.data?.message?.content?.filter(block => block.type === 'text').map(block => block.text).join(''))
      .filter(Boolean).at(-1) ?? ''
    if (Buffer.byteLength(answer) > MAX_ANSWER_BYTES) throw new TaskEntryError('ENGINE_ANSWER_INVALID', 503)
    if (await rpc.shutdown() !== 0) throw new TaskEntryError('ENGINE_EXIT_FAILED', 503)
    await progress.drain()
    return { sessionId: task.id, turnEnd: 'completed', answer }
  } finally { await rpc.dispose(); await progress.dispose() }
}
