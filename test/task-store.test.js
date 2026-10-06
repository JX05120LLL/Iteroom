import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../src/index.js'
import { TaskStore, projectTasks } from '../src/host/task-store.js'

const at = Date.parse('2026-09-24T10:00:00.000Z')
const event = (seq, type, data) => ({ seq, type, data, time: at + seq * 1000 })
const inspection = (events, cwd = 'C:\\work\\sample') => ({
  meta: { id: 'session-1', cwd }, inheritedEventCount: 0, events,
})
const result = (turn, callId, text, isError = false) => event(4, 'tool/result', {
  turn,
  message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }] },
})

test('projects durable turns, prompt identity, tool activity, and only actual Shell check results', () => {
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'Check code' }] }),
    event(2, 'tool/call', { turn: 1, callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test', description: 'test' }) }),
    result(1, 'call-1', '1 passing\n'),
    event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(6, 'turn/start', { turn: 2 }),
    event(7, 'tool/call', { turn: 2, callId: 'call-2', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run check', description: 'check' }) }),
    event(8, 'tool/result', { turn: 2, message: { content: [{ type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'Type error\n[exit code: 2]' }] }] } }),
    event(9, 'turn/end', { turn: 2, reason: { kind: 'error' } }),
  ]
  const cards = projectTasks(inspection(events))
  assert.equal(cards.length, 2)
  assert.equal(cards[0].status, 'failed')
  assert.deepEqual(cards[0].verification.map(v => [v.command, v.status, v.exitCode]), [['npm run check', 'failed', 2]])
  assert.equal(cards[1].status, 'completed')
  assert.equal(cards[1].requestId, 'rpc-1')
  assert.equal(cards[1].prompt, 'Check code')
  assert.equal(cards[1].evidenceStatus, 'unavailable')
  assert.deepEqual(cards[1].verification.map(v => [v.command, v.status, v.exitCode]), [['npm test', 'passed', 0]])
  assert.equal(cards[1].activities.length, 2)
  assert.equal(cards[1].activities[0].label, '调用 pwsh 工具')
  assert.equal(cards[1].startedAt, new Date(at).toISOString())
  assert.ok(cards[1].warnings.some(warning => warning.includes('Git 忽略文件')))
})

test('does not call a background, denied, interrupted, or prose-only check passed', () => {
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'tool/call', { turn: 1, callId: 'background', name: 'bash', arguments: JSON.stringify({ command: 'npm test', run_in_background: true }) }),
    event(2, 'tool/result', { turn: 1, message: { content: [{ type: 'tool-result', toolCallId: 'background', content: [{ type: 'text', text: 'started background job job-1' }] }] } }),
    event(3, 'tool/call', { turn: 1, callId: 'denied', name: 'bash', arguments: JSON.stringify({ command: 'pytest' }) }),
    event(4, 'tool/result', { turn: 1, message: { content: [{ type: 'tool-result', toolCallId: 'denied', content: [{ type: 'text', text: '[sandbox: file access denied under read-only mode]' }] }] } }),
    event(5, 'tool/call', { turn: 1, callId: 'cancelled', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run build' }) }),
    event(6, 'tool/result', { turn: 1, message: { content: [{ type: 'tool-result', toolCallId: 'cancelled', content: [{ type: 'text', text: '(no output)\n[exit code: 1]' }] }] } }),
    event(7, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'All tests passed' }] } }),
    event(8, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }),
  ]
  const [card] = projectTasks(inspection(events))
  assert.equal(card.status, 'cancelled')
  assert.deepEqual(card.verification.map(v => v.status), ['unknown', 'unknown'])
  assert.equal(card.verification.some(v => v.command === 'npm test'), false)
})

test('only exact short check commands enter verification evidence', () => {
  const commands = ['npm test --token=secret', 'npm test && curl example.com', 'npm run build; echo secret', 'npm test\nWrite-Host secret', 'npm test ']
  const events = [event(0, 'turn/start', { turn: 1 })]
  for (const [index, command] of commands.entries()) {
    const callId = `call-${index}`
    events.push(event(index * 2 + 1, 'tool/call', { turn: 1, callId, name: 'pwsh', arguments: JSON.stringify({ command }) }))
    events.push(event(index * 2 + 2, 'tool/result', { turn: 1, message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] } }))
  }
  events.push(event(11, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  const [card] = projectTasks(inspection(events))
  assert.deepEqual(card.verification, [])
  assert.equal(JSON.stringify(card).includes('secret'), false)
})

