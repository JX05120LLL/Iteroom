import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { captureManagedSnapshot, readManagedSnapshotFile } from '../src/host/managed-snapshot.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(project, 'src', 'first.ts'), 'export const first = 1\n')
  await writeFile(join(project, 'src', 'second.ts'), 'export const second = 2\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'snapshot-1', kind: 'understand',
    objective: 'Explain both files', paths: ['src/first.ts', 'src/second.ts'] })).task
  return { root, project, store, task }
}

test('snapshot is durable, task-bound and independently readable after source changes', async t => {
  const { root, project, store, task } = await fixture(t)
  const first = await captureManagedSnapshot(store, task.id)
  assert.match(first.id, /^[0-9a-f]{64}$/)
  assert.deepEqual(first.files.map(file => file.path), task.paths)
  assert.equal((await store.get(task.id)).snapshotId, first.id)
  await writeFile(join(project, 'src', 'first.ts'), 'export const first = 999\n')
  const reopened = new ManagedTaskStore(join(root, 'data'), project)
  const old = await readManagedSnapshotFile(reopened, task.id, 'src/first.ts')
  assert.equal(old.text, 'export const first = 1\n')
  assert.equal(old.sha256, createHash('sha256').update(old.text).digest('hex'))
  assert.equal(old.snapshotId, first.id)
  assert.deepEqual(await captureManagedSnapshot(reopened, task.id), first)
  await assert.rejects(readManagedSnapshotFile(reopened, task.id, 'src/other.ts'), { code: 'SNAPSHOT_PATH_DENIED' })
  assert.equal(await readFile(join(project, 'src', 'first.ts'), 'utf8'), 'export const first = 999\n')
})

test('failed capture leaves task without snapshot and can be retried after fixing source', async t => {
  const { root, project, store, task } = await fixture(t)
  await rm(join(project, 'src', 'second.ts'))
  await assert.rejects(captureManagedSnapshot(store, task.id), { code: 'READ_UNAVAILABLE' })
  assert.equal((await store.get(task.id)).snapshotId, null)
  const folder = join(root, 'data', 'managed-snapshots-v1')
  assert.deepEqual(await readdir(folder).catch(() => []), [])
  await writeFile(join(project, 'src', 'second.ts'), 'export const second = 2\n')
  const snapshot = await captureManagedSnapshot(store, task.id)
  assert.equal(snapshot.files.length, 2)
})

test('snapshot corruption fails closed without falling back to changed workspace bytes', async t => {
  const { root, project, store, task } = await fixture(t)
  const snapshot = await captureManagedSnapshot(store, task.id)
  const projectId = (await store.location()).projectId
  const copy = join(root, 'data', 'managed-snapshots-v1', projectId, task.id, '0.txt')
  await writeFile(copy, 'tampered')
  await writeFile(join(project, 'src', 'first.ts'), 'changed in project')
  await assert.rejects(readManagedSnapshotFile(store, task.id, 'src/first.ts'), { code: 'SNAPSHOT_INVALID' })
  await assert.rejects(captureManagedSnapshot(store, task.id), { code: 'SNAPSHOT_INVALID' })
  assert.equal((await store.get(task.id)).snapshotId, snapshot.id)
})

test('R1-1 records without snapshotId remain readable and are upgraded on capture', async t => {
  const { store, task } = await fixture(t)
  const { file } = await store.location()
  const state = JSON.parse(await readFile(file, 'utf8'))
  delete state.tasks[0].snapshotId
  await writeFile(file, JSON.stringify(state))
  assert.equal((await store.get(task.id)).snapshotId, undefined)
  const snapshot = await captureManagedSnapshot(store, task.id)
  assert.equal((await store.get(task.id)).snapshotId, snapshot.id)
})
