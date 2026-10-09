import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { ManagedTaskCoordinator } from '../src/host/managed-task-coordinator.js'
import { ManagedHistory } from '../src/host/managed-history.js'

async function fixture(t, run) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-coordinator-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# Synthetic\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'create-1', kind: 'understand',
    objective: 'Explain selected README', paths: ['README.md'] })).task
  const coordinator = new ManagedTaskCoordinator(store, { run, modelKey: async () => 'synthetic-key' })
  return { root, project, store, task, coordinator }
}

test('start captures a fixed input and calls the engine only once across repeated requests', async t => {
  let calls = 0
  const { project, store, task, coordinator } = await fixture(t, async ({ taskId, store: current, onReady, onText }) => {
    calls++
    await onReady()
    await onText('Synthetic partial answer')
    const own = await current.get(taskId)
    return { sessionId: taskId, turnEnd: 'completed', answer: 'Synthetic heading (README.md:1-1).',
      references: [{ path: 'README.md', snapshotId: own.snapshotId,
        sha256: own.readObservations[0].sha256, startLine: 1, endLine: 1 }] }
  })
  const first = await coordinator.start(task.id, 'start-1')
  assert.equal(first.status, 'running')
  await coordinator.start(task.id, 'start-1')
  await coordinator.whenIdle(task.id)
  assert.equal(calls, 1)
  assert.equal((await store.get(task.id)).status, 'completed')
  assert.match((await store.get(task.id)).answer, /Synthetic heading/)
  assert.equal((await store.get(task.id)).draft, 'Synthetic partial answer')
  assert.deepEqual((await store.eventsAfter(task.id, 0)).events.filter(event => event.type === 'draft')
    .map(event => event.text), ['Synthetic partial answer'])
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), '# Synthetic\n')
  await assert.rejects(coordinator.start(task.id, 'start-1'), { code: 'RUN_ALREADY_STARTED' })
  const reopened = new ManagedTaskStore(store.dataHome, project)
  assert.equal((await reopened.get(task.id)).status, 'completed')
})

test('cancel waits for the read-only engine to stop before marking the task cancelled', async t => {
  let stopped = false
  const { store, task, coordinator } = await fixture(t, ({ signal, onReady }) => new Promise((resolve, reject) => {
    void onReady()
    signal.addEventListener('abort', () => {
      stopped = true
      reject(Object.assign(new Error('stopped'), { code: 'ENGINE_CANCELLED' }))
    }, { once: true })
  }))
  await coordinator.start(task.id, 'start-1')
  const cancelled = await coordinator.cancel(task.id, 'cancel-1')
  assert.equal(stopped, true)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await store.get(task.id)).status, 'cancelled')
})

test('missing model configuration does not claim or snapshot the task', async t => {
  const { store, task } = await fixture(t, async () => { throw Error('must not run') })
  const coordinator = new ManagedTaskCoordinator(store, { modelKey: async () => null })
  await assert.rejects(coordinator.start(task.id, 'start-1'), { code: 'MODEL_NOT_CONFIGURED' })
  assert.equal((await store.get(task.id)).status, 'queued')
  assert.equal((await store.get(task.id)).snapshotId, null)
})

