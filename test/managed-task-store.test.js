import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-task-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'README.md'), '# Synthetic project\n')
  return { root, project, dataHome: join(root, 'data') }
}

const input = { requestId: 'request-1', kind: 'understand', objective: 'Explain the selected file', paths: ['README.md'] }

test('managed read task is durable, scoped to one project and idempotent across Store instances', async t => {
  const { root, project, dataHome } = await fixture(t)
  const before = await readFile(join(project, 'README.md'), 'utf8')
  const store = new ManagedTaskStore(dataHome, project)
  const first = await store.create(input)
  assert.equal(first.created, true)
  assert.equal(first.task.status, 'queued')
  assert.equal(first.task.engineStatus, 'not_started')
  assert.equal(first.task.sessionId, null)
  assert.deepEqual(first.task.executionIds, [])
  assert.deepEqual(first.task.paths, ['README.md'])
  const reopened = new ManagedTaskStore(dataHome, project)
  const retry = await reopened.create(input)
  assert.equal(retry.created, false)
  assert.equal(retry.task.id, first.task.id)
  assert.deepEqual(await reopened.get(first.task.id), first.task)
  assert.deepEqual(await reopened.list(), [first.task])
  const otherProject = join(root, 'other-project')
  await mkdir(otherProject)
  const otherStore = new ManagedTaskStore(dataHome, otherProject)
  assert.deepEqual(await otherStore.list(), [])
  await assert.rejects(otherStore.get(first.task.id), { code: 'TASK_NOT_FOUND' })
  assert.equal(await readFile(join(project, 'README.md'), 'utf8'), before)
  await assert.rejects(reopened.create({ ...input, requestId: 'request-2' }), { code: 'ACTIVE_TASK_EXISTS' })
  await assert.rejects(reopened.create({ ...input, objective: 'Changed intent' }), { code: 'REQUEST_ID_CONFLICT' })
})

test('invalid task input and unsafe paths are refused without creating a record', async t => {
  const { project, dataHome } = await fixture(t)
  const store = new ManagedTaskStore(dataHome, project)
  for (const path of ['../outside', '/absolute', 'C:/Windows/file', 'src\\file', '.git/config', '.env', 'src//file', 'src/./file', 'src/../file', 'id_rsa',
    'id_ed25519', 'src/secrets.json', '.aws/credentials', 'private.pem', 'README.md:secret', 'CON.txt', 'file.', 'file ', 'line\u0000break']) {
    await assert.rejects(store.create({ ...input, paths: [path] }), { code: 'INVALID_TASK_INPUT' }, path)
  }
  for (const invalid of [{ ...input, kind: 'modify' }, { ...input, objective: '' }, { ...input, paths: [] },
    { ...input, requestId: '../bad' }, { ...input, extra: 'not allowed' }, { ...input, paths: ['README.md', 'README.md'] },
    { ...input, paths: ['README.md', 'readme.md'] }]) {
    await assert.rejects(store.create(invalid), { code: 'INVALID_TASK_INPUT' })
  }
  assert.deepEqual(await store.list(), [])
})

test('concurrent creates never create two active tasks and damaged state fails closed', async t => {
  const { project, dataHome } = await fixture(t)
  const store = new ManagedTaskStore(dataHome, project)
  const attempts = await Promise.allSettled([
    store.create(input), store.create({ ...input, requestId: 'request-2' }),
  ])
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal((await store.list()).length, 1)
  const folder = join(dataHome, 'managed-tasks-v1')
  const [stateFile] = (await readdir(folder)).filter(name => name.endsWith('.json'))
  const original = await readFile(join(folder, stateFile), 'utf8')
  const changed = JSON.parse(original)
  changed.tasks[0].status = 'unknown-side-effect'
  await writeFile(join(folder, stateFile), JSON.stringify(changed))
  await assert.rejects(store.create({ ...input, requestId: 'request-3' }), { code: 'TASK_STORE_INVALID' })
  await writeFile(join(folder, stateFile), '{bad json')
  await assert.rejects(store.create({ ...input, requestId: 'request-3' }), { code: 'TASK_STORE_INVALID' })
  assert.equal(await readFile(join(folder, stateFile), 'utf8'), '{bad json')
})

