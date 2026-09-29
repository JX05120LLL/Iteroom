import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { ManagedModifyCoordinator } from '../src/host/managed-modify-coordinator.js'
import { readManagedArtifact } from '../src/host/managed-artifact.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r2-coordinator-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'greet.mjs'), 'export const greet = () => "Hi"\n')
  await writeFile(join(project, 'greet.test.mjs'), 'import { greet } from "./greet.mjs"\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'modify-1', kind: 'modify', objective: 'Fix greeting',
    paths: ['greet.mjs', 'greet.test.mjs'] })).task
  return { store, taskId: task.id, project }
}

test('modify coordinator exports a verified candidate, cleans sandbox, never edits host', async t => {
  const { store, taskId, project } = await fixture(t)
  let opens = 0, runs = 0, diagnostic
  const session = { store, taskId, files: null, sandbox: { id: 'sandbox-12345678', files: {
    readFile: async path => path.endsWith('greet.mjs')
      ? 'export const greet = () => "Hello"\n' : 'import { greet } from "./greet.mjs"\n',
    listDirectory: async () => ['greet.mjs', 'greet.test.mjs'].map(path => ({ path: `/workspace/${path}`, type: 'file' })),
  } },
    cleanup: async () => store.markSandboxCleaned(taskId) }
  const coordinator = new ManagedModifyCoordinator(store, {
    onError: error => { diagnostic = error.code ?? error.message },
    sandboxConfig: async () => ({ image: `node@sha256:${'a'.repeat(64)}`, key: 'synthetic-key',
      connectionConfig: { domain: '127.0.0.1:3088' } }),
    modelKey: async () => 'synthetic-model-key',
    open: async ({ store, taskId }) => {
      opens++
      await store.recordSandbox(taskId, 'sandbox-12345678')
      const { readManagedSnapshotFile } = await import('../src/host/managed-snapshot.js')
      const task = await store.get(taskId)
      session.files = await Promise.all(task.paths.map(path => readManagedSnapshotFile(store, taskId, path)))
      return session
    },
    run: async ({ store, taskId }) => {
      runs++
      await store.recordExecutionStart(taskId, { id: 'exec-12345678', kind: 'test', command: 'node --test', cwd: '/workspace' })
      await store.finishExecution(taskId, 'exec-12345678', { status: 'completed', exitCode: 0,
        outputSha256: 'b'.repeat(64), outputBytes: 0 })
      return { sessionId: taskId, turnEnd: 'completed', answer: 'Synthetic test passed' }
    },
  })
  await coordinator.start(taskId, 'start-1')
  const done = await coordinator.whenIdle(taskId)
  assert.equal(done.status, 'awaiting_review', diagnostic)
  assert.equal(done.sandboxStatus, 'cleaned')
  assert.equal(done.changeCount, 1)
  assert.equal((await readManagedArtifact(store, taskId, done.artifactId)).changes[0].kind, 'modified')
  assert.equal(await readFile(join(project, 'greet.mjs'), 'utf8'), 'export const greet = () => "Hi"\n')
  assert.equal(opens, 1); assert.equal(runs, 1)
  await assert.rejects(coordinator.start(taskId, 'start-2'), { code: 'RUN_ALREADY_STARTED' })
})

test('orphaned sandbox task is interrupted without replay', async t => {
  const { store, taskId } = await fixture(t)
  const { captureManagedSnapshot } = await import('../src/host/managed-snapshot.js')
  await captureManagedSnapshot(store, taskId)
  await store.claimModify(taskId, 'start-1')
  await store.recordSandbox(taskId, 'sandbox-12345678')
  let replayed = false, killed = false
  const coordinator = new ManagedModifyCoordinator(store, {
    sandboxConfig: async () => ({ image: `node@sha256:${'a'.repeat(64)}`, key: 'synthetic-key',
      connectionConfig: { domain: '127.0.0.1:3088' } }),
    modelKey: async () => 'synthetic-model-key',
    run: async () => { replayed = true },
    reconcile: async () => { killed = true; await store.markSandboxCleaned(taskId) },
  })
  await coordinator.initialize()
  const task = await store.get(taskId)
  assert.equal(task.status, 'interrupted')
  assert.equal(task.sandboxStatus, 'cleaned')
  assert.equal(killed, true); assert.equal(replayed, false)
})

test('unknown allocation blocks a new task until a later reconciliation confirms no resource', async t => {
  const { store, taskId } = await fixture(t)
  const config = async () => ({ image: `node@sha256:${'a'.repeat(64)}`, key: 'synthetic-key',
    connectionConfig: { domain: '127.0.0.1:3088' } })
  const first = new ManagedModifyCoordinator(store, { sandboxConfig: config,
    modelKey: async () => 'synthetic-model-key',
    open: async () => { throw Error('control plane disconnected after allocation request') },
    reconcile: async () => { throw Error('control plane unavailable') } })
  await first.start(taskId, 'start-1')
  const unknown = await first.whenIdle(taskId)
  assert.equal(unknown.status, 'interrupted')
  assert.equal(unknown.sandboxStatus, 'cleanup_pending')
  assert.equal(unknown.sandboxAllocationPending, true)
  await assert.rejects(store.create({ requestId: 'next', kind: 'understand', objective: 'Explain', paths: ['greet.mjs'] }), { code: 'ACTIVE_TASK_EXISTS' })
  let replayed = false
  const second = new ManagedModifyCoordinator(store, { sandboxConfig: config,
    run: async () => { replayed = true },
    reconcile: async () => store.markSandboxCleaned(taskId) })
  await second.initialize()
  const recovered = await store.get(taskId)
  assert.equal(recovered.sandboxStatus, 'cleaned')
  assert.equal(replayed, false)
  assert.equal((await store.create({ requestId: 'next', kind: 'understand', objective: 'Explain', paths: ['greet.mjs'] })).created, true)
})

test('queued modify cancellation does not load credentials or allocate a sandbox', async t => {
  const { store, taskId } = await fixture(t)
  let externalCalls = 0
  const coordinator = new ManagedModifyCoordinator(store, {
    sandboxConfig: async () => { externalCalls++; throw Error('unexpected sandbox configuration read') },
    modelKey: async () => { externalCalls++; throw Error('unexpected model key read') },
    open: async () => { externalCalls++; throw Error('unexpected sandbox allocation') },
  })
  const cancelled = await coordinator.cancel(taskId, 'cancel-queued')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(externalCalls, 0)
})
