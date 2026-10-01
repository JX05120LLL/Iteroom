import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { TaskEntryError } from './managed-task-store.js'

const ROUTE = 'https://api.deepseek.com/chat/completions'
const HEADERS = new Set(['authorization', 'content-type', 'accept', 'user-agent',
  'x-deepseek-harness-user-id', 'x-deepseek-harness-session-id', 'x-deepseek-harness-compact'])
const FIELDS = new Set(['model', 'messages', 'tools', 'tool_choice', 'max_tokens', 'stream',
  'stream_options', 'thinking', 'temperature', 'stop'])
const TOOL_ARGUMENTS = {
  iteroom_read_snapshot: { path: 'string', startLine: 'number', endLine: 'number' },
  iteroom_replace_file: { path: 'string', content: 'string' },
  iteroom_run_tests: {},
  iteroom_review_context: { groupId: 'number' },
}
const TOOL_PROFILES = {
  read: ['iteroom_read_snapshot'],
  modify: ['iteroom_read_snapshot', 'iteroom_replace_file', 'iteroom_run_tests'],
  review: ['iteroom_review_context'],
}

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keysWithin(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.has(key)) }
function validToolCall(call, allowed) {
  if (!keysWithin(call, new Set(['id', 'type', 'function'])) || call.type !== 'function'
    || !keysWithin(call.function, new Set(['name', 'arguments']))
    || !allowed.includes(call.function.name)
    || typeof call.function.arguments !== 'string' || call.function.arguments.length > 4096) return false
  let args
  try { args = JSON.parse(call.function.arguments) } catch { return false }
  const expected = TOOL_ARGUMENTS[call.function.name]
  return keysWithin(args, new Set(Object.keys(expected)))
    && Object.keys(args).sort().join(',') === Object.keys(expected).sort().join(',')
    && Object.entries(expected).every(([key, type]) => type === 'number'
      ? Number.isSafeInteger(args[key]) : typeof args[key] === 'string')
    && (args.path === undefined || args.path.length <= 240)
    && (args.content === undefined || args.content.length <= 262144)
}
function validTool(tool, allowed) {
  if (!keysWithin(tool, new Set(['type', 'function'])) || tool.type !== 'function'
    || !keysWithin(tool.function, new Set(['name', 'description', 'parameters']))
    || !allowed.includes(tool.function.name)) return false
  const parameters = tool.function.parameters
  const expected = TOOL_ARGUMENTS[tool.function.name]
  return plain(parameters) && parameters.type === 'object'
    && plain(parameters.properties)
    && Object.keys(parameters.properties).sort().join(',') === Object.keys(expected).sort().join(',')
    && Object.entries(expected).every(([key, type]) => parameters.properties[key]?.type === type)
    && (Array.isArray(parameters.required) ? parameters.required.slice().sort().join(',') : '')
      === Object.keys(expected).sort().join(',')
}
function validBody(body, maxOutputTokens, allowed) {
  if (!keysWithin(body, FIELDS) || body.model !== 'deepseek-flash' || body.stream !== true
    || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxOutputTokens
    || !plain(body.thinking) || body.thinking.type !== 'disabled' || Object.keys(body.thinking).length !== 1
    || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 32
    || !Array.isArray(body.tools) || body.tools.length !== allowed.length
    || body.tools.map(tool => tool?.function?.name).sort().join(',') !== allowed.slice().sort().join(',')
    || !body.tools.every(tool => validTool(tool, allowed))) return false
  for (const message of body.messages) {
    if (!keysWithin(message, new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name']))
      || !['system', 'user', 'assistant', 'tool'].includes(message.role)
      || !(typeof message.content === 'string' || message.role === 'assistant'
        && message.content === null && Array.isArray(message.tool_calls))
      || message.tool_calls !== undefined && (message.role !== 'assistant'
        || !Array.isArray(message.tool_calls) || message.tool_calls.length < 1
        || message.tool_calls.length > 4 || !message.tool_calls.every(call => validToolCall(call, allowed)))
      || message.tool_call_id !== undefined && (typeof message.tool_call_id !== 'string'
        || message.tool_call_id.length > 512)
      || message.name !== undefined && !allowed.includes(message.name)) return false
  }
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)
    && !(plain(body.tool_choice) && body.tool_choice.type === 'function'
      && allowed.includes(body.tool_choice.function?.name))) return false
  if (body.stream_options !== undefined && (!plain(body.stream_options)
    || body.stream_options.include_usage !== true || Object.keys(body.stream_options).length !== 1)) return false
  if (body.temperature !== undefined && (!Number.isFinite(body.temperature)
    || body.temperature < 0 || body.temperature > 2)) return false
  return true
}