test('unconfirmed lock and data home inside project are refused', async t => {
  const { project, dataHome } = await fixture(t)
  const inside = new ManagedTaskStore(join(project, 'data'), project)
  await assert.rejects(inside.create(input), { code: 'TASK_DATA_HOME_UNSAFE' })
  const store = new ManagedTaskStore(dataHome, project)
  await store.create(input)
  const folder = join(dataHome, 'managed-tasks-v1')
  const [stateFile] = (await readdir(folder)).filter(name => name.endsWith('.json'))
  await writeFile(join(folder, `${stateFile}.lock`), 'unknown owner')
  await assert.rejects(store.create(input), { code: 'TASK_STORE_BUSY' })
  assert.equal((await readdir(folder)).filter(name => name.endsWith('.json')).length, 1)
})

test('a redirected data-home parent cannot place task records inside the project', async t => {
  const { root, project } = await fixture(t)
  const alias = join(root, 'project-alias')
  try { await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('directory links unavailable on this host')
    throw error
  }
  const store = new ManagedTaskStore(join(alias, 'new-data'), project)
  await assert.rejects(store.create(input), { code: 'TASK_DATA_HOME_UNSAFE' })
  assert.deepEqual(await readdir(project), ['README.md'])
})

test('managed run is claimed once, completed with snapshot-backed references, then releases serial slot', async t => {
  const { project, dataHome } = await fixture(t)
  const store = new ManagedTaskStore(dataHome, project)
  const task = (await store.create(input)).task
  const snapshotId = 'a'.repeat(64), sha256 = 'b'.repeat(64)
  await store.recordRead(task.id, { path: 'README.md', sha256, byteLength: 20, lineCount: 1 })
  await store.attachSnapshot(task.id, snapshotId)
  const claimed = await store.claimRun(task.id, 'start-1')
  assert.equal(claimed.created, true)
  assert.equal(claimed.task.status, 'running')
  assert.equal(claimed.task.sessionId, task.id)
  assert.equal((await store.claimRun(task.id, 'start-1')).created, false)
  await assert.rejects(store.claimRun(task.id, 'start-2'), { code: 'RUN_ALREADY_STARTED' })
  await store.appendDraft(task.id, 'Reading selected file…')
  assert.equal((await store.get(task.id)).draft, 'Reading selected file…')
  const completed = await store.finishRun(task.id, { sessionId: task.id, turnEnd: 'completed',
    answer: 'A heading appears in README.md:1-1.',
    references: [{ path: 'README.md', snapshotId, sha256, startLine: 1, endLine: 1 }] })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.references[0].path, 'README.md')
  const reopened = new ManagedTaskStore(dataHome, project)
  assert.equal((await reopened.get(task.id)).answer, completed.answer)
  assert.deepEqual((await reopened.eventsAfter(task.id, 0)).events.map(event => [event.seq, event.type]),
    [[1, 'created'], [2, 'snapshot'], [3, 'started'], [4, 'draft'], [5, 'completed']])
  assert.deepEqual((await reopened.eventsAfter(task.id, 3)).events.map(event => event.text ?? event.type),
    ['Reading selected file…', 'completed'])
  assert.deepEqual((await reopened.eventsAfter(task.id, 5)).events, [])
  await assert.rejects(reopened.eventsAfter(task.id, -1), { code: 'INVALID_EVENT_CURSOR' })
  assert.equal((await reopened.create({ ...input, requestId: 'request-2' })).created, true)
})

test('interrupted run is never reclaimed and malformed result cannot be marked completed', async t => {
  const { project, dataHome } = await fixture(t)
  const store = new ManagedTaskStore(dataHome, project)
  const task = (await store.create(input)).task
  await store.attachSnapshot(task.id, 'a'.repeat(64))
  await store.claimRun(task.id, 'start-1')
  await assert.rejects(store.finishRun(task.id, { sessionId: task.id, turnEnd: 'completed',
    answer: 'Invented citation', references: [{ path: 'README.md', snapshotId: 'a'.repeat(64),
      sha256: 'b'.repeat(64), startLine: 1, endLine: 1 }] }), { code: 'RUN_RESULT_INVALID' })
  const interrupted = await store.failRun(task.id, 'ENGINE_PROCESS_CLOSED', 'interrupted')
  assert.equal(interrupted.status, 'interrupted')
  assert.equal(interrupted.engineStatus, 'interrupted')
  assert.equal(interrupted.failureCode, 'ENGINE_PROCESS_CLOSED')
  await assert.rejects(store.claimRun(task.id, 'start-1'), { code: 'RUN_ALREADY_STARTED' })
  assert.equal((await store.create({ ...input, requestId: 'request-2' })).created, true)
})