test('a queued understand task can be cancelled after missing configuration, releasing the project without starting an engine', async t => {
  const { store, task, project } = await fixture(t, async () => assert.fail('must not run'))
  let keyReads = 0
  const coordinator = new ManagedTaskCoordinator(store, {
    modelKey: async () => { keyReads++; return null }, run: async () => assert.fail('must not run'),
  })
  await assert.rejects(coordinator.start(task.id, 'start-missing'), { code: 'MODEL_NOT_CONFIGURED' })
  const cancelled = await coordinator.cancel(task.id, 'cancel-queued')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.engineStatus, 'not_started')
  assert.equal(cancelled.sessionId, null)
  assert.equal(cancelled.snapshotId, null)
  assert.equal(cancelled.startRequestId, undefined)
  assert.equal(keyReads, 1, 'cancellation must not reread credentials')
  assert.deepEqual(await coordinator.cancel(task.id, 'cancel-queued'), cancelled)
  await assert.rejects(coordinator.start(task.id, 'start-cancelled'), { code: 'RUN_ALREADY_STARTED' })
  const reopened = new ManagedTaskStore(store.dataHome, project)
  assert.equal((await reopened.get(task.id)).status, 'cancelled')
  const next = (await reopened.create({ requestId: 'create-after-cancel', kind: 'understand',
    objective: 'Next synthetic task', paths: ['README.md'] })).task
  assert.equal(next.status, 'queued')
  await new ManagedTaskCoordinator(reopened).cancel(next.id, 'cancel-next')
  await new ManagedHistory(reopened).delete(task.id, 'delete-cancelled')
  await assert.rejects(reopened.get(task.id), { code: 'TASK_NOT_FOUND' })
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), '# Synthetic\n')
})

test('cancellation waits for snapshot preparation before history can be removed', async t => {
  const { store, task, project, coordinator } = await fixture(t, async () => assert.fail('must not run'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const get = store.get.bind(store)
  let gets = 0
  store.get = async id => {
    const current = await get(id)
    if (++gets === 4) { entered.resolve(); await release.promise }
    return current
  }
  const started = coordinator.start(task.id, 'start-preparing').then(() => null, error => error)
  await entered.promise
  let settled = false
  const cancelled = coordinator.cancel(task.id, 'cancel-preparing').finally(() => { settled = true })
  try {
    await new Promise(done => setTimeout(done, 60))
    assert.equal(settled, false, 'cancellation must wait for the snapshot writer')
    await assert.rejects(new ManagedHistory(store).delete(task.id, 'delete-preparing'), { code: 'HISTORY_ACTIVE' })
  } finally { release.resolve() }
  assert.equal((await started).code, 'ENGINE_CANCELLED')
  assert.equal((await cancelled).status, 'cancelled')
  assert.equal((await new ManagedTaskStore(store.dataHome, project).get(task.id)).engineStatus, 'not_started')
  const location = await store.location()
  await new ManagedHistory(store).delete(task.id, 'delete-after-settled')
  await assert.rejects(store.get(task.id), { code: 'TASK_NOT_FOUND' })
  assert.ok(!(await readdir(join(store.dataHome, 'managed-snapshots-v1', location.projectId)))
    .some(name => name.startsWith(task.id)), 'deleted source snapshots must not reappear')
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), '# Synthetic\n')
})

test('cancellation during claim settles its receipt without starting the engine', async t => {
  let calls = 0
  const { store, task } = await fixture(t, async () => { calls++ })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const claim = store.claimRun.bind(store)
  store.claimRun = async (...args) => { entered.resolve(); await release.promise; return claim(...args) }
  const coordinator = new ManagedTaskCoordinator(store, { modelKey: async () => 'synthetic', run: async () => { calls++ } })
  const started = coordinator.start(task.id, 'start-claim')
  await entered.promise
  const cancelled = coordinator.cancel(task.id, 'cancel-claim')
  // cancel has reached the tracked preparation before allowing the durable claim to finish.
  while (!coordinator.starting.get(task.id).controller.signal.aborted) await new Promise(done => setImmediate(done))
  release.resolve()
  assert.equal((await started).status, 'cancelled')
  assert.equal((await cancelled).status, 'cancelled')
  assert.equal(calls, 0)
  assert.equal((await store.get(task.id)).failureCode, 'ENGINE_CANCELLED')
})

