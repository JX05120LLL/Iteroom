import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { saveReviewPreparation } from '../src/host/managed-review-snapshot.js'
import { ManagedReviewInference } from '../src/host/managed-review-inference.js'
import { ManagedHistory } from '../src/host/managed-history.js'
import { ManagedAcceptance } from '../src/host/managed-acceptance.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'
import { saveManagedArtifact } from '../src/host/managed-artifact.js'
import { ManagedModifyCoordinator } from '../src/host/managed-modify-coordinator.js'
import { createManagedTaskRoutes } from '../src/host/managed-task-route.js'

const hash = value => createHash('sha256').update(value).digest('hex')
const execute = promisify(execFile)
const sourcePath = 'src/divide.mjs', testPath = 'src/divide.test.mjs'
const before = 'export const divide = value => value\n'
const bad = 'export const divide = value => value / 0\n'
const fixed = 'export const divide = value => value / 2\n'
const side = (path, content) => ({ path, content, contentSha256: hash(content), bytes: Buffer.byteLength(content), mode: '100644' })

async function fixture(t, { quote = 'value / 0', sideName = 'new', status = 'modified', sourceName = sourcePath } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r4-fix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(join(project, 'src'), { recursive: true })
  await mkdir(dirname(join(project, sourceName)), { recursive: true })
  await writeFile(join(project, sourceName), before)
  await writeFile(join(project, testPath), 'import assert from "node:assert/strict"\nimport { divide } from "./divide.mjs"\nassert.equal(divide(4), 2)\n')
  await execute('git', ['init', '-q'], { cwd: project })
  await execute('git', ['add', '.'], { cwd: project })
  await execute('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic baseline'], { cwd: project })
  await writeFile(join(project, sourceName), bad)
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'original-review', kind: 'review', objective: '审查变更', paths: [], reviewInput: { mode: 'workspace' } })).task
  const entry = { status, kind: 'text', old: side(sourceName, before), new: side(sourceName, bad), diff: `-${before}+${bad}`, diffSha256: hash(`-${before}+${bad}`) }
  const rule = 'Check synthetic correctness.'
  const preparation = await saveReviewPreparation(store, task.id, { selection: { mode: 'workspace' }, inputSha256: hash('synthetic'), entries: [entry] },
    { version: 'v1.12.9', schemaVersion: '1', actualCli: false,
      coverage: [{ path: sourceName, status: 'pending_inference', side: 'new', oldPath: sourceName, newPath: sourceName, ocrExcludeReason: null }],
      groups: [{ groupId: 1, source: 'system', pattern: '*', rule, sha256: hash(rule), files: [sourceName] }] })
  await store.attachReviewPreparation(task.id, preparation.id)
  const inference = new ManagedReviewInference(store, { modelKey: async () => 'synthetic-only', run: async args => {
    await args.onReady()
    return { sessionId: args.taskId, turnEnd: 'completed', readGroupIds: [1], answer: JSON.stringify({ groups: [{ groupId: 1,
      findings: [{ path: sourceName, side: sideName, quote, message: 'Synthetic zero divisor candidate.', severity: 'high' }] }] }) }
  } })
  await inference.start(task.id, 'synthetic-review-start'); await inference.whenIdle(task.id)
  const report = await inference.result(task.id)
  const origin = { reviewTaskId: task.id, preparationId: preparation.id, reportId: report.id, findingId: report.findings[0].id, path: sourceName, sourceSha256: report.findings[0].sourceSha256 }
  return { root, project, store, taskId: task.id, preparation, report, origin,
    input: { taskId: task.id, findingId: report.findings[0].id, requestId: 'create-linked-fix', objective: 'Use divisor two', testPaths: [testPath] } }
}

async function coordinator(store, options) {
  const { ManagedReviewFix } = await import('../src/host/managed-review-fix.js')
  return new ManagedReviewFix(store, options)
}

