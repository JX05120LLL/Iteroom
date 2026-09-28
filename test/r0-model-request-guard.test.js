import assert from 'node:assert/strict'
import { test } from 'node:test'

const baseURL = 'http://127.0.0.1:39101', model = 'synthetic-only'
const body = () => JSON.stringify({ model, stream: true, max_tokens: 128, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'synthetic probe' }] })
const request = () => [baseURL + '/chat/completions', { method: 'POST', body: body(), signal: new AbortController().signal }]
async function guard(options = {}) {
  const { createModelRequestGuard } = await import('../scripts/r0/model-request-guard.mjs')
  return createModelRequestGuard({ baseURL, model, authorized: true, commit: async () => {}, transport: async () => new Response('synthetic'), ...options })
}
test('unauthorized model guard refuses before persistence or HTTP', async () => {
  let touched = false
  const fetch = await guard({ authorized: false, commit: async () => { touched = true }, transport: async () => { touched = true } })
  await assert.rejects(fetch(...request()), { code: 'model_not_authorized' }); assert.equal(touched, false)
})
test('transport scope refuses changed endpoint, model, output budget, images and private extension fields', async () => {
  const fetch = await guard()
  await assert.rejects(fetch('https://unapproved.invalid/chat/completions', request()[1]))
  for (const extra of [{ model: 'other' }, { max_tokens: 257 }, { max_tokens: null }, { thinking: { type: 'enabled' } },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'private' } }] }] }, { dsh_session_log: 'private' }]) {
    await assert.rejects(fetch(request()[0], { ...request()[1], body: JSON.stringify({ ...JSON.parse(body()), ...extra }) }))
  }
  await assert.rejects(fetch(request()[0], { ...request()[1], body: 'x'.repeat(65537) }), { code: 'model_request_too_large' })
})
test('six concurrent attempts persist before HTTP and the seventh is refused', async () => {
  let committed = 0, sent = 0
  const fetch = await guard({ commit: async state => { await new Promise(done => setTimeout(done, 2)); committed = state.attempts },
    transport: async (_url, init) => { assert.ok(committed > sent); assert.equal(init.redirect, 'error'); sent++; return new Response('synthetic') } })
  await Promise.all(Array.from({ length: 6 }, () => fetch(...request())))
  await assert.rejects(fetch(...request()), { code: 'model_request_budget_exhausted' })
  assert.equal(sent, 6); assert.equal(fetch.snapshot().attempts, 6)
})
test('unapproved fetch connection options and routing headers are refused before reserving or sending', async () => {
  let sent = 0
  const fetch = await guard({ transport: async () => { sent++ } })
  for (const extra of [{ dispatcher: {} }, { redirect: 'follow' }, { headers: { Host: 'unapproved.invalid' } },
    { headers: { Cookie: 'synthetic-private-cookie' } }, { headers: { 'Proxy-Authorization': 'synthetic' } }]) {
    await assert.rejects(fetch(request()[0], { ...request()[1], ...extra }), { code: 'model_request_scope_denied' })
  }
  assert.equal(fetch.snapshot().attempts, 0); assert.equal(sent, 0)
})
test('nested tool calls and tool schemas accept only fixed function structure and string probe arguments', async () => {
  const fetch = await guard()
  const tool = { type: 'function', function: { name: 'iteroom_sandbox_probe', description: 'Synthetic operation',
    parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false } } }
  const call = { id: 'synthetic-call', type: 'function', function: { name: 'iteroom_sandbox_probe', arguments: '{"action":"repair"}' } }
  const valid = { ...JSON.parse(body()), tools: [tool], messages: [{ role: 'assistant', content: null, tool_calls: [call] }] }
  for (const extra of [
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'image_url', image_url: { url: 'private' } }] }] },
    { tools: [{ ...tool, function: { ...tool.function, private_extension: 'private' } }] },
    { tools: [{ ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, $ref: 'private' } } }] },
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ ...call, function: { ...call.function, arguments: '{"action":{"image_url":"private"}}' } }] }] },
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ ...call, function: { ...call.function, name: 'shell' } }] }] },
    { tool_choice: { type: 'function', function: { name: 'iteroom_sandbox_probe', private_extension: 'private' } } },
    { stream_options: { include_usage: true, private_extension: 'private' } },
  ]) await assert.rejects(fetch(request()[0], { ...request()[1], body: JSON.stringify({ ...valid, ...extra }) }), { code: 'model_request_scope_denied' })
  assert.equal(fetch.snapshot().attempts, 0)
  await fetch(request()[0], { ...request()[1], body: JSON.stringify(valid) })
  assert.equal(fetch.snapshot().attempts, 1)
})
test('failed HTTP attempts remain reserved when a saved counter is reloaded, and a mismatched record is refused', async () => {
  let state
  const fetch = await guard({ maxRequests: 1, commit: async next => { state = next }, transport: async () => { throw Error('synthetic transport failure') } })
  await assert.rejects(fetch(...request())); assert.equal(state.attempts, 1)
  const restarted = await guard({ maxRequests: 1, state })
  await assert.rejects(restarted(...request()), { code: 'model_request_budget_exhausted' })
  await assert.rejects(guard({ state, model: 'changed' }), { code: 'model_budget_identity_mismatch' })
})
test('journal failure permanently prevents HTTP, and an already-aborted request consumes no attempt', async () => {
  let sent = 0
  const fetch = await guard({ commit: async () => { throw Error('synthetic write failure') }, transport: async () => { sent++ } })
  await assert.rejects(fetch(...request()), { code: 'model_budget_write_failed' })
  await assert.rejects(fetch(...request()), { code: 'model_budget_write_failed' }); assert.equal(sent, 0)
  const clean = await guard(), controller = new AbortController(); controller.abort()
  await assert.rejects(clean(request()[0], { ...request()[1], signal: controller.signal }))
  assert.equal(clean.snapshot().attempts, 0)
})
test('fixed official adapter serializes bounded synthetic HTTP and preserves real local SSE and error contracts', async () => {
  const { runModelTransportProbe } = await import('../scripts/r0/model-transport-probe.mjs')
  const report = await runModelTransportProbe()
  assert.equal(report.status, 'passed')
  assert.equal(report.actualModel, false)
  assert.equal(report.gateA, 'not_completed')
  assert.equal(report.requests, 3)
  for (const key of ['boundedOutput', 'thinkingDisabled', 'textSseParsed', 'httpAuthErrorPreserved', 'abortAttemptRetained', 'clientDisconnectObserved', 'loopbackOnly', 'serverStopped']) assert.equal(report.checks[key], true, key)
  assert.doesNotMatch(JSON.stringify(report), /apiKey|Bearer|AppData|"messages"/)
})
