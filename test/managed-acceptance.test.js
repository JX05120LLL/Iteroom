import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'
import { saveManagedArtifact } from '../src/host/managed-artifact.js'
import { ManagedAcceptance } from '../src/host/managed-acceptance.js'
import { ManagedHistory } from '../src/host/managed-history.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const git = promisify(execFile)
async function fixture(t, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r3-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const paths = []
  for (let i = 0; i < count; i++) {
    const path = `file${i}.mjs`
    paths.push(path)
    await writeFile(join(project, path), `export const x${i}=1\n`)
  }
  paths.push('file.test.mjs')
  await writeFile(join(project, 'file.test.mjs'), 'import "./file0.mjs"\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'r3-1', kind: 'modify', objective: 'Change synthetic files', paths })).task
  const snapshot = await captureManagedSnapshot(store, task.id)
  await store.claimModify(task.id, 'start-1')
  await store.recordSandbox(task.id, 'sandbox-12345678')
  await store.recordExecutionStart(task.id, { id: 'exec-12345678', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'exec-12345678', { status: 'completed', exitCode: 0, outputSha256: hash('ok'), outputBytes: 2 })
  await store.markSandboxCleaned(task.id)
  const changes = paths.filter(path => path !== 'file.test.mjs').map((path, i) => ({
    path, kind: 'modified', beforeSha256: hash(`export const x${i}=1\n`), afterSha256: hash(`export const x${i}=2\n`),
    beforeBytes: Buffer.byteLength(`export const x${i}=1\n`), afterBytes: Buffer.byteLength(`export const x${i}=2\n`),
  }))
  const patch = changes.map(({ path }, i) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-export const x${i}=1\n+export const x${i}=2\n`).join('')
  const artifact = await saveManagedArtifact(store, task.id, { version: 1, taskId: task.id, snapshotId: snapshot.id,
    changes, patch, sha256: hash(patch) })
  await store.finishModify(task.id, { artifactId: artifact.id, changeCount: changes.length, verificationId: 'exec-12345678' })
  return { root, project, store, taskId: task.id, artifactId: artifact.id, paths, patch }
}

test('accept preserves snapshot baseline and checks external edit conflicts', async t => {
  const f = await fixture(t)
  const accept = new ManagedAcceptance(f.store)
  const preview = await accept.preview(f.taskId)
  assert.deepEqual(preview.files.map(file => file.status), ['ready'])
  await writeFile(join(f.project, 'file0.mjs'), 'external edit\n')
  await assert.rejects(accept.accept(f.taskId, 'accept-1'), { code: 'ACCEPT_CONFLICT' })
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'external edit\n')
  await writeFile(join(f.project, 'file0.mjs'), 'export const x0=1\n')
  const done = await accept.accept(f.taskId, 'accept-1')
  assert.equal(done.status, 'completed')
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=2\n')
  assert.equal((await accept.accept(f.taskId, 'accept-1')).status, 'completed')
})

test('accept changes a dirty Git worktree file without staging or committing', async t => {
  const f = await fixture(t)
  await git('git', ['init', '-q'], { cwd: f.project })
  await writeFile(join(f.project, 'file0.mjs'), 'export const x0=0\n')
  await git('git', ['add', 'file0.mjs'], { cwd: f.project })
  await git('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'synthetic baseline'], { cwd: f.project })
  await writeFile(join(f.project, 'file0.mjs'), 'export const x0=1\n')
  const head = (await git('git', ['rev-parse', 'HEAD'], { cwd: f.project })).stdout.trim()
  await new ManagedAcceptance(f.store).accept(f.taskId, 'accept-dirty')
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=2\n')
  assert.equal((await git('git', ['show', ':file0.mjs'], { cwd: f.project })).stdout, 'export const x0=0\n')
  assert.equal((await git('git', ['rev-parse', 'HEAD'], { cwd: f.project })).stdout.trim(), head)
})

test('discard leaves source untouched and cannot later accept', async t => {
  const f = await fixture(t)
  const accept = new ManagedAcceptance(f.store)
  assert.equal((await accept.discard(f.taskId, 'discard-1')).status, 'discarded')
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=1\n')
  await assert.rejects(accept.accept(f.taskId, 'accept-1'), { code: 'ACCEPT_STATE_CONFLICT' })
})

test('overlapping accept requests cannot orphan the active writer', { timeout: 10000 }, async t => {
  const f = await fixture(t, 2)
  const entered = Promise.withResolvers(), releaseClaim = Promise.withResolvers()
  const secondClaim = Promise.withResolvers(), written = Promise.withResolvers()
  const releaseWrite = Promise.withResolvers()
  const begin = f.store.beginAcceptance.bind(f.store)
  let claims = 0
  f.store.beginAcceptance = async (...args) => {
    if (claims++ === 0) { entered.resolve(); await releaseClaim.promise }
    else { secondClaim.resolve(); await written.promise }
    return begin(...args)
  }
  const acceptance = new ManagedAcceptance(f.store, { afterWrite: async index => {
    if (index === 0) { written.resolve(); await releaseWrite.promise }
  } })
  const first = acceptance.accept(f.taskId, 'overlap-first')
  try {
    await entered.promise
    const second = acceptance.accept(f.taskId, 'overlap-second').then(
      task => ({ task }), error => ({ error }))
    await Promise.race([secondClaim.promise, second])
    releaseClaim.resolve()
    await written.promise
    assert.equal((await second).error?.code, 'ACCEPT_STATE_CONFLICT')
    await acceptance.initialize()
    assert.equal((await f.store.get(f.taskId)).status, 'applying',
      'a rejected decision must not make a live write look orphaned')
    await assert.rejects(acceptance.discard(f.taskId, 'overlap-discard'), { code: 'ACCEPT_STATE_CONFLICT' })
    await assert.rejects(acceptance.recover(f.taskId, 'overlap-recover', 'rollback'), { code: 'ACCEPT_STATE_CONFLICT' })
  } finally {
    releaseClaim.resolve(); releaseWrite.resolve()
    await first
  }
  assert.equal((await f.store.get(f.taskId)).status, 'completed')
  assert.equal(await readFile(join(f.project, 'file1.mjs'), 'utf8'), 'export const x1=2\n')
})

test('overlapping recovery decisions keep the first requested mode', { timeout: 10000 }, async t => {
  const f = await fixture(t, 2)
  await assert.rejects(new ManagedAcceptance(f.store, { afterWrite: async index => {
    if (index === 0) throw Error('synthetic stop')
  } }).accept(f.taskId, 'recover-overlap-start'))
  const acceptance = new ManagedAcceptance(f.store)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const files = acceptance.files.bind(acceptance)
  let calls = 0
  acceptance.files = async taskId => {
    if (calls++ === 0) { entered.resolve(); await release.promise }
    return files(taskId)
  }
  const first = acceptance.recover(f.taskId, 'recover-overlap-finish', 'finish')
  try {
    await entered.promise
    await assert.rejects(acceptance.recover(f.taskId, 'recover-overlap-rollback', 'rollback'),
      { code: 'ACCEPT_STATE_CONFLICT' })
    await assert.rejects(acceptance.discard(f.taskId, 'recover-overlap-discard'),
      { code: 'ACCEPT_STATE_CONFLICT' })
    assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=2\n')
  } finally { release.resolve(); await first }
  assert.equal((await f.store.get(f.taskId)).status, 'completed')
  assert.equal(await readFile(join(f.project, 'file1.mjs'), 'utf8'), 'export const x1=2\n')
  assert.equal((await acceptance.recover(f.taskId, 'recover-overlap-finish', 'finish')).status, 'completed')
})

test('partial write remains visible and recovery refuses external edits', async t => {
  const f = await fixture(t, 2)
  const accept = new ManagedAcceptance(f.store, { afterWrite: async index => {
    if (index === 0) throw Error('synthetic crash')
  } })
  await assert.rejects(accept.accept(f.taskId, 'accept-1'))
  assert.equal((await f.store.get(f.taskId)).status, 'interrupted')
  await assert.rejects(f.store.create({ requestId: 'blocked-next', kind: 'understand', objective: 'Explain', paths: ['file0.mjs'] }), { code: 'ACTIVE_TASK_EXISTS' })
  await assert.rejects(new ManagedHistory(f.store).delete(f.taskId, 'delete-1'), { code: 'HISTORY_ACTIVE' })
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=2\n')
  assert.equal(await readFile(join(f.project, 'file1.mjs'), 'utf8'), 'export const x1=1\n')
  await writeFile(join(f.project, 'file0.mjs'), 'external edit\n')
  await assert.rejects(new ManagedAcceptance(f.store).recover(f.taskId, 'recover-1', 'rollback'), { code: 'ACCEPT_CONFLICT' })
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'external edit\n')
})

test('an external edit after the first write prevents a false completed state', async t => {
  const f = await fixture(t, 2)
  const accept = new ManagedAcceptance(f.store, { afterWrite: async index => {
    if (index === 0) await writeFile(join(f.project, 'file0.mjs'), 'external edit after write\n')
  } })
  await assert.rejects(accept.accept(f.taskId, 'accept-external'), { code: 'ACCEPT_CONFLICT' })
  assert.equal((await f.store.get(f.taskId)).status, 'interrupted')
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'external edit after write\n')
})

test('restart detects an applying checkpoint and explicitly finishes or rolls back', async t => {
  const f = await fixture(t, 2)
  const crashing = new ManagedAcceptance(f.store, { afterWrite: async index => {
    if (index === 0) throw Error('synthetic stop')
  } })
  await assert.rejects(crashing.accept(f.taskId, 'accept-1'))
  const restarted = new ManagedAcceptance(new ManagedTaskStore(join(f.root, 'data'), f.project))
  const done = await restarted.recover(f.taskId, 'recover-1', 'finish')
  assert.equal(done.status, 'completed')
  assert.equal(await readFile(join(f.project, 'file1.mjs'), 'utf8'), 'export const x1=2\n')
  assert.equal(done.acceptance.entries.length, 2)

  const second = await fixture(t, 2)
  await assert.rejects(new ManagedAcceptance(second.store, { afterWrite: async index => {
    if (index === 0) throw Error('synthetic stop')
  } }).accept(second.taskId, 'accept-2'))
  const rolled = await new ManagedAcceptance(second.store).recover(second.taskId, 'recover-2', 'rollback')
  assert.equal(rolled.status, 'discarded')
  assert.equal(await readFile(join(second.project, 'file0.mjs'), 'utf8'), 'export const x0=1\n')
  assert.equal(await readFile(join(second.project, 'file1.mjs'), 'utf8'), 'export const x1=1\n')
})

test('orphaned applying state is interrupted on restart without replaying a write', async t => {
  const f = await fixture(t)
  await f.store.beginAcceptance(f.taskId, 'accept-orphan', [{ path: 'file0.mjs',
    beforeSha256: hash('export const x0=1\n'), afterSha256: hash('export const x0=2\n') }])
  const reopened = new ManagedAcceptance(new ManagedTaskStore(join(f.root, 'data'), f.project))
  await reopened.initialize()
  assert.equal((await f.store.get(f.taskId)).status, 'interrupted')
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=1\n')
  assert.equal((await reopened.recover(f.taskId, 'recover-orphan', 'finish')).status, 'completed')
})

test('deleted or linked target is rejected before any write', async t => {
  const f = await fixture(t, 2)
  await rm(join(f.project, 'file1.mjs'))
  await assert.rejects(new ManagedAcceptance(f.store).accept(f.taskId, 'accept-1'), { code: 'ACCEPT_CONFLICT' })
  assert.equal(await readFile(join(f.project, 'file0.mjs'), 'utf8'), 'export const x0=1\n')

  const linked = await fixture(t)
  const outside = join(linked.root, 'outside.mjs')
  await writeFile(outside, 'export const x0=1\n')
  await rm(join(linked.project, 'file0.mjs'))
  await link(outside, join(linked.project, 'file0.mjs'))
  await assert.rejects(new ManagedAcceptance(linked.store).accept(linked.taskId, 'accept-linked'), { code: 'ACCEPT_CONFLICT' })
  assert.equal(await readFile(outside, 'utf8'), 'export const x0=1\n')
})
