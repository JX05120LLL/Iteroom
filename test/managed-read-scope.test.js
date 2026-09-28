import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { readManagedFile } from '../src/host/managed-read-scope.js'

async function fixture(t, paths = ['src/main.ts']) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-read-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  const file = join(project, 'src', 'main.ts')
  await writeFile(file, 'export const answer = 42\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'read-1', kind: 'understand', objective: 'Explain selected code', paths })).task
  return { root, project, file, store, task }
}

test('selected text is observed once, hash survives restart, and changed bytes fail closed', async t => {
  const { root, project, file, store, task } = await fixture(t)
  const before = await readFile(file)
  const first = await readManagedFile(store, { taskId: task.id, path: 'src/main.ts' })
  assert.equal(first.taskId, task.id)
  assert.equal(first.text, before.toString('utf8'))
  assert.equal(first.sha256, createHash('sha256').update(before).digest('hex'))
  assert.equal(first.lineCount, 1)
  assert.equal(first.byteLength, before.length)
  const reopened = new ManagedTaskStore(join(root, 'data'), project)
  assert.deepEqual((await reopened.get(task.id)).readObservations, [{
    path: first.path, sha256: first.sha256, byteLength: first.byteLength,
    lineCount: first.lineCount, observedAt: first.observedAt,
  }])
  const repeated = await readManagedFile(reopened, { taskId: task.id, path: 'src/main.ts' })
  assert.equal(repeated.observedAt, first.observedAt)
  assert.equal((await reopened.get(task.id)).readObservations.length, 1)
  await writeFile(file, 'export const answer = 43\n')
  await assert.rejects(readManagedFile(reopened, { taskId: task.id, path: 'src/main.ts' }), { code: 'READ_INPUT_CHANGED' })
  assert.equal((await reopened.get(task.id)).readObservations[0].sha256, first.sha256)
})

test('an R1-1 record without readObservations is read and upgraded without changing task identity', async t => {
  const { store, task } = await fixture(t)
  const { file } = await store.location()
  const state = JSON.parse(await readFile(file, 'utf8'))
  delete state.tasks[0].readObservations
  await writeFile(file, JSON.stringify(state))
  assert.equal((await store.get(task.id)).id, task.id)
  const observed = await readManagedFile(store, { taskId: task.id, path: 'src/main.ts' })
  assert.equal((await store.get(task.id)).readObservations[0].sha256, observed.sha256)
  state.tasks[0].readObservations = [{ path: 'src/main.ts', sha256: 'invalid', byteLength: 1,
    lineCount: 1, observedAt: new Date().toISOString() }]
  await writeFile(file, JSON.stringify(state))
  await assert.rejects(store.get(task.id), { code: 'TASK_STORE_INVALID' })
})

test('only an exact selected path can be read, with no observation on rejection', async t => {
  const { project, store, task } = await fixture(t)
  await writeFile(join(project, 'src', 'secret.txt'), 'private')
  for (const path of ['src/secret.txt', 'src/../src/main.ts', '/src/main.ts', 'src\\main.ts', '.git/config']) {
    await assert.rejects(readManagedFile(store, { taskId: task.id, path }), { code: 'READ_PATH_DENIED' })
  }
  await assert.rejects(readManagedFile(store, { taskId: 'missing', path: 'src/main.ts' }), { code: 'INVALID_TASK_ID' })
  assert.deepEqual((await store.get(task.id)).readObservations, [])
})

test('directory, link, oversized, binary and malformed UTF-8 inputs are rejected', async t => {
  const { root, project, store, task } = await fixture(t, ['src/dir', 'src/alias.ts', 'src/big.ts', 'src/binary.ts', 'src/bad.ts'])
  await mkdir(join(project, 'src', 'dir'))
  await writeFile(join(project, 'src', 'big.ts'), Buffer.alloc(256 * 1024 + 1, 0x61))
  await writeFile(join(project, 'src', 'binary.ts'), Buffer.from([65, 0, 66]))
  await writeFile(join(project, 'src', 'bad.ts'), Buffer.from([0xff]))
  const outside = join(root, 'outside.ts')
  await writeFile(outside, 'secret outside')
  try { await symlink(outside, join(project, 'src', 'alias.ts'), 'file') }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
  }
  for (const [path, code] of [['src/dir', 'READ_NOT_REGULAR'], ['src/big.ts', 'READ_TOO_LARGE'],
    ['src/binary.ts', 'READ_NOT_TEXT'], ['src/bad.ts', 'READ_NOT_TEXT']]) {
    await assert.rejects(readManagedFile(store, { taskId: task.id, path }), { code }, path)
  }
  if (await lstat(join(project, 'src', 'alias.ts')).then(() => true, () => false)) {
    await assert.rejects(readManagedFile(store, { taskId: task.id, path: 'src/alias.ts' }), { code: 'READ_LINK_DENIED' })
  }
  assert.deepEqual((await store.get(task.id)).readObservations, [])
})

test('a symlinked parent directory is refused even when its target is inside the project', async t => {
  const { project, store, task } = await fixture(t, ['alias/main.ts'])
  try { await symlink(join(project, 'src'), join(project, 'alias'), process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('directory links unavailable')
    throw error
  }
  await assert.rejects(readManagedFile(store, { taskId: task.id, path: 'alias/main.ts' }), { code: 'READ_LINK_DENIED' })
  assert.deepEqual((await store.get(task.id)).readObservations, [])
})

test('a selected hard link to a file outside the project is refused', async t => {
  const { root, project, store, task } = await fixture(t, ['src/hard.ts'])
  const outside = join(root, 'outside.ts')
  await writeFile(outside, 'external private content')
  try { await link(outside, join(project, 'src', 'hard.ts')) }
  catch (error) {
    if (['EPERM', 'EACCES', 'EXDEV', 'ENOTSUP'].includes(error.code)) return t.skip('hard links unavailable')
    throw error
  }
  await assert.rejects(readManagedFile(store, { taskId: task.id, path: 'src/hard.ts' }), { code: 'READ_LINK_DENIED' })
  assert.deepEqual((await store.get(task.id)).readObservations, [])
})
