import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createManagedModelGuard } from '../src/host/managed-model-guard.js'

function request(text = 'Synthetic task') {
  return { method: 'POST', headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', stream: true, max_tokens: 128,
      thinking: { type: 'disabled' }, messages: [{ role: 'user', content: text }],
      tools: [{ type: 'function', function: { name: 'iteroom_read_snapshot', description: 'Read fixed text',
        parameters: { type: 'object', properties: { path: { type: 'string' },
          startLine: { type: 'number' }, endLine: { type: 'number' } },
        required: ['path', 'startLine', 'endLine'] } } }] }) }
}

test('managed model guard reserves before transport, persists count and refuses replay beyond cap', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iteroom-r1-model-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let calls = 0
  const transport = async (_url, init) => { calls++; assert.equal(init.redirect, 'error'); return new Response('ok') }
  const guard = await createManagedModelGuard({ home, transport, maxRequests: 2 })
  const route = 'https://api.deepseek.com/chat/completions'
  assert.equal((await guard(route, request())).status, 200)
  const reopened = await createManagedModelGuard({ home, transport, maxRequests: 2 })
  assert.equal(reopened.snapshot().attempts, 1)
  assert.equal((await reopened(route, request())).status, 200)
  await assert.rejects(reopened(route, request()), { code: 'MODEL_REQUEST_LIMIT' })
  assert.equal(calls, 2)
  assert.equal(JSON.parse(await readFile(join(home, 'model-attempts.json'), 'utf8')).attempts, 2)
})

test('managed model guard rejects scope changes before reservation and does not refund transport failures', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iteroom-r1-model-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let calls = 0
  const guard = await createManagedModelGuard({ home, maxRequests: 1,
    transport: async () => { calls++; throw Error('synthetic network failure') } })
  const route = 'https://api.deepseek.com/chat/completions'
  await assert.rejects(guard('https://foreign.example/chat/completions', request()), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  const broad = request()
  const body = JSON.parse(broad.body)
  body.tools.push({ type: 'function', function: { name: 'write', parameters: {} } })
  broad.body = JSON.stringify(body)
  await assert.rejects(guard(route, broad), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  const highOutput = request()
  highOutput.body = highOutput.body.replace('"max_tokens":128', '"max_tokens":257')
  await assert.rejects(guard(route, highOutput), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  await assert.rejects(guard(route, request('x'.repeat(33000))), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  assert.equal(guard.snapshot().attempts, 0)
  await assert.rejects(guard(route, request()), /synthetic network failure/)
  assert.equal(guard.snapshot().attempts, 1)
  await assert.rejects(guard(route, request()), { code: 'MODEL_REQUEST_LIMIT' })
  assert.equal(calls, 1)
})

test('explicit 512-token and four-request cap is enforced before transport', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iteroom-r1-model-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let calls = 0
  const guard = await createManagedModelGuard({ home, maxRequests: 4, maxOutputTokens: 512,
    transport: async () => { calls++; return new Response('ok') } })
  const route = 'https://api.deepseek.com/chat/completions'
  const request512 = request()
  const body = JSON.parse(request512.body)
  body.max_tokens = 512
  request512.body = JSON.stringify(body)
  const request513 = { ...request512, body: JSON.stringify({ ...body, max_tokens: 513 }) }
  await assert.rejects(guard(route, request513), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  for (let i = 0; i < 4; i++) assert.equal((await guard(route, request512)).status, 200)
  await assert.rejects(guard(route, request512), { code: 'MODEL_REQUEST_LIMIT' })
  assert.equal(calls, 4)
  assert.equal(JSON.parse(await readFile(join(home, 'model-attempts.json'), 'utf8')).attempts, 4)
})

test('modify profile permits only the three bounded sandbox tool schemas', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iteroom-r2-model-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let calls = 0
  const guard = await createManagedModelGuard({ home, toolProfile: 'modify', maxRequests: 1,
    transport: async () => { calls++; return new Response('ok') } })
  const route = 'https://api.deepseek.com/chat/completions'
  const bounded = request()
  const body = JSON.parse(bounded.body)
  body.tools.push({ type: 'function', function: { name: 'iteroom_replace_file',
    description: 'Replace selected sandbox file', parameters: { type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } })
  body.tools.push({ type: 'function', function: { name: 'iteroom_run_tests',
    description: 'Run fixed tests', parameters: { type: 'object', properties: {}, required: [] } } })
  body.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function',
    function: { name: 'iteroom_replace_file', arguments: JSON.stringify({ path: 'greet.mjs', content: 'fixed' }) } }] })
  body.messages.push({ role: 'tool', tool_call_id: 'call-1', name: 'iteroom_replace_file', content: 'done' })
  bounded.body = JSON.stringify(body)
  assert.equal((await guard(route, bounded)).status, 200)
  assert.equal(calls, 1)
  const extra = { ...bounded, body: JSON.stringify({ ...body, tools: [...body.tools,
    { type: 'function', function: { name: 'host_shell', parameters: {} } }] }) }
  await assert.rejects(guard(route, extra), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  assert.equal(calls, 1)
})

test('review profile accepts only fixed group reads and reserves capped requests before transport', async t => {
  const home = await mkdtemp(join(tmpdir(), 'iteroom-r4-model-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  let calls = 0
  const guard = await createManagedModelGuard({ home, toolProfile: 'review', maxRequests: 1, maxOutputTokens: 512,
    transport: async () => { calls++; return new Response('ok') } })
  const init = request(), body = JSON.parse(init.body), route = 'https://api.deepseek.com/chat/completions'
  body.tools = [{ type: 'function', function: { name: 'iteroom_review_context', description: 'Read fixed group',
    parameters: { type: 'object', properties: { groupId: { type: 'number' } }, required: ['groupId'] } } }]
  body.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'read-group', type: 'function',
    function: { name: 'iteroom_review_context', arguments: '{"groupId":1}' } }] })
  const post = value => guard(route, { ...init, body: JSON.stringify(value) })
  await assert.rejects(post({ ...body, max_tokens: 513 }), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  await assert.rejects(post({ ...body, tools: JSON.parse(request().body).tools }), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  const invalid = structuredClone(body)
  invalid.messages[1].tool_calls[0].function.arguments = '{"groupId":1,"path":"/private"}'
  await assert.rejects(post(invalid), { code: 'MODEL_REQUEST_SCOPE_DENIED' })
  assert.equal(calls, 0)
  assert.equal((await post(body)).status, 200)
  await assert.rejects(post(body), { code: 'MODEL_REQUEST_LIMIT' })
  assert.equal(calls, 1)
})
