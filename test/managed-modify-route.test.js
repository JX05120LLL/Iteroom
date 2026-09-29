import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { createManagedTaskRoutes } from '../src/host/managed-task-route.js'

test('modify endpoints preserve carrier auth, origin, body and task scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r2-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'x.mjs'), 'export const x=1\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const calls = []
  const read = { initialize: async () => {}, start: async () => { throw Error('wrong coordinator') } }
  const modify = { initialize: async () => {}, start: async (...args) => {
    calls.push(args); return { id: args[0], kind: 'modify' }
  }, cancel: async () => ({}) }
  const routes = createManagedTaskRoutes(store, read, modify)
  const create = routes.find(item => item.path.endsWith('/create'))
  const start = routes.find(item => item.path.endsWith('/modify/start'))
  const artifact = routes.find(item => item.path.endsWith('/modify/artifact'))
  const request = (route, payload, origin = 'http://127.0.0.1:3000') => route.fetch(new Request(`http://dsh.internal${route.path}`,
    { method: 'POST', headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload) }))
  const created = await request(create, { requestId: 'modify-1', kind: 'modify', objective: 'Change x', paths: ['x.mjs'] })
  assert.equal(created.status, 201)
  const task = (await created.json()).task
  assert.equal((await request(start, { taskId: task.id, requestId: 'start-1' }, 'http://evil.example')).status, 403)
  assert.equal((await request(start, { taskId: task.id, requestId: 'start-1', extra: 1 })).status, 400)
  assert.equal(calls.length, 0)
  assert.equal((await request(start, { taskId: task.id, requestId: 'start-1' })).status, 202)
  assert.deepEqual(calls, [[task.id, 'start-1']])
  assert.equal((await artifact.fetch(new Request(`http://dsh.internal${artifact.path}?taskId=${task.id}`))).status, 409)
})

test('acceptance routes require same origin and exact decision input', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r3-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const calls = []
  const acceptance = { initialize: async () => {}, preview: async id => ({ taskId: id, files: [] }),
    accept: async (...args) => { calls.push(args); return { id: args[0], status: 'completed' } },
    discard: async () => ({}), recover: async () => ({}) }
  const routes = createManagedTaskRoutes(store, { initialize: async () => {} }, { initialize: async () => {} }, acceptance)
  const accept = routes.find(route => route.path.endsWith('/modify/accept'))
  assert.ok(accept)
  const request = (payload, origin = 'http://127.0.0.1:3000') => accept.fetch(new Request(`http://dsh.internal${accept.path}`,
    { method: 'POST', headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload) }))
  assert.equal((await request({ taskId: 'task-1', requestId: 'decision-1' }, 'http://evil.example')).status, 403)
  assert.equal((await request({ taskId: 'task-1', requestId: 'decision-1', extra: true })).status, 400)
  assert.equal((await request({ taskId: 'task-1', requestId: 'decision-1' })).status, 200)
  assert.deepEqual(calls, [['task-1', 'decision-1']])
})

test('history deletion route refuses cross-origin and extra fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r3-history-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const calls = []
  const history = { delete: async (...args) => { calls.push(args); return { deleted: true } } }
  const routes = createManagedTaskRoutes(store, {}, {}, {}, history)
  const route = routes.find(item => item.path.endsWith('/history/delete'))
  assert.ok(route)
  const request = (payload, origin = 'http://127.0.0.1:3000') => route.fetch(new Request(`http://dsh.internal${route.path}`,
    { method: 'POST', headers: { host: '127.0.0.1:3000', origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload) }))
  assert.equal((await request({ taskId: 'task-1', requestId: 'delete-1' }, 'http://evil.example')).status, 403)
  assert.equal((await request({ taskId: 'task-1', requestId: 'delete-1', extra: true })).status, 400)
  assert.equal((await request({ taskId: 'task-1', requestId: 'delete-1' })).status, 200)
  assert.deepEqual(calls, [['task-1', 'delete-1']])
})
