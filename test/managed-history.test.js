import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { ManagedHistory } from '../src/host/managed-history.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'

test('history deletion requires a settled task and never deletes project source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r3-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'x.mjs'), 'export const x=1\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'history-1', kind: 'modify', objective: 'Change x', paths: ['x.mjs'] })).task
  const history = new ManagedHistory(store)
  await assert.rejects(history.delete(task.id, 'delete-1'), { code: 'HISTORY_ACTIVE' })
  await captureManagedSnapshot(store, task.id)
  const location = await store.location()
  const snapshotFolder = join(root, 'data', 'managed-snapshots-v1', location.projectId, task.id)
  assert.equal((await stat(snapshotFolder)).isDirectory(), true)
  await store.cancelQueuedModify(task.id)
  await history.delete(task.id, 'delete-1')
  await assert.rejects(store.get(task.id), { code: 'TASK_NOT_FOUND' })
  await assert.rejects(stat(snapshotFolder), { code: 'ENOENT' })
  assert.equal(await readFile(join(project, 'x.mjs'), 'utf8'), 'export const x=1\n')
})

test('failed history cleanup persists deleting state and retries without touching source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r3-history-retry-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'x.mjs'), 'export const x=1\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'history-retry', kind: 'modify', objective: 'Change x', paths: ['x.mjs'] })).task
  await captureManagedSnapshot(store, task.id)
  await store.cancelQueuedModify(task.id)
  await assert.rejects(new ManagedHistory(store, { removeFolder: async () => { throw Error('injected cleanup failure') } })
    .delete(task.id, 'delete-retry'))
  assert.equal((await store.get(task.id)).status, 'deleting')
  assert.equal(await readFile(join(project, 'x.mjs'), 'utf8'), 'export const x=1\n')
  await new ManagedHistory(store).delete(task.id, 'delete-retry')
  await assert.rejects(store.get(task.id), { code: 'TASK_NOT_FOUND' })
})

test('deleting settled history while another task is active is rejected before corrupting the serial store', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r5-history-serial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project); await writeFile(join(project, 'x.mjs'), 'export const x=1\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const old = (await store.create({ requestId: 'old-history', kind: 'modify', objective: 'Old synthetic task', paths: ['x.mjs'] })).task
  await store.cancelQueuedModify(old.id)
  const active = (await store.create({ requestId: 'active-history', kind: 'modify', objective: 'Active synthetic task', paths: ['x.mjs'] })).task
  const file = (await store.location()).file, before = await readFile(file)
  await assert.rejects(new ManagedHistory(store).delete(old.id, 'delete-during-active'), { code: 'HISTORY_ACTIVE' })
  assert.deepEqual(await readFile(file), before)
  assert.equal((await new ManagedTaskStore(store.dataHome, project).get(active.id)).status, 'queued')
  await store.cancelQueuedModify(active.id)
  await new ManagedHistory(store).delete(old.id, 'delete-after-settled')
  await assert.rejects(store.get(old.id), { code: 'TASK_NOT_FOUND' })
  assert.equal(await readFile(join(project, 'x.mjs'), 'utf8'), 'export const x=1\n')
})
