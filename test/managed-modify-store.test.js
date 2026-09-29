import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'

const input = { requestId: 'modify-1', kind: 'modify', objective: 'Fix the greeting', paths: ['src/greet.mjs', 'src/greet.test.mjs'] }

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r2-store-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), 'synthetic\n')
  return new ManagedTaskStore(join(root, 'data'), project)
}

test('modify task preserves R1 records, claims once and keeps sandbox evidence separate', async t => {
  const store = await fixture(t)
  const task = (await store.create(input)).task
  assert.equal(task.kind, 'modify')
  await store.attachSnapshot(task.id, 'a'.repeat(64))
  assert.equal((await store.claimModify(task.id, 'start-1')).created, true)
  assert.equal((await store.claimModify(task.id, 'start-1')).created, false)
  await assert.rejects(store.claimModify(task.id, 'start-2'), { code: 'RUN_ALREADY_STARTED' })
  await store.recordSandbox(task.id, 'sandbox-12345678')
  await store.recordExecutionStart(task.id, { id: 'exec-12345678', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'exec-12345678', { status: 'failed', exitCode: 1, outputSha256: 'b'.repeat(64), outputBytes: 12 })
  await store.recordExecutionStart(task.id, { id: 'exec-12345679', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'exec-12345679', { status: 'completed', exitCode: 0, outputSha256: 'c'.repeat(64), outputBytes: 20 })
  await store.markSandboxCleaned(task.id)
  await store.finishModify(task.id, { artifactId: 'd'.repeat(64), changeCount: 1, verificationId: 'exec-12345679' })
  const reopened = await store.get(task.id)
  assert.equal(reopened.status, 'awaiting_review')
  assert.equal(reopened.artifactId, 'd'.repeat(64))
  assert.equal(reopened.verificationId, 'exec-12345679')
  assert.equal(reopened.sandboxStatus, 'cleaned')
  assert.deepEqual(reopened.executions.map(item => item.exitCode), [1, 0])
  assert.equal((await store.create({ requestId: 'understand-2', kind: 'understand', objective: 'Explain', paths: ['README.md'] })).created, true)
})

test('modify success is refused when verification or cleanup is unconfirmed', async t => {
  const store = await fixture(t)
  const task = (await store.create(input)).task
  await store.attachSnapshot(task.id, 'a'.repeat(64))
  await store.claimModify(task.id, 'start-1')
  await store.recordSandbox(task.id, 'sandbox-12345678')
  await assert.rejects(store.finishModify(task.id, { artifactId: 'd'.repeat(64), changeCount: 1, verificationId: 'missing-id' }), { code: 'MODIFY_RESULT_INVALID' })
  await store.recordExecutionStart(task.id, { id: 'exec-12345678', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'exec-12345678', { status: 'unknown', exitCode: null, outputSha256: 'b'.repeat(64), outputBytes: 0 })
  await store.markSandboxCleaned(task.id)
  await assert.rejects(store.finishModify(task.id, { artifactId: 'd'.repeat(64), changeCount: 1, verificationId: 'exec-12345678' }), { code: 'MODIFY_RESULT_INVALID' })
})

test('cleanup pending blocks another task until explicit resource reconciliation', async t => {
  const store = await fixture(t)
  const task = (await store.create(input)).task
  await store.attachSnapshot(task.id, 'a'.repeat(64))
  await store.claimModify(task.id, 'start-1')
  await store.markCancelling(task.id)
  await store.recordSandbox(task.id, 'sandbox-12345678')
  await store.markSandboxCleanupPending(task.id)
  await store.failRun(task.id, 'SANDBOX_OWNER_LOST', 'interrupted')
  await assert.rejects(store.create({ requestId: 'understand-2', kind: 'understand', objective: 'Explain', paths: ['README.md'] }), { code: 'ACTIVE_TASK_EXISTS' })
  await store.markSandboxCleaned(task.id)
  assert.equal((await store.create({ requestId: 'understand-2', kind: 'understand', objective: 'Explain', paths: ['README.md'] })).created, true)
})

test('confirmed sandbox deletion closes in-flight execution without inventing an exit code', async t => {
  const store = await fixture(t)
  const task = (await store.create(input)).task
  await store.attachSnapshot(task.id, 'a'.repeat(64))
  await store.claimModify(task.id, 'start-1')
  await store.recordSandbox(task.id, 'sandbox-12345678')
  await store.recordExecutionStart(task.id, { id: 'exec-12345678', kind: 'test',
    command: 'node --test', cwd: '/workspace' })
  await store.markCancelling(task.id)
  await store.markSandboxCleaned(task.id)
  const entry = (await store.get(task.id)).executions[0]
  assert.equal(entry.status, 'interrupted')
  assert.equal(entry.exitCode, null)
  assert.equal(entry.outputBytes, 0)
})

test('queued modify task can be abandoned before any snapshot or sandbox allocation', async t => {
  const store = await fixture(t)
  const task = (await store.create(input)).task
  const cancelled = await store.cancelQueuedModify(task.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.engineStatus, 'not_started')
  assert.equal(cancelled.snapshotId, null)
  assert.equal(cancelled.sandboxId, undefined)
  assert.equal((await store.get(task.id)).status, 'cancelled')
  assert.equal((await store.create({ ...input, requestId: 'modify-2' })).created, true)
})
