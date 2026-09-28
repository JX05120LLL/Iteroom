import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'
import { managedEnginePatch, DISABLED_HOST_ROWS } from '../src/host/managed-engine-profile.js'
import { runManagedUnderstand } from '../src/host/managed-engine-runner.js'
import { runtime, persistedSessions } from '../scripts/r0/dsh-loop-probe.mjs'

const mockAdapterPath = fileURLToPath(new URL('./fixtures/managed-engine-model.mjs', import.meta.url))

test('managed DeepSeek adapter relays text deltas over the private progress pipe without HTTP', async () => {
  const pluginUrl = new URL('../src/host/managed-engine-plugin.js', import.meta.url).href
  const script = `
    import { ManagedDeepSeekAdapter } from ${JSON.stringify(pluginUrl)};
    import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
    const options = resolveAdapterOptions({ baseURL: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-flash', contextWindow: 8192, maxTokens: 256 }] });
    const adapter = new ManagedDeepSeekAdapter({ options: () => options,
      resolveApiKey: async () => 'synthetic', resolveUserId: () => 'synthetic' });
    adapter.streamWithConnection = async function* () {
      yield { type: 'text-delta', text: 'Synthetic ' };
      yield { type: 'text-delta', text: 'stream' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const call = await adapter.prepareCall('deepseek', 'deepseek-flash');
    for await (const chunk of call.stream({})) {
      if (!['text-delta', 'finish'].includes(chunk.type)) throw Error('unexpected chunk');
    }
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ITEROOM_PROGRESS_FD: '3', DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let progress = '', diagnostics = ''
  child.stdio[3].setEncoding('utf8').on('data', chunk => { progress += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics += chunk })
  const code = await new Promise(resolve => child.once('close', resolve))
  assert.equal(code, 0, diagnostics)
  assert.deepEqual(progress.trim().split('\n').map(line => JSON.parse(line).text), ['Synthetic ', 'stream'])
})

test('official sdk-minimal Loop exposes only the task snapshot tool and reads fixed bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-engine-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project'), home = join(root, 'dsh-home')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(home)
  const source = join(project, 'src', 'example.ts')
  await writeFile(source, 'export const answer = 42\nexport const doubled = answer * 2\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'engine-1', kind: 'understand', objective: 'Explain answer',
    paths: ['src/example.ts'] })).task
  await captureManagedSnapshot(store, task.id)
  await writeFile(source, 'export const answer = 99\n')
  const patchFile = join(root, 'managed.patch.yml')
  const patch = managedEnginePatch({ dataHome: store.dataHome, projectRoot: project,
    taskId: task.id, mockAdapterPath })
  for (const row of ['sandbox', 'subprocess', 'pty', 'terminal-pwsh', 'terminal-bash',
    'persistent-pwsh', 'persistent-bash']) assert.ok(DISABLED_HOST_ROWS.includes(row) && patch.includes(`- id: ${row}\n  disabled: true`))
  await writeFile(patchFile, patch)
  const app = runtime(project, home, patchFile, { timeoutMs: 20000 })
  try {
    const hello = await app.request('initialize', { cwd: project, provider: 'iteroom-r1-mock', model: 'synthetic', maxTokens: 128 })
    assert.equal(hello.serverInfo.name, 'deepseek-harness-sdk-runtime')
    const events = await app.prompt(task.id, 'Explain the selected snapshot. Cite path and lines.')
    assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
    assert.equal(events.filter(event => event.type === 'tool/result').length, 1)
    assert.equal(await app.stop(), 0)
    const metrics = JSON.parse(await readFile(join(home, 'managed-engine-metrics.json'), 'utf8'))
    assert.deepEqual(metrics.roster, ['iteroom_read_snapshot'])
    assert.equal(metrics.calls, 2)
    assert.equal(metrics.sawFixedBytes, true)
    const sessions = await persistedSessions(join(home, 'sessions'))
    assert.ok(sessions.has(task.id))
    assert.equal(await readFile(source, 'utf8'), 'export const answer = 99\n')
    assert.equal(resolve(store.dataHome).startsWith(resolve(project)), false)
  } finally { await app.dispose() }
})

test('one-shot managed runner returns a bounded answer with tool-backed references and never replays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  const source = join(project, 'src', 'example.ts')
  await writeFile(source, 'export const answer = 42\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'runner-1', kind: 'understand',
    objective: 'Explain answer', paths: ['src/example.ts'] })).task
  await captureManagedSnapshot(store, task.id)
  await writeFile(source, 'export const answer = 99\n')
  const progress = []
  const result = await runManagedUnderstand({ store, taskId: task.id,
    provider: 'iteroom-r1-mock', model: 'synthetic', mockAdapterPath,
    maxRequests: 4, maxOutputTokens: 512, timeoutMs: 20000,
    onText: text => { progress.push(text) } })
  assert.match(progress.join(''), /Reading fixed input.*answer=42/)
  assert.match(result.answer, /answer=42/)
  assert.equal(result.sessionId, task.id)
  assert.deepEqual(result.references.map(ref => [ref.path, ref.startLine, ref.endLine]), [['src/example.ts', 1, 1]])
  assert.equal(result.turnEnd, 'completed')
  const engineHome = join(store.dataHome, 'managed-engine-v1', task.id)
  const metrics = JSON.parse(await readFile(join(engineHome, 'managed-engine-metrics.json'), 'utf8'))
  assert.equal(metrics.maxTokens, 512)
  await assert.rejects(runManagedUnderstand({ store, taskId: task.id,
    provider: 'iteroom-r1-mock', model: 'synthetic', mockAdapterPath }), { code: 'ENGINE_ALREADY_ATTEMPTED' })
  assert.equal(await readFile(source, 'utf8'), 'export const answer = 99\n')
})

test('cancelling a live managed CLI waits for the synthetic model process to exit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  const source = join(project, 'src', 'example.ts')
  await writeFile(source, 'export const answer = 42\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'cancel-1', kind: 'understand',
    objective: 'Hold synthetic model', paths: ['src/example.ts'] })).task
  await captureManagedSnapshot(store, task.id)
  const controller = new AbortController()
  let pid
  let ready
  const started = new Promise(resolveReady => { ready = resolveReady })
  const running = runManagedUnderstand({ store, taskId: task.id,
    provider: 'iteroom-r1-mock', model: 'synthetic', mockAdapterPath, timeoutMs: 20000,
    signal: controller.signal, onProcess: childPid => { pid = childPid }, onReady: ready })
  await started
  controller.abort()
  await assert.rejects(running, { code: 'ENGINE_CANCELLED' })
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  assert.equal(await readFile(source, 'utf8'), 'export const answer = 42\n')
})