// Synthetic persisted execution receipt only; this helper does not execute a sandbox or model.
async function candidate(store, taskId, after = fixed) {
  const snapshot = await captureManagedSnapshot(store, taskId)
  await store.claimModify(taskId, 'synthetic-modify-start')
  await store.recordSandbox(taskId, 'synthetic-sandbox-12345')
  await store.recordExecutionStart(taskId, { id: 'synthetic-exec-12345', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(taskId, 'synthetic-exec-12345', { status: 'completed', exitCode: 0, outputBytes: 2, outputSha256: hash('ok') })
  await store.markSandboxCleaned(taskId)
  const patch = `diff --git a/${sourcePath} b/${sourcePath}\n--- a/${sourcePath}\n+++ b/${sourcePath}\n@@ -1,1 +1,1 @@\n-${bad}+${after}`
  const saved = await saveManagedArtifact(store, taskId, { version: 1, taskId, snapshotId: snapshot.id,
    changes: [{ path: sourcePath, kind: 'modified', beforeSha256: hash(bad), afterSha256: hash(after), beforeBytes: Buffer.byteLength(bad), afterBytes: Buffer.byteLength(after) }], patch, sha256: hash(patch) })
  await store.finishModify(taskId, { artifactId: saved.id, changeCount: 1, verificationId: 'synthetic-exec-12345' })
  return saved
}

test('linked task creation stores immutable provenance atomically and prevents dangling history references', async t => {
  const f = await fixture(t)
  const input = { requestId: 'relation-test', kind: 'modify', objective: 'Fix candidate', paths: [sourcePath, testPath] }
  const result = await f.store.create(input, { reviewOrigin: f.origin })
  assert.deepEqual(result.task.reviewOrigin, f.origin)
  assert.deepEqual((await new ManagedTaskStore(f.store.dataHome, f.project).get(result.task.id)).reviewOrigin, f.origin)
  assert.equal((await f.store.create(input, { reviewOrigin: f.origin })).created, false)
  await assert.rejects(f.store.create(input, { reviewOrigin: { ...f.origin, findingId: hash('different') } }), { code: 'REQUEST_ID_CONFLICT' })
  await assert.rejects(new ManagedHistory(f.store).delete(f.taskId, 'delete-parent'), { code: 'HISTORY_REFERENCED' })
  await f.store.cancelQueuedModify(result.task.id)
  await new ManagedHistory(f.store).delete(result.task.id, 'delete-child')
  assert.equal((await new ManagedHistory(f.store).delete(f.taskId, 'delete-parent')).deleted, true)
})

test('fix preparation pins current bytes, merges duplicate clicks and survives restart without execution', async t => {
  const f = await fixture(t), fix = await coordinator(f.store)
  const results = await Promise.all([fix.create(f.input), fix.create(f.input)])
  assert.equal(results[0].task.id, results[1].task.id)
  const task = results[0].task
  assert.deepEqual(task.reviewOrigin, f.origin)
  assert.ok(task.snapshotId); assert.equal(task.status, 'queued'); assert.equal(task.sessionId, null)
  assert.deepEqual(task.paths, [sourcePath, testPath]); assert.deepEqual(task.executionIds, [])
  await writeFile(join(f.project, sourcePath), 'external edit\n')
  const repeat = await (await coordinator(f.store)).create(f.input)
  assert.equal(repeat.task.id, task.id); assert.equal(repeat.task.snapshotId, task.snapshotId)
  assert.equal(await readFile(join(f.project, sourcePath), 'utf8'), 'external edit\n')
  await assert.rejects(fix.create({ ...f.input, objective: 'Different objective' }), { code: 'REQUEST_ID_CONFLICT' })
})

test('stale, unlocated, old-side and unsupported candidates cannot create repair tasks', async t => {
  for (const options of [{ quote: 'missing' }, { sideName: 'old', quote: 'value' }, { status: 'renamed' },
    { sourceName: 'src/divide.test.ts' }, { sourceName: 'src/divide.spec.ts' }, { sourceName: 'src/__tests__/divide.mjs' }]) {
    const f = await fixture(t, options)
    await assert.rejects((await coordinator(f.store)).create(f.input), { code: 'REVIEW_FIX_UNSUPPORTED' })
    assert.equal((await f.store.list()).length, 1)
  }
  const f = await fixture(t)
  await writeFile(join(f.project, sourcePath), 'external edit\n')
  await assert.rejects((await coordinator(f.store)).create(f.input), { code: 'REVIEW_FIX_INPUT_CHANGED' })
  assert.equal((await f.store.list()).length, 1)
})

test('fix rejects forged candidates, unsafe or duplicate paths and missing test scope', async t => {
  const f = await fixture(t), fix = await coordinator(f.store)
  for (const input of [{ ...f.input, findingId: hash('unknown') }, { ...f.input, testPaths: [] },
    { ...f.input, testPaths: ['../outside.test.mjs'] }, { ...f.input, testPaths: [testPath, testPath] },
    { ...f.input, testPaths: [sourcePath] }, { ...f.input, extra: true }, { ...f.input, requestId: 1 }]) {
    await assert.rejects(fix.create(input))
  }
  assert.equal((await f.store.list()).length, 1)
  await assert.rejects(f.store.create({ requestId: 'spoof', kind: 'modify', objective: 'Spoof', paths: [sourcePath, testPath], reviewOrigin: f.origin }), { code: 'INVALID_TASK_INPUT' })
})

test('recheck requires accepted provenance and matching current artifact bytes', async t => {
  const f = await fixture(t), fix = await coordinator(f.store)
  const { task } = await fix.create(f.input)
  await assert.rejects(fix.recheck({ taskId: task.id, requestId: 'recheck-before' }), { code: 'REVIEW_RECHECK_NOT_ACCEPTED' })
  await candidate(f.store, task.id)
  await assert.rejects(fix.recheck({ taskId: task.id, requestId: 'recheck-before' }), { code: 'REVIEW_RECHECK_NOT_ACCEPTED' })
  await new ManagedAcceptance(f.store).accept(task.id, 'synthetic-accept')
  await writeFile(join(f.project, sourcePath), 'external edit\n')
  await assert.rejects(fix.recheck({ taskId: task.id, requestId: 'recheck-stale' }), { code: 'REVIEW_RECHECK_INPUT_CHANGED' })
  await writeFile(join(f.project, sourcePath), fixed)
  await writeFile(join(f.project, testPath), 'external test edit\n')
  await assert.rejects(fix.recheck({ taskId: task.id, requestId: 'recheck-stale-tests' }), { code: 'REVIEW_RECHECK_INPUT_CHANGED' })
  assert.equal((await f.store.list()).length, 2)
})

test('restoring the Git baseline is reported unsupported rather than a zero-finding recheck', { skip: !process.env.ITEROOM_OCR_BIN }, async t => {
  const f = await fixture(t), fix = await coordinator(f.store)
  const { task } = await fix.create(f.input)
  await candidate(f.store, task.id, before)
  await new ManagedAcceptance(f.store).accept(task.id, 'accept-baseline')
  await assert.rejects(fix.recheck({ taskId: task.id, requestId: 'baseline-recheck' }), { code: 'REVIEW_RECHECK_TARGET_MISSING' })
  const fresh = (await f.store.list()).find(item => item.recheckOrigin)
  assert.equal(fresh.reviewSnapshotId, undefined); assert.equal(fresh.sessionId, null)
  assert.equal(fresh.reviewFailureCode, 'REVIEW_RECHECK_TARGET_MISSING')
})

test('real OCR recheck fixes new input and relation without claiming a model result', { skip: !process.env.ITEROOM_OCR_BIN }, async t => {
  const f = await fixture(t), fix = await coordinator(f.store)
  const { task } = await fix.create(f.input)
  const artifact = await candidate(f.store, task.id)
  await new ManagedAcceptance(f.store).accept(task.id, 'synthetic-accept')
  const beforeGit = await execute('git', ['status', '--porcelain=v1'], { cwd: f.project })
  const results = await Promise.all([fix.recheck({ taskId: task.id, requestId: 'new-review' }), fix.recheck({ taskId: task.id, requestId: 'new-review' })])
  const fresh = results[0]
  assert.equal(fresh.task.id, results[1].task.id)
  assert.notEqual(fresh.task.id, f.taskId); assert.notEqual(fresh.preparation.id, f.preparation.id)
  assert.deepEqual(fresh.task.recheckOrigin, { modifyTaskId: task.id, artifactId: artifact.id })
  assert.equal(fresh.task.status, 'queued'); assert.equal(fresh.task.sessionId, null); assert.equal(fresh.task.reviewReportId, undefined)
  assert.equal(fresh.preparation.input.entries.find(entry => entry.new?.path === sourcePath).new.content, fixed)
  await writeFile(join(f.project, sourcePath), 'later edit\n')
  assert.equal((await (await coordinator(f.store)).recheck({ taskId: task.id, requestId: 'new-review' })).preparation.id, fresh.preparation.id)
  await assert.rejects(new ManagedHistory(f.store).delete(task.id, 'delete-fix'), { code: 'HISTORY_REFERENCED' })
  await writeFile(join(f.project, sourcePath), fixed)
  assert.equal((await execute('git', ['status', '--porcelain=v1'], { cwd: f.project })).stdout, beforeGit.stdout)
})

test('a source change during repair capture cannot start the engine or allocate a sandbox', async t => {
  const f = await fixture(t)
  const original = f.store.create.bind(f.store)
  f.store.create = async (...args) => {
    const receipt = await original(...args)
    if (args[1]?.reviewOrigin) await writeFile(join(f.project, sourcePath), 'export const external = true\n')
    return receipt
  }
  await assert.rejects((await coordinator(f.store)).create(f.input), { code: 'REVIEW_FIX_INPUT_CHANGED' })
  const task = (await f.store.list()).find(task => task.kind === 'modify')
  let allocated = 0, called = 0
  const modify = new ManagedModifyCoordinator(f.store, { modelKey: async () => 'synthetic-only', sandboxConfig: async () => ({}),
    open: async () => { allocated++; throw Error('must not allocate') }, run: async () => { called++ } })
  await assert.rejects(modify.start(task.id, 'race-start'), { code: 'REVIEW_FIX_INPUT_CHANGED' })
  assert.equal(allocated, 0); assert.equal(called, 0)
  assert.equal((await f.store.get(task.id)).status, 'queued')
})

test('new review routes enforce origin, exact bodies and bounded JSON without execution', async t => {
  const f = await fixture(t)
  const routes = createManagedTaskRoutes(f.store, { initialize: async () => {} }, { initialize: async () => {} })
  const route = action => routes.find(route => route.path.endsWith(`/review/${action}`))
  const post = (action, input, extra = {}) => route(action).fetch(new Request(`http://127.0.0.1/review/${action}`, {
    method: 'POST', headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input) }))
  assert.equal((await post('fix', f.input, { Origin: 'https://untrusted.invalid' })).status, 403)
  assert.equal((await post('fix', f.input, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await post('fix', { ...f.input, extra: true })).status, 400)
  assert.equal((await post('fix', { ...f.input, objective: 'x'.repeat(9000) })).status, 413)
  assert.equal((await post('recheck', { taskId: f.taskId, requestId: 1 })).status, 400)
  const response = await post('fix', f.input)
  assert.equal(response.status, 201)
  const result = await response.json()
  assert.ok(result.task.snapshotId); assert.equal(result.task.engineStatus, 'not_started')
  assert.equal((await post('fix', f.input)).status, 200)
})

test('malformed relation metadata and references to a missing parent fail closed', async t => {
  const f = await fixture(t)
  const input = { requestId: 'invalid-relation', kind: 'modify', objective: 'Fix', paths: [sourcePath, testPath] }
  await assert.rejects(f.store.create(input, { reviewOrigin: { ...f.origin, sourceSha256: 1 } }), { code: 'INVALID_TASK_INPUT' })
  await assert.rejects(f.store.create(input, { reviewOrigin: { ...f.origin, extra: true } }), { code: 'INVALID_TASK_INPUT' })
  await assert.rejects(f.store.create(input, { recheckOrigin: { modifyTaskId: f.taskId, artifactId: hash('fake') } }), { code: 'INVALID_TASK_INPUT' })
  const { task } = await (await coordinator(f.store)).create(f.input)
  const location = await f.store.location(), state = JSON.parse(await readFile(location.file, 'utf8'))
  state.tasks = state.tasks.filter(item => item.id !== f.taskId)
  await writeFile(location.file, JSON.stringify(state))
  await assert.rejects(f.store.get(task.id), { code: 'TASK_STORE_INVALID' })
})

test('cancel waits for linked snapshot preparation before history deletion can finish', async t => {
  const f = await fixture(t), fix = await coordinator(f.store)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const originalGet = f.store.get.bind(f.store), originalCreate = f.store.create.bind(f.store)
  let childId, paused = false
  f.store.create = async (...args) => {
    const result = await originalCreate(...args)
    if (args[1]?.reviewOrigin) childId = result.task.id
    return result
  }
  f.store.get = async id => {
    if (id === childId && !paused) { paused = true; entered.resolve(); await release.promise }
    return originalGet(id)
  }
  const creating = fix.create(f.input)
  const modification = new ManagedModifyCoordinator(f.store)
  const routes = createManagedTaskRoutes(f.store, { initialize: async () => {} }, modification,
    undefined, undefined, undefined, undefined, fix)
  try {
    await entered.promise
    const cancelling = routes.find(route => route.path.endsWith('/modify/cancel')).fetch(new Request('http://127.0.0.1/cancel', {
      method: 'POST', headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: childId, requestId: 'cancel-preparing' }) }))
    const settledEarly = await Promise.race([cancelling.then(() => true), new Promise(done => setTimeout(() => done(false), 50))])
    assert.equal(settledEarly, false, 'cancel must wait for the owned preparation')
    release.resolve(); await creating
    assert.equal((await cancelling).status, 200)
    await new ManagedHistory(f.store).delete(childId, 'delete-after-preparation')
    const location = await f.store.location()
    await assert.rejects(lstat(join(f.store.dataHome, 'managed-snapshots-v1', location.projectId, childId)), { code: 'ENOENT' })
    assert.equal((await f.store.list()).length, 1)
  } finally { release.resolve(); await creating.catch(() => {}); await modification.dispose() }
})
