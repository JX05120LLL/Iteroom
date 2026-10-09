import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagedTaskRoutes } from '../src/host/managed-task-route.js'
import { TaskEntryError } from '../src/host/managed-task-store.js'

const base = 'http://dsh.internal/api/iteroom/runtime'
const config = { image: `node@sha256:${'a'.repeat(64)}`, key: 'synthetic-sandbox-secret',
  connectionConfig: { domain: '127.0.0.1:3088', protocol: 'http', apiKey: 'synthetic-sandbox-secret' } }

async function setup(options = {}) {
  const initial = createManagedTaskRoutes({ projectRoot: process.cwd() })
  assert.ok(initial.find(route => route.path === '/api/iteroom/runtime'), 'runtime status endpoint is missing')
  const { ManagedRuntimeStatus } = await import('../src/host/managed-runtime-status.js')
  const runtime = new ManagedRuntimeStatus({ projectRoot: process.cwd(),
    env: {},
    modelKey: async () => null,
    sandboxConfig: async () => { throw new TaskEntryError('SANDBOX_NOT_CONFIGURED', 503) }, ...options })
  const routes = createManagedTaskRoutes({ projectRoot: process.cwd() }, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, runtime)
  return { runtime, get: routes.find(route => route.path === '/api/iteroom/runtime'),
    check: routes.find(route => route.path === '/api/iteroom/runtime/sandbox-check') }
}

function post(body = {}, headers = {}) {
  return new Request(base + '/sandbox-check', { method: 'POST',
    headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body) })
}

test('unconfigured runtime is readable without task initialization or a network request', async () => {
  const { get, check } = await setup({ probe: async () => assert.fail('must not probe without config') })
  const response = await get.fetch(new Request(base))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const status = await response.json()
  assert.equal(status.model.status, 'missing')
  assert.equal(status.sandbox.configuration, 'missing')
  assert.equal(status.sandbox.service, 'not_checked')
  assert.deepEqual(status.budgets.understand, { maxRequests: 3, maxOutputTokens: 256 })
  assert.deepEqual(status.budgets.modify, { maxRequests: 4, maxOutputTokens: 512 })
  assert.equal((await (await check.fetch(post())).json()).sandbox.service, 'not_checked')
})

test('configured credentials are redacted and GET does not check a service or account', async () => {
  let calls = 0
  const { get, check } = await setup({ modelKey: async () => 'synthetic-model-secret', sandboxConfig: async () => config,
    budgets: { understand: { maxRequests: 2, maxOutputTokens: 128 } },
    probe: async () => { calls++ } })
  const response = await get.fetch(new Request(base))
  const text = await response.text(), status = JSON.parse(text)
  assert.equal(status.model.status, 'configured')
  assert.equal(status.model.accountVerified, false)
  assert.equal(status.sandbox.configuration, 'configured')
  assert.equal(status.sandbox.service, 'not_checked')
  assert.deepEqual(status.budgets.understand, { maxRequests: 2, maxOutputTokens: 128 })
  assert.doesNotMatch(text, /synthetic-.*secret|apiKey|keyFile|connectionConfig/)
  assert.equal(calls, 0)
  const checked = await (await check.fetch(post())).json()
  assert.equal(checked.sandbox.service, 'available')
  assert.ok(checked.sandbox.checkedAt)
  assert.equal(calls, 1)
})

