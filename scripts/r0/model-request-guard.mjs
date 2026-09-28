import { failure } from './ocr-process.mjs'
import { sha256 } from './review-files.mjs'

const FIELDS = new Set(['model', 'messages', 'tools', 'tool_choice', 'max_tokens', 'stream', 'stream_options', 'thinking', 'temperature', 'stop'])
const TOOL_PARAMETERS = { iteroom_read_fixture: 'path', iteroom_sandbox_probe: 'action' }
const HEADERS = new Set(['authorization', 'content-type', 'accept', 'user-agent',
  'x-deepseek-harness-user-id', 'x-deepseek-harness-session-id', 'x-deepseek-harness-compact'])
const objectWith = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(field => fields.includes(field))
const shortString = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const knownTool = name => Object.hasOwn(TOOL_PARAMETERS, name)
function validCall(call) {
  if (!objectWith(call, ['id', 'type', 'function']) || !shortString(call.id) || call.type !== 'function'
    || !objectWith(call.function, ['name', 'arguments']) || !knownTool(call.function.name)
    || typeof call.function.arguments !== 'string' || call.function.arguments.length > 4096) return false
  let args
  try { args = JSON.parse(call.function.arguments) } catch { return false }
  const parameter = TOOL_PARAMETERS[call.function.name]
  return objectWith(args, [parameter]) && shortString(args[parameter])
}
function validTool(tool) {
  if (!objectWith(tool, ['type', 'function']) || tool.type !== 'function'
    || !objectWith(tool.function, ['name', 'description', 'parameters']) || !knownTool(tool.function.name)
    || tool.function.description !== undefined && !shortString(tool.function.description)) return false
  const schema = tool.function.parameters, parameter = TOOL_PARAMETERS[tool.function.name]
  if (!objectWith(schema, ['type', 'properties', 'required', 'additionalProperties']) || schema.type !== 'object'
    || !objectWith(schema.properties, [parameter]) || !Array.isArray(schema.required)
    || schema.required.length !== 1 || schema.required[0] !== parameter
    || schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false
  const property = schema.properties[parameter]
  return objectWith(property, ['type', 'description', 'enum']) && property.type === 'string'
    && (property.description === undefined || shortString(property.description))
    && (property.enum === undefined || Array.isArray(property.enum) && property.enum.length > 0
      && property.enum.length <= 8 && property.enum.every(shortString))
}
export function createModelRequestGuard({ baseURL, model, authorized = false, maxRequests = 6,
  maxOutputTokens = 256, maxRequestBytes = 65536, commit, transport, state }) {
  const endpoint = new URL(baseURL)
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')
    || typeof model !== 'string' || !model || typeof commit !== 'function' || typeof transport !== 'function'
    || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 6
    || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 256
    || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 65536) throw failure('invalid_model_probe_limits')
  const route = endpoint.href.replace(/\/$/, '') + '/chat/completions'
  const identity = sha256(JSON.stringify({ route, model, maxRequests, maxOutputTokens, maxRequestBytes }))
  if (state && (state.identity !== identity || !Number.isSafeInteger(state.attempts) || state.attempts < 0 || state.attempts > maxRequests)) throw failure('model_budget_identity_mismatch')
  let attempts = state?.attempts ?? 0, poisoned = false, queue = Promise.resolve()
  const snapshot = () => Object.freeze({ identity, attempts })
  const fetch = async (url, init = {}) => {
    if (authorized !== true) throw failure('model_not_authorized')
    init.signal?.throwIfAborted()
    if (url !== route || !objectWith(init, ['method', 'body', 'headers', 'signal'])
      || init.method !== 'POST' || typeof init.body !== 'string') throw failure('model_request_scope_denied')
    const headers = new Headers(init.headers)
    if ([...headers.keys()].some(header => !HEADERS.has(header))) throw failure('model_request_scope_denied')
    if (Buffer.byteLength(init.body) > maxRequestBytes) throw failure('model_request_too_large')
    let body
    try { body = JSON.parse(init.body) } catch { throw failure('invalid_model_request_json') }
    if (!body || Array.isArray(body) || Object.keys(body).some(field => !FIELDS.has(field)) || body.model !== model
      || body.stream !== true || !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxOutputTokens
      || body.thinking?.type !== 'disabled' || Object.keys(body.thinking).length !== 1
      || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 32) throw failure('model_request_scope_denied')
    for (const message of body.messages) {
      if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)
        || Object.keys(message).some(field => !['role', 'content', 'tool_calls', 'tool_call_id', 'name'].includes(field))
        || !(typeof message.content === 'string' || message.role === 'assistant' && message.content === null && Array.isArray(message.tool_calls))
        || message.tool_calls !== undefined && (message.role !== 'assistant' || !Array.isArray(message.tool_calls)
          || !message.tool_calls.length || message.tool_calls.length > 2 || !message.tool_calls.every(validCall))
        || message.tool_call_id !== undefined && !shortString(message.tool_call_id)
        || message.name !== undefined && !knownTool(message.name)) throw failure('model_request_scope_denied')
    }
    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 2 || !body.tools.every(validTool))) throw failure('model_request_scope_denied')
    if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)
      && !(objectWith(body.tool_choice, ['type', 'function']) && body.tool_choice.type === 'function'
        && objectWith(body.tool_choice.function, ['name']) && knownTool(body.tool_choice.function.name))) throw failure('model_request_scope_denied')
    if (body.stream_options !== undefined && (!objectWith(body.stream_options, ['include_usage'])
      || body.stream_options.include_usage !== true)) throw failure('model_request_scope_denied')
    if (body.temperature !== undefined && (!Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) throw failure('model_request_scope_denied')
    if (body.stop !== undefined && !(shortString(body.stop) || Array.isArray(body.stop)
      && body.stop.length <= 4 && body.stop.every(shortString))) throw failure('model_request_scope_denied')
    const prepared = { method: 'POST', body: init.body, headers, signal: init.signal, redirect: 'error' }
    const reserve = queue.then(async () => {
      if (poisoned) throw failure('model_budget_write_failed')
      prepared.signal?.throwIfAborted()
      if (attempts >= maxRequests) throw failure('model_request_budget_exhausted')
      attempts++
      try { await commit(snapshot()) } catch { poisoned = true; throw failure('model_budget_write_failed') }
      prepared.signal?.throwIfAborted()
    })
    queue = reserve.catch(() => {})
    await reserve
    // A timeout/abort/error after reservation may have reached the provider.
    // Never refund it or automatically retry it.
    return transport(route, prepared)
  }
  fetch.snapshot = snapshot
  return fetch
}
