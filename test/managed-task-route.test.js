import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { createManagedTaskRoutes } from '../src/host/managed-task-route.js'

const url = 'http://127.0.0.1:3000/api/iteroom/managed-tasks'
const carrierUrl = 'http://dsh.internal/api/iteroom/managed-tasks/create'
const body = { requestId: 'request-1', kind: 'understand', objective: 'Explain README', paths: ['README.md'] }

test('route creates and reads a task with no-store responses, and retries are idempotent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# Synthetic\n')
  const [readRoute, eventRoute, createRoute, fileRoute, snapshotRoute] = createManagedTaskRoutes(new ManagedTaskStore(join(root, 'data'), project))
  assert.equal(createRoute.requestBody, 'streaming', 'the carrier must not prebuffer a large request')
  assert.equal(readRoute.requestBody, 'buffered', 'the carrier can construct a GET Request without a stream body')
  const post = payload => createRoute.fetch(new Request(carrierUrl, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: JSON.stringify(payload) }))
  const created = await post(body)
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const first = await created.json()
  assert.equal(first.task.engineStatus, 'not_started')
  const retry = await post(body)
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).task.id, first.task.id)
  const list = await readRoute.fetch(new Request(url))
  assert.equal(list.status, 200)
  assert.equal((await list.json()).tasks.length, 1)
  const detail = await readRoute.fetch(new Request(`${url}?taskId=${first.task.id}`))
  assert.equal((await detail.json()).task.id, first.task.id)
  const initialEvents = await eventRoute.fetch(new Request(`${url}/events?taskId=${first.task.id}&after=0`))
  assert.equal(initialEvents.status, 200)
  assert.deepEqual((await initialEvents.json()).events.map(event => event.type), ['created'])
  assert.equal((await eventRoute.fetch(new Request(`${url}/events?taskId=${first.task.id}&after=-1`))).status, 400)
  assert.equal((await readRoute.fetch(new Request(`${url}?taskId=missing`))).status, 400)
  assert.equal(fileRoute.requestBody, 'streaming')
  const filePost = (payload, headers = {}) => fileRoute.fetch(new Request('http://dsh.internal/api/iteroom/managed-tasks/read', {
    method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
  }))
  const fileResponse = await filePost({ taskId: first.task.id, path: 'README.md' })
  assert.equal(fileResponse.status, 200)
  assert.equal(fileResponse.headers.get('cache-control'), 'no-store')
  assert.equal((await fileResponse.json()).text, '# Synthetic\n')
  assert.equal((await filePost({ taskId: first.task.id, path: 'other.txt' })).status, 403)
  assert.equal((await filePost({ taskId: first.task.id, path: 'README.md' }, { origin: 'http://foreign.example' })).status, 403)
  assert.equal((await filePost({ taskId: first.task.id, path: 'README.md', extra: true })).status, 400)
  const oversizedRead = new Request('http://dsh.internal/api/iteroom/managed-tasks/read', {
    method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json' }, body: 'x'.repeat(8193),
  })
  assert.equal((await fileRoute.fetch(oversizedRead)).status, 413)
  const snapshotPost = (payload, headers = {}) => snapshotRoute.fetch(new Request('http://dsh.internal/api/iteroom/managed-tasks/snapshot', {
    method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
      'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
  }))
  assert.equal((await snapshotPost({ taskId: first.task.id, path: 'README.md' })).status, 400)
  assert.equal((await snapshotPost({ taskId: first.task.id }, { origin: 'http://foreign.example' })).status, 403)
  const captured = await snapshotPost({ taskId: first.task.id })
  assert.equal(captured.status, 200)
  assert.match((await captured.json()).snapshot.id, /^[0-9a-f]{64}$/)
  assert.equal((await snapshotPost({ taskId: first.task.id })).status, 200)
  const sourceRoute = createManagedTaskRoutes(new ManagedTaskStore(join(root, 'data'), project))
    .find(route => route.path.endsWith('/source'))
  const source = await sourceRoute.fetch(new Request(`http://dsh.internal/api/iteroom/managed-tasks/source?taskId=${first.task.id}&path=README.md`))
  assert.equal(source.status, 200)
  assert.equal((await source.json()).text, '# Synthetic\n')
  assert.equal((await sourceRoute.fetch(new Request(`http://dsh.internal/api/iteroom/managed-tasks/source?taskId=${first.task.id}&path=.env`))).status, 403)
})

test('route rejects cross-origin, invalid JSON and oversized input before persistence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const [readRoute, , createRoute] = createManagedTaskRoutes(new ManagedTaskStore(join(root, 'data'), project))
  const request = (payload, headers = {}) => new Request(carrierUrl, { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...headers }, body: payload })
  assert.equal((await createRoute.fetch(request(JSON.stringify(body), { origin: 'http://foreign.example' }))).status, 403)
  assert.equal((await createRoute.fetch(request('{bad json'))).status, 400)
  assert.equal((await createRoute.fetch(request('x'.repeat(8193)))).status, 413)
  assert.equal((await createRoute.fetch(request(JSON.stringify(body), { 'content-type': 'text/plain' }))).status, 415)
  assert.deepEqual((await (await readRoute.fetch(new Request(url))).json()).tasks, [])
})

test('run actions require same-origin bounded JSON and delegate only exact task/request identifiers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const calls = []
  const coordinator = { start: async (...args) => { calls.push(['start', ...args]); return { id: args[0] } },
    cancel: async (...args) => { calls.push(['cancel', ...args]); return { id: args[0] } } }
  const routes = createManagedTaskRoutes(new ManagedTaskStore(join(root, 'data'), project), coordinator)
  const start = routes.find(route => route.path.endsWith('/start'))
  const cancel = routes.find(route => route.path.endsWith('/cancel'))
  const post = (route, payload, origin = 'http://127.0.0.1:3000') => route.fetch(new Request(`http://dsh.internal${route.path}`, {
    method: 'POST', headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  assert.equal((await post(start, { taskId: 'task-1', requestId: 'start-1' }, 'http://foreign.example')).status, 403)
  assert.equal((await post(start, { taskId: 'task-1', requestId: 'start-1', extra: true })).status, 400)
  assert.equal((await post(start, { taskId: 'task-1', requestId: 'start-1' })).status, 202)
  assert.equal((await post(cancel, { taskId: 'task-1', requestId: 'cancel-1' })).status, 200)
  assert.deepEqual(calls, [['start', 'task-1', 'start-1'], ['cancel', 'task-1', 'cancel-1']])
})