/** Reserve each bounded provider request on disk before transport. This is a request cap, not provider-side billing control. */
export async function createManagedModelGuard({ home, transport, maxRequests = 4,
  maxOutputTokens = 256, maxRequestBytes = 32768, toolProfile = 'read' } = {}) {
  if (!isAbsolute(home ?? '') || typeof transport !== 'function'
    || !Object.hasOwn(TOOL_PROFILES, toolProfile)
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 4
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 512
    || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 32768) {
    throw new TaskEntryError('MODEL_GUARD_CONFIG_INVALID', 503)
  }
  const allowed = TOOL_PROFILES[toolProfile]
  const identity = createHash('sha256').update(JSON.stringify({ route: ROUTE, model: 'deepseek-flash',
    maxRequests, maxOutputTokens, maxRequestBytes, toolProfile })).digest('hex')
  const journalPath = join(home, 'model-attempts.json')
  let attempts = 0
  try {
    const info = await lstat(journalPath)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 512) throw Error('unsafe journal')
    const state = JSON.parse(await readFile(journalPath, 'utf8'))
    if (state.identity !== identity || !Number.isSafeInteger(state.attempts)
      || state.attempts < 0 || state.attempts > maxRequests) throw Error('invalid journal')
    attempts = state.attempts
  } catch (error) {
    if (error.code !== 'ENOENT') throw new TaskEntryError('MODEL_JOURNAL_INVALID', 503)
  }
  let queue = Promise.resolve(), poisoned = false
  const guardedFetch = async (url, init = {}) => {
    init.signal?.throwIfAborted()
    if (url !== ROUTE || !keysWithin(init, new Set(['method', 'body', 'headers', 'signal']))
      || init.method !== 'POST' || typeof init.body !== 'string') {
      throw new TaskEntryError('MODEL_REQUEST_SCOPE_DENIED', 403)
    }
    const headers = new Headers(init.headers)
    if ([...headers.keys()].some(key => !HEADERS.has(key))
      || Buffer.byteLength(init.body) > maxRequestBytes) throw new TaskEntryError('MODEL_REQUEST_SCOPE_DENIED', 403)
    let body
    try { body = JSON.parse(init.body) } catch { throw new TaskEntryError('MODEL_REQUEST_SCOPE_DENIED', 403) }
    if (!validBody(body, maxOutputTokens, allowed)) throw new TaskEntryError('MODEL_REQUEST_SCOPE_DENIED', 403)
    const reserve = queue.then(async () => {
      if (poisoned) throw new TaskEntryError('MODEL_JOURNAL_INVALID', 503)
      init.signal?.throwIfAborted()
      if (attempts >= maxRequests) throw new TaskEntryError('MODEL_REQUEST_LIMIT', 409)
      const next = { identity, attempts: attempts + 1 }
      const temporary = join(home, `.model-attempts-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(JSON.stringify(next))
        await handle.sync()
        await handle.close(); handle = null
        await rename(temporary, journalPath)
        attempts = next.attempts
      } catch {
        poisoned = true
        throw new TaskEntryError('MODEL_JOURNAL_WRITE_FAILED', 503)
      } finally {
        await handle?.close()
        await rm(temporary, { force: true })
      }
    })
    queue = reserve.catch(() => {})
    await reserve
    return transport(ROUTE, { method: 'POST', body: init.body, headers,
      signal: init.signal, redirect: 'error' })
  }
  guardedFetch.snapshot = () => Object.freeze({ identity, attempts })
  return guardedFetch
}