test('overlapping starts share preparation and dispose waits without replaying an engine', async t => {
  const { store, task } = await fixture(t, async () => assert.fail('must not run'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  let keyReads = 0
  const coordinator = new ManagedTaskCoordinator(store, {
    modelKey: async () => { keyReads++; entered.resolve(); await release.promise; return 'synthetic' },
    run: async () => assert.fail('must not run'),
  })
  const first = coordinator.start(task.id, 'same-start')
  assert.equal(coordinator.start(task.id, 'same-start'), first)
  const rejected = assert.rejects(first, { code: 'ENGINE_CANCELLED' })
  await entered.promise
  await assert.rejects(coordinator.start(task.id, 'different-start'), { code: 'RUN_ALREADY_STARTED' })
  const disposed = coordinator.dispose()
  release.resolve()
  await rejected; await disposed
  assert.equal(keyReads, 1)
  assert.equal((await store.get(task.id)).snapshotId, null)
  await assert.rejects(coordinator.start(task.id, 'after-dispose'), { code: 'ENGINE_OWNER_LOST' })
})

test('a start arriving while cancellation reads task state cannot create a new snapshot', async t => {
  const { store, task, coordinator } = await fixture(t, async () => assert.fail('must not run'))
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const get = store.get.bind(store)
  let reads = 0
  store.get = async id => {
    const current = await get(id)
    if (++reads === 1) { entered.resolve(); await release.promise }
    return current
  }
  const cancelled = coordinator.cancel(task.id, 'cancel-first')
  await entered.promise
  try {
    await assert.rejects(coordinator.start(task.id, 'late-start'), { code: 'RUN_STATE_CONFLICT' })
  } finally { release.resolve(); await cancelled }
  assert.equal((await cancelled).status, 'cancelled')
  assert.equal((await store.get(task.id)).snapshotId, null)
  await new ManagedHistory(store).delete(task.id, 'delete-after-cancel')
  await assert.rejects(store.get(task.id), { code: 'TASK_NOT_FOUND' })
})

test('coordinator validates and passes the explicit model budget to its engine', async t => {
  const { store, task } = await fixture(t, async () => { throw Error('unused') })
  assert.throws(() => new ManagedTaskCoordinator(store, { engineLimits: { maxRequests: 5 } }),
    { code: 'ENGINE_CONFIG_INVALID' })
  assert.throws(() => new ManagedTaskCoordinator(store, { engineLimits: { maxOutputTokens: 513 } }),
    { code: 'ENGINE_CONFIG_INVALID' })
  assert.throws(() => new ManagedTaskCoordinator(store, { engineLimits: { model: 'unscoped' } }),
    { code: 'ENGINE_CONFIG_INVALID' })
  let limits
  const coordinator = new ManagedTaskCoordinator(store, {
    modelKey: async () => 'synthetic-key', engineLimits: { maxRequests: 4, maxOutputTokens: 512 },
    run: async args => { limits = [args.maxRequests, args.maxOutputTokens]; throw Error('synthetic stop') },
  })
  await coordinator.start(task.id, 'start-budget')
  await coordinator.whenIdle(task.id)
  assert.deepEqual(limits, [4, 512])
  assert.equal((await store.get(task.id)).status, 'failed')
})

test('new coordinator marks an abandoned run interrupted without replaying its model request', async t => {
  let calls = 0
  const { store, task, project } = await fixture(t, async () => { calls++ })
  const { captureManagedSnapshot } = await import('../src/host/managed-snapshot.js')
  await captureManagedSnapshot(store, task.id)
  await store.claimRun(task.id, 'start-before-restart')
  const reopened = new ManagedTaskStore(store.dataHome, project)
  const coordinator = new ManagedTaskCoordinator(reopened, {
    run: async () => { calls++ }, modelKey: async () => 'synthetic-key',
  })
  await coordinator.initialize()
  await coordinator.initialize()
  const recovered = await reopened.get(task.id)
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.failureCode, 'ENGINE_OWNER_LOST')
  assert.equal(calls, 0)
  await assert.rejects(coordinator.start(task.id, 'start-before-restart'), { code: 'RUN_ALREADY_STARTED' })
})