test('verification records the effective directory and does not credit checks outside the project', () => {
  const project = join(tmpdir(), 'iteroom-scope-project')
  const outside = join(tmpdir(), 'other-project')
  const events = [event(0, 'turn/start', { turn: 1 })]
  for (const [index, workdir] of ['subdir', outside].entries()) {
    const callId = `scope-${index}`
    events.push(event(index * 2 + 1, 'tool/call', {
      turn: 1, callId, name: 'pwsh', arguments: JSON.stringify({ command: 'npm test', workdir }),
    }))
    events.push(event(index * 2 + 2, 'tool/result', {
      turn: 1, message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] },
    }))
  }
  events.push(event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
  const [card] = projectTasks(inspection(events, project))
  assert.deepEqual(card.verification.map(check => [check.status, check.cwd]), [
    ['passed', join(project, 'subdir')], ['out-of-scope', outside],
  ])
  assert.ok(card.verification[1].summary.includes('不作为本项目'))
})

test('diff evidence distinguishes live, confirmed empty, and unavailable snapshots', () => {
  const base = { cwd: 'C:\\work\\sample', warnings: [] }
  const running = inspection([event(0, 'turn/start', { turn: 1 })])
  const completed = inspection([
    event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ])
  assert.equal(projectTasks(running, new Map([[1, { baseline: base }]]))[0].evidenceStatus, 'pending')
  assert.equal(projectTasks(completed, new Map([[1, { baseline: base, final: { changes: [], warnings: [] } }]]))[0].evidenceStatus, 'available')
  const failed = projectTasks(completed, new Map([[1, { baseline: base, finalError: 'comparison failed' }]]))[0]
  assert.equal(failed.evidenceStatus, 'unavailable')
  assert.ok(failed.warnings.includes('comparison failed'))
})

test('persists a bounded baseline and terminal workspace delta for cold read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-task-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'project')
  const dataHome = join(directory, 'private-data')
  let captures = 0
  const capture = async cwd => {
    captures++
    return { cwd, capturedAt: new Date(at).toISOString(), files: [{ path: 'src/a.js', priorChange: true, contentBase64: Buffer.from('private baseline').toString('base64') }], warnings: [] }
  }
  const compare = async () => ({ changes: [{ path: 'src/a.js', status: 'modified', priorChange: true, diff: '--- a/src/a.js\n+++ b/src/a.js\n' }], warnings: [] })
  const store = new TaskStore(dataHome, { capture, compare })
  await Promise.all([
    store.prepare({ sessionId: 'session-1', turn: 1, cwd: workspace }),
    store.prepare({ sessionId: 'session-1', turn: 1, cwd: workspace }),
  ])
  assert.equal(captures, 1)
  await store.finish({ sessionId: 'session-1', turn: 1, cwd: workspace })
  const persisted = await store.read('session-1', 1)
  assert.equal(persisted.baseline.fileCount, 1)
  assert.equal(persisted.baseline.files, undefined)
  const cold = new TaskStore(dataHome, { capture: async () => { throw Error('must not capture on cold read') }, compare })
  const [card] = await cold.tasksForInspection(inspection([
    event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ], workspace))
  assert.equal(card.changes.length, 1)
  assert.equal(card.evidenceStatus, 'available')
  assert.equal(card.changes[0].priorChange, true)
  assert.ok(card.warnings.some(warning => warning.includes('外部编辑也可能混入')))
})

test('workspace evidence survives a project directory junction in live and terminal reads', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-task-alias-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'project'), alias = join(directory, 'project-alias')
  await mkdir(project)
  await symlink(project, alias, 'junction')
  const change = { path: 'smoke-result.txt', status: 'added', priorChange: false, diff: '+one line' }
  const store = new TaskStore(join(directory, 'data'), {
    capture: async cwd => ({ cwd: await realpath(cwd), files: [], warnings: [] }),
    compare: async () => ({ changes: [change], warnings: [] }),
  })
  await store.prepare({ sessionId: 'session-1', turn: 1, cwd: alias })
  const running = await store.tasksForInspection(inspection([event(0, 'turn/start', { turn: 1 })], alias))
  assert.deepEqual(running[0].changes, [change])
  await store.finish({ sessionId: 'session-1', turn: 1, cwd: alias })
  const completed = await store.tasksForInspection(inspection([
    event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ], alias))
  assert.equal(completed[0].evidenceStatus, 'available')
  assert.deepEqual(completed[0].changes, [change])
})