test('invalid configuration and raw service failures never expose credentials or file paths', async () => {
  const { get } = await setup({ modelKey: async () => { throw Error('secret /private/key.json') },
    sandboxConfig: async () => { throw Error('secret /private/sandbox-key') } })
  const status = await (await get.fetch(new Request(base))).json()
  assert.equal(status.model.status, 'invalid')
  assert.equal(status.sandbox.configuration, 'invalid')
  assert.doesNotMatch(JSON.stringify(status), /secret|private/)
  const { check } = await setup({ sandboxConfig: async () => config, probe: async () => { throw Error('synthetic-sandbox-secret') } })
  const checked = await (await check.fetch(post())).json()
  assert.equal(checked.sandbox.service, 'unavailable')
  assert.equal(checked.sandbox.code, 'SANDBOX_SERVICE_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(checked), /synthetic-sandbox-secret/)
})

test('explicit invalid inputs are distinguished from missing configuration without changing loader fallback', async () => {
  const env = { DEEPSEEK_API_KEY: 'malformed', ITEROOM_SANDBOX_KEY_FILE: 'relative-private-key',
    ITEROOM_SANDBOX_IMAGE: 'unpinned-image' }
  const { runtime } = await setup({ env })
  const status = await runtime.inspect()
  assert.equal(status.model.status, 'invalid')
  assert.equal(status.sandbox.configuration, 'invalid')
  assert.doesNotMatch(JSON.stringify(status), /malformed|private|unpinned/)
  runtime.modelKey = async () => 'valid-fallback-key'
  assert.equal((await runtime.inspect()).model.status, 'configured')
})

test('service check times out and concurrent clicks share one read-only probe', async () => {
  let calls = 0
  const { check } = await setup({ sandboxConfig: async () => config, timeoutMs: 40,
    probe: async () => { calls++; await new Promise(() => {}) } })
  const responses = await Promise.all([check.fetch(post()), check.fetch(post())])
  for (const response of responses) {
    const status = await response.json()
    assert.equal(status.sandbox.service, 'unavailable')
    assert.equal(status.sandbox.code, 'SANDBOX_SERVICE_TIMEOUT')
  }
  assert.equal(calls, 1)
})

test('service checks reject cross-origin requests, extra input and query parameters before inspection', async () => {
  let reads = 0
  const { get, check } = await setup({ modelKey: async () => { reads++; return null } })
  assert.equal((await check.fetch(post({}, { origin: 'http://foreign.invalid' }))).status, 403)
  assert.equal((await check.fetch(post({ address: 'https://foreign.invalid' }))).status, 400)
  assert.equal((await get.fetch(new Request(base + '?check=1'))).status, 400)
  assert.equal((await check.fetch(post({}, { 'content-type': 'text/plain' }))).status, 415)
  assert.equal(reads, 0)
})

test('default probe only lists one filtered page and always closes the SDK client', async () => {
  const { runtime } = await setup()
  let closed = 0, options, query
  const sdk = { SandboxManager: { create(input) { options = input; return {
    async listSandboxInfos(input) { query = input; return { items: [] } },
    async close() { closed++ },
  } } } }
  assert.equal(await runtime.probe(config, sdk), undefined)
  assert.equal(options.connectionConfig.domain, '127.0.0.1:3088')
  assert.equal(options.connectionConfig.requestTimeoutSeconds, 3)
  assert.deepEqual(query, { metadata: { 'iteroom-status-probe': 'true' }, page: 1, pageSize: 1 })
  assert.equal(closed, 1)
  sdk.SandboxManager.create = () => ({ listSandboxInfos: async () => { throw Error('private') }, close: async () => { closed++ } })
  await assert.rejects(runtime.probe(config, sdk))
  assert.equal(closed, 2)
  await assert.rejects(runtime.probe({ ...config, connectionConfig: { ...config.connectionConfig, domain: 'external.invalid' } }, sdk))
})

test('probe transport refuses redirects, external targets and non-list actions', async () => {
  const { runtime } = await setup()
  let guardedFetch, redirectMode
  const sdk = {
    createDefaultAdapterFactory: () => ({ createLifecycleStack(options) {
      guardedFetch = options.connectionConfig.fetch
      return { sandboxes: {} }
    } }),
    SandboxManager: { create(options) {
      assert.ok(options.adapterFactory, 'probe must constrain the SDK HTTP transport')
      options.adapterFactory.createLifecycleStack({ connectionConfig: { fetch: async (_, init) => {
        redirectMode = init.redirect; return new Response('{}')
      } } })
      return { listSandboxInfos: async () => {
        await guardedFetch(new Request('http://127.0.0.1:3088/v1/sandboxes'))
        return { items: [] }
      }, close: async () => {} }
    } },
  }
  await runtime.probe(config, sdk)
  assert.equal(redirectMode, 'error')
  await assert.rejects(guardedFetch(new Request('https://external.invalid/v1/sandboxes')))
  await assert.rejects(guardedFetch(new Request('http://127.0.0.1:3088/v1/sandboxes', { method: 'POST' })))
  await assert.rejects(guardedFetch(new Request('http://127.0.0.1:3088/v1/credentials')))
})

for (const phase of ['headers', 'body']) test(`actual SDK ${phase} timeout aborts transport and closes every client`, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let calls = 0, cancelled = 0, closed = 0
  globalThis.fetch = async (input, init) => {
    calls++
    if (phase === 'headers') return new Promise((_, reject) => {
      const signal = init?.signal ?? input.signal
      signal.addEventListener('abort', () => { cancelled++; reject(signal.reason) }, { once: true })
    })
    return new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled++ } }),
      { headers: { 'Content-Type': 'application/json' } })
  }
  const sdk = await import('@alibaba-group/opensandbox')
  const instrumented = { ...sdk, SandboxManager: { create(options) {
    const manager = sdk.SandboxManager.create(options), close = manager.close.bind(manager)
    manager.close = async () => { closed++; await close() }
    return manager
  } } }
  let runtime
  ;({ runtime } = await setup({ sandboxConfig: async () => config, timeoutMs: 40,
    probe: (value, options) => runtime.probe(value, instrumented, options) }))
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runtime.inspect({ checkSandbox: true })
    assert.equal(result.sandbox.code, 'SANDBOX_SERVICE_TIMEOUT')
    for (let wait = 0; runtime.pendingProbe && wait < 20; wait++) await new Promise(done => setTimeout(done, 5))
    assert.equal(runtime.pendingProbe, null, 'retry starts only after the previous client has closed')
    assert.equal(closed, attempt + 1)
  }
  await new Promise(done => setTimeout(done, 50))
  assert.equal(calls, 2)
  assert.equal(cancelled, 2, 'both timed out HTTP streams must be cancelled')
  assert.equal(closed, 2, 'both SDK clients must reach finally/close')
})

