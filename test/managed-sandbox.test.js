import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'
import { openManagedSandbox, runManagedTest, exportManagedPatch } from '../src/host/managed-sandbox.js'

const hash = 'a'.repeat(64)
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r2-sandbox-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await mkdir(join(project, 'src'))
  await writeFile(join(project, 'src/greet.mjs'), 'export const greet = () => "Hi"\n')
  await writeFile(join(project, 'src/greet.test.mjs'), 'import { greet } from "./greet.mjs"\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'r2-test', kind: 'modify', objective: 'Fix greeting',
    paths: ['src/greet.mjs', 'src/greet.test.mjs'] })).task
  await captureManagedSnapshot(store, task.id)
  await store.claimModify(task.id, 'start-1')
  return { store, taskId: task.id }
}

test('sandbox imports only fixed bytes and records an actual test and cleanup', async t => {
  const { store, taskId } = await fixture(t)
  const files = new Map(), calls = []
  const sandbox = { id: 'sandbox-12345678', files: {
    createDirectories: async entries => calls.push(['directories', entries]),
    writeFiles: async entries => { calls.push(['write', entries]); for (const entry of entries) files.set(entry.path, entry.data) },
    readFile: async path => files.get(path),
    listDirectory: async () => [...files.keys()].map(path => ({ path, type: 'file' })),
  }, commands: {
    run: async (command, options, handlers) => {
      calls.push(['run', command, options])
      await handlers.onInit({ id: 'exec-12345678' })
      handlers.onStdout({ text: '2 tests pass\n' })
      return { id: 'exec-12345678', exitCode: 0 }
    },
  }, close: async () => calls.push(['close']) }
  let deleted = false
  const sdk = { Sandbox: { create: async options => { calls.push(['create', options]); return sandbox } },
    SandboxManager: { create: () => ({ getSandboxInfo: async () => {
      if (deleted) throw Object.assign(Error('gone'), { statusCode: 404 })
      return { metadata: { 'iteroom-task-id': taskId } }
    }, killSandbox: async id => { calls.push(['kill', id]); deleted = true },
    close: async () => calls.push(['manager-close']) }) } }
  const session = await openManagedSandbox({ store, taskId, sdk, connectionConfig: { domain: '127.0.0.1:3088' }, image: `node@sha256:${hash}` })
  assert.equal(files.get('/workspace/src/greet.mjs'), 'export const greet = () => "Hi"\n')
  assert.equal(calls[0][1].networkPolicy.defaultAction, 'deny')
  assert.deepEqual(calls[0][1].volumes, [])
  files.set('/workspace/src/greet.mjs', 'export const greet = () => "Hello"\n')
  const testResult = await runManagedTest(session, ['src/greet.test.mjs'])
  assert.equal(testResult.exitCode, 0)
  const artifact = await exportManagedPatch(session)
  assert.equal(artifact.changes.length, 1)
  assert.match(artifact.patch, /-export const greet = \(\) => "Hi"/)
  assert.match(artifact.patch, /\+export const greet = \(\) => "Hello"/)
  execFileSync('git', ['apply', '--check', '-'], { cwd: store.projectRoot, input: artifact.patch, windowsHide: true })
  await session.cleanup()
  assert.equal((await store.get(taskId)).sandboxStatus, 'cleaned')
  assert.deepEqual((await store.get(taskId)).executions.map(item => item.exitCode), [0])
  assert.ok(calls.some(item => item[0] === 'kill'))
})

test('patch export refuses unselected or symlinked sandbox files', async t => {
  const { store, taskId } = await fixture(t)
  const files = new Map(), entries = []
  let deleted = false
  const sdk = { Sandbox: { create: async () => ({ id: 'sandbox-12345678', files: {
    createDirectories: async () => {},
    writeFiles: async values => { for (const value of values) {
      files.set(value.path, value.data); entries.push({ path: value.path, type: 'file' })
    } },
    readFile: async path => files.get(path), listDirectory: async () => entries,
  }, close: async () => {} }) }, SandboxManager: { create: () => ({
    getSandboxInfo: async () => { if (deleted) throw Object.assign(Error('gone'), { statusCode: 404 }); return { metadata: { 'iteroom-task-id': taskId } } },
    killSandbox: async () => { deleted = true }, close: async () => {},
  }) } }
  const session = await openManagedSandbox({ store, taskId, sdk, connectionConfig: { domain: '127.0.0.1:3088' }, image: `node@sha256:${hash}` })
  files.set('/workspace/src/greet.mjs', 'export const greet = () => "Hello"\n')
  entries.push({ path: '/workspace/extra.mjs', type: 'file' })
  await assert.rejects(exportManagedPatch(session), { code: 'SANDBOX_FILE_SCOPE_CHANGED' })
  entries.pop()
  entries[0] = { ...entries[0], type: 'symlink' }
  await assert.rejects(exportManagedPatch(session), { code: 'SANDBOX_FILE_SCOPE_CHANGED' })
  await session.cleanup()
})

test('test disconnect remains unknown and requires remote interrupt before cleanup', async t => {
  const { store, taskId } = await fixture(t)
  let running = true, interrupted = false
  const files = new Map(); let deleted = false
  const sdk = { Sandbox: { create: async () => ({ id: 'sandbox-12345678', files: {
    createDirectories: async () => {}, writeFiles: async entries => { for (const entry of entries) files.set(entry.path, entry.data) },
    readFile: async path => files.get(path),
  }, commands: {
    run: async (_command, _options, handlers) => { await handlers.onInit({ id: 'exec-12345678' }); throw Error('SSE lost') },
    getCommandStatus: async () => ({ running }),
    interrupt: async () => { interrupted = true; running = false },
  }, close: async () => {} }) }, SandboxManager: { create: () => ({
    getSandboxInfo: async () => { if (deleted) throw Object.assign(Error('gone'), { statusCode: 404 }); return { metadata: { 'iteroom-task-id': taskId } } },
    killSandbox: async () => { deleted = true }, close: async () => {},
  }) } }
  const session = await openManagedSandbox({ store, taskId, sdk, connectionConfig: { domain: '127.0.0.1:3088' }, image: `node@sha256:${hash}` })
  await assert.rejects(runManagedTest(session, ['src/greet.test.mjs']), { code: 'SANDBOX_EXECUTION_UNKNOWN' })
  assert.equal(interrupted, true)
  assert.equal((await store.get(taskId)).executions[0].status, 'interrupted')
  await session.cleanup()
})