test('workspace evidence refuses a junction redirected after the baseline', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-task-alias-change-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'project'), replacement = join(directory, 'replacement')
  const alias = join(directory, 'project-alias')
  await mkdir(project)
  await mkdir(replacement)
  await symlink(project, alias, 'junction')
  let comparisons = 0
  const store = new TaskStore(join(directory, 'data'), {
    capture: async cwd => ({ cwd: await realpath(cwd), files: [], warnings: [] }),
    compare: async () => { comparisons++; return { changes: [], warnings: [] } },
  })
  await store.prepare({ sessionId: 'session-1', turn: 1, cwd: alias })
  await rm(alias, { recursive: true })
  await symlink(replacement, alias, 'junction')
  await store.finish({ sessionId: 'session-1', turn: 1, cwd: alias })
  const record = await store.read('session-1', 1)
  assert.equal(comparisons, 0)
  assert.equal(record.final, undefined)
  assert.match(record.finalError, /Workspace path changed/)
})

test('next turn waits for the previous terminal comparison in one workspace', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-task-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'project')
  let releaseComparison
  const comparisonGate = new Promise(resolve => { releaseComparison = resolve })
  const captures = []
  const store = new TaskStore(join(directory, 'data'), {
    capture: async cwd => { captures.push(cwd); return { cwd, files: [], warnings: [] } },
    compare: async () => { await comparisonGate; return { changes: [], warnings: [] } },
  })
  await store.prepare({ sessionId: 'session-1', turn: 1, cwd: workspace })
  const finishing = store.finish({ sessionId: 'session-1', turn: 1, cwd: workspace })
  const next = store.prepare({ sessionId: 'session-1', turn: 2, cwd: workspace })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(captures.length, 1)
  releaseComparison()
  await Promise.all([finishing, next])
  assert.equal(captures.length, 2)
})

test('a failed baseline or missing terminal comparison stays unknown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-task-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'project')
  const store = new TaskStore(join(directory, 'data'), { capture: async () => { throw Error('not a Git worktree') } })
  await store.prepare({ sessionId: 'session-1', turn: 1, cwd: workspace })
  const [card] = await store.tasksForInspection(inspection([
    event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ], workspace))
  assert.equal(card.changes.length, 0)
  assert.equal(card.evidenceStatus, 'unavailable')
  assert.ok(card.warnings.some(warning => warning.includes('快照失败')))
  assert.ok(card.warnings.some(warning => warning.includes('无法确认该轮文件变化')))
})

test('Host route validates session identity before inspect and returns no-store JSON', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-route-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const original = process.env.ITEROOM_DATA_HOME
  process.env.ITEROOM_DATA_HOME = join(directory, 'data')
  t.after(() => { if (original === undefined) delete process.env.ITEROOM_DATA_HOME; else process.env.ITEROOM_DATA_HOME = original })
  let route
  let inspections = 0
  apply({
    on() {},
    effect(register) { register() },
    connection: { fetch: { register(value) { route = value; return async () => {} } } },
    sessionController: { async inspect() { inspections++; return inspection([]) } },
    logger: { warn() {} },
  })
  assert.equal(route.path, '/api/iteroom/tasks')
  const invalid = await route.fetch(new Request('http://localhost/api/iteroom/tasks?sessionId=..%2Fprivate'))
  assert.equal(invalid.status, 400)
  assert.equal(inspections, 0)
  const valid = await route.fetch(new Request('http://localhost/api/iteroom/tasks?sessionId=session-1'))
  assert.equal(valid.status, 200)
  assert.equal(valid.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await valid.json(), { tasks: [] })
  assert.equal(inspections, 1)
})

test('Host route maps the pinned DSH missing-session error to 404', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'iteroom-route-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const original = process.env.ITEROOM_DATA_HOME
  process.env.ITEROOM_DATA_HOME = join(directory, 'data')
  t.after(() => { if (original === undefined) delete process.env.ITEROOM_DATA_HOME; else process.env.ITEROOM_DATA_HOME = original })
  let route
  apply({
    on() {}, effect(register) { register() },
    connection: { fetch: { register(value) { route = value; return async () => {} } } },
    sessionController: { async inspect() { class ApiSessionNotFound extends Error {}; throw new ApiSessionNotFound('missing') } },
    logger: { warn() {} },
  })
  const response = await route.fetch(new Request('http://localhost/api/iteroom/tasks?sessionId=session-1'))
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