test('probe response size limit cancels the stream and closes the actual SDK client', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let cancelled = 0, closed = 0
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65537)) }, cancel() { cancelled++ },
  }), { headers: { 'Content-Type': 'application/json' } })
  const sdk = await import('@alibaba-group/opensandbox')
  const instrumented = { ...sdk, SandboxManager: { create(options) {
    const manager = sdk.SandboxManager.create(options), close = manager.close.bind(manager)
    manager.close = async () => { closed++; await close() }; return manager
  } } }
  let runtime
  ;({ runtime } = await setup({ sandboxConfig: async () => config,
    probe: (value, options) => runtime.probe(value, instrumented, options) }))
  const status = await runtime.inspect({ checkSandbox: true })
  assert.equal(status.sandbox.code, 'SANDBOX_SERVICE_UNAVAILABLE')
  assert.equal(cancelled, 1)
  assert.equal(closed, 1)
})

test('timed out checks coalesce while actual SDK transport and client cleanup are pending', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const delay = ms => new Promise(done => setTimeout(done, ms))
  let calls = 0, cancelled = 0, closed = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(new ReadableStream({ pull: () => new Promise(() => {}),
      async cancel() { await delay(30); cancelled++ },
    }), { headers: { 'Content-Type': 'application/json' } })
  }
  const sdk = await import('@alibaba-group/opensandbox')
  const instrumented = { ...sdk, SandboxManager: { create(options) {
    const manager = sdk.SandboxManager.create(options), close = manager.close.bind(manager)
    manager.close = async () => { await delay(30); await close(); closed++ }; return manager
  } } }
  let runtime
  ;({ runtime } = await setup({ sandboxConfig: async () => config, timeoutMs: 20,
    probe: (value, options) => runtime.probe(value, instrumented, options) }))
  assert.equal((await runtime.inspect({ checkSandbox: true })).sandbox.code, 'SANDBOX_SERVICE_TIMEOUT')
  assert.ok(runtime.pendingProbe, 'cleanup must retain the probe record until SDK close settles')
  assert.equal((await runtime.inspect({ checkSandbox: true })).sandbox.code, 'SANDBOX_SERVICE_TIMEOUT')
  assert.equal(calls, 1)
  await delay(100)
  assert.equal(cancelled, 1)
  assert.equal(closed, 1)
  assert.equal(runtime.pendingProbe, null)
})
