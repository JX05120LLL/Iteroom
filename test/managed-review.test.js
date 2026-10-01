import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture, git } from '../scripts/r0/ocr-fixture.mjs'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { ManagedHistory } from '../src/host/managed-history.js'

const sha = value => createHash('sha256').update(value).digest('hex')
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r4-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = await createFixture(root)
  const project = join(root, 'project')
  await rename(original.repository, project)
  const source = { ...original, repository: project, options: { ...original.options, cwd: project } }
  await git(source, ['config', 'remote.origin.url', 'https://example.invalid/synthetic.git'])
  return { root, source, store: new ManagedTaskStore(join(root, 'data'), project) }
}
function offlineDelegate({ copy }) {
  const coverage = copy.record.entries.map(entry => {
    const path = entry.new?.path ?? entry.old.path
    const excluded = entry.kind === 'binary' || path.startsWith('vendor/')
    return { path, status: excluded ? 'excluded' : 'pending_inference', side: entry.new ? 'new' : 'old',
      oldPath: entry.old?.path ?? null, newPath: entry.new?.path ?? null,
      ocrExcludeReason: excluded ? (entry.kind === 'binary' ? 'binary' : 'provider_directory')
        : entry.status === 'deleted' ? 'deleted' : /\.test\./.test(path) ? 'default_path' : null,
      includedBy: entry.status === 'deleted' ? 'iteroom-deletion-context' : /\.test\./.test(path) ? 'iteroom-test-include' : 'ocr-delegate' }
  })
  const rule = 'Synthetic review rule'
  const files = coverage.filter(item => item.status === 'pending_inference').map(item => item.path)
  return { version: 'v1.12.9', schemaVersion: '1', actualCli: false, coverage,
    groups: files.length ? [{ groupId: 1, source: 'system', pattern: '*', rule, sha256: sha(rule), files }] : [] }
}
async function coordinator(f, options = {}) {
  const { ManagedReviewCoordinator } = await import('../src/host/managed-review-coordinator.js')
  return new ManagedReviewCoordinator(f.store, {
    executable: () => join(f.root, 'synthetic-ocr.exe'), verify: async () => {},
    delegate: offlineDelegate, ...options,
  })
}

test('review task metadata preserves old kinds and occupies the project until abandoned', async t => {
  const f = await fixture(t)
  const input = { requestId: 'review-store', kind: 'review', objective: '审查变更', paths: [],
    reviewInput: { mode: 'workspace' } }
  const first = await f.store.create(input)
  assert.equal(first.task.sessionId, null)
  assert.equal(first.task.engineStatus, 'not_started')
  assert.equal((await f.store.create(input)).created, false)
  await assert.rejects(f.store.create({ ...input, reviewInput: { mode: 'commit', commit: 'f'.repeat(40) } }),
    { code: 'REQUEST_ID_CONFLICT' })
  await assert.rejects(f.store.create({ requestId: 'blocked-review', kind: 'understand', objective: 'Explain',
    paths: ['src/greet.ts'] }), { code: 'ACTIVE_TASK_EXISTS' })
  await f.store.cancelQueuedReview(first.task.id, 'cancel-review')
  assert.equal((await f.store.get(first.task.id)).status, 'cancelled')
  await new ManagedHistory(f.store).delete(first.task.id, 'delete-review')
  assert.equal((await f.store.list()).length, 0)
  const commitInput = { ...input, requestId: 'review-order', reviewInput: { mode: 'commit', commit: 'f'.repeat(40) } }
  const commitTask = await f.store.create(commitInput)
  assert.equal((await f.store.create({ ...commitInput, reviewInput: { commit: 'f'.repeat(40), mode: 'commit' } })).created, false)
  await f.store.cancelQueuedReview(commitTask.task.id, 'cancel-order')
})

test('review preparation is fixed, durable, hash-bound, explicit about exclusions and contains no model execution', async t => {
  const f = await fixture(t), review = await coordinator(f)
  const before = await git(f.source, ['status', '--porcelain=v1', '-z'])
  const prepared = await review.prepare({ requestId: 'review-fixed', input: { mode: 'workspace' } })
  assert.equal(prepared.task.status, 'queued')
  assert.equal(prepared.task.sessionId, null)
  assert.equal(prepared.preparation.coverage.length, 7)
  assert.equal(prepared.preparation.coverage.find(item => item.path === 'test/greet.test.ts').includedBy,
    'iteroom-test-include')
  assert.equal(prepared.preparation.coverage.find(item => item.path === 'src/gone.ts').side, 'old')
  assert.equal(prepared.preparation.coverage.find(item => item.path === 'src/renamed.ts').oldPath, 'src/original.ts')
  assert.equal(await git(f.source, ['status', '--porcelain=v1', '-z']), before)
  await writeFile(join(f.source.repository, 'src/greet.ts'), 'later edit\n')
  const reopened = await coordinator(f)
  const retry = await reopened.prepare({ requestId: 'review-fixed', input: { mode: 'workspace' } })
  assert.equal(retry.created, false)
  assert.equal(retry.preparation.id, prepared.preparation.id)
  assert.equal(retry.preparation.input.entries.find(entry => entry.new?.path === 'src/greet.ts').new.content,
    'export const greeting = "new"\n')
  await reopened.cancel(prepared.task.id, 'cancel-fixed')
  const location = await f.store.location()
  const file = join(f.store.dataHome, 'managed-reviews-v1', location.projectId, prepared.task.id, 'prepared.json')
  const bytes = await readFile(file)
  await writeFile(file, bytes.toString().replace('greeting', 'tampered'))
  await assert.rejects(reopened.preparation(prepared.task.id), { code: 'REVIEW_SNAPSHOT_INVALID' })
  await new ManagedHistory(f.store).delete(prepared.task.id, 'delete-fixed')
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.source.repository, 'src/greet.ts'), 'utf8'), 'later edit\n')
})

test('review input validation, process failure and unsafe repository leave a cancellable task without source writes', async t => {
  const f = await fixture(t), review = await coordinator(f)
  for (const input of [{ mode: 'commit', commit: 'HEAD' }, { mode: 'range', from: 'f'.repeat(40) },
    { mode: 'workspace', repo: f.source.repository }]) {
    await assert.rejects(review.prepare({ requestId: 'invalid-review', input }), { code: 'INVALID_REVIEW_INPUT' })
  }
  assert.equal((await f.store.list()).length, 0)
  const failed = await coordinator(f, { delegate: async () => { throw Object.assign(Error('private diagnostic'), { code: 'timeout' }) } })
  await assert.rejects(failed.prepare({ requestId: 'review-timeout', input: { mode: 'workspace' } }),
    { code: 'REVIEW_TIMEOUT' })
  const task = (await f.store.list())[0]
  assert.equal(task.reviewSnapshotId ?? null, null)
  await failed.cancel(task.id, 'cancel-timeout')
  await git(f.source, ['config', 'filter.synthetic.clean', 'synthetic-forbidden-command'])
  await assert.rejects(review.prepare({ requestId: 'review-unsafe', input: { mode: 'workspace' } }),
    { code: 'REVIEW_UNSUPPORTED_GIT_CONFIG' })
  assert.equal(await readFile(join(f.source.repository, 'src/greet.ts'), 'utf8'), 'export const greeting = "new"\n')
})

test('overlapping preparation retries share one copy and cancellation waits for preparation cleanup', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  let calls = 0
  const review = await coordinator(f, { delegate: async args => { calls++; entered.resolve(); await release.promise; return offlineDelegate(args) } })
  const body = { requestId: 'review-overlap', input: { mode: 'workspace' } }
  const first = review.prepare(body)
  await entered.promise
  const second = review.prepare(body)
  await assert.rejects(review.prepare({ requestId: body.requestId, input: { mode: 'commit', commit: 'f'.repeat(40) } }),
    { code: 'REQUEST_ID_CONFLICT' })
  const task = (await f.store.list())[0]
  let cancelled = false
  const cancellation = review.cancel(task.id, 'cancel-overlap').then(result => { cancelled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(cancelled, false)
  release.resolve()
  assert.equal((await first).preparation.id, (await second).preparation.id)
  assert.equal((await cancellation).status, 'cancelled')
  assert.equal(calls, 1)
})

test('unconfirmed process termination remains blocking across restart and cannot be reported cancelled', async t => {
  const f = await fixture(t)
  const review = await coordinator(f, { delegate: async () => {
    throw Object.assign(Error('private process details'), { code: 'termination_unconfirmed' })
  } })
  const body = { requestId: 'review-unconfirmed', input: { mode: 'workspace' } }
  await assert.rejects(review.prepare(body), { code: 'REVIEW_TERMINATION_UNCONFIRMED' })
  const task = (await f.store.list())[0]
  assert.equal(task.reviewCleanupPending, true)
  const restarted = await coordinator(f)
  await assert.rejects(restarted.cancel(task.id, 'cancel-unconfirmed'), { code: 'REVIEW_CLEANUP_UNCONFIRMED' })
  await assert.rejects(restarted.prepare(body), { code: 'REVIEW_CLEANUP_UNCONFIRMED' })
  assert.equal((await f.store.get(task.id)).status, 'queued')
  assert.ok(!JSON.stringify(await f.store.get(task.id)).includes('private process details'))
})

test('sensitive paths never persist text even if the injected delegate includes them', async t => {
  const f = await fixture(t), review = await coordinator(f)
  await writeFile(join(f.source.repository, '.env'), 'SYNTHETIC_SECRET_MARKER=placeholder\n')
  const result = await review.prepare({ requestId: 'review-sensitive', input: { mode: 'workspace' } })
  const entry = result.preparation.input.entries.find(item => item.new?.path === '.env')
  const coverage = result.preparation.coverage.find(item => item.path === '.env')
  assert.equal(coverage.status, 'excluded')
  assert.equal(coverage.ocrExcludeReason, 'secret_exclude')
  assert.equal(entry.new.content, null); assert.equal(entry.diff, null)
  const location = await f.store.location()
  const bytes = await readFile(join(f.store.dataHome, 'managed-reviews-v1', location.projectId, result.task.id, 'prepared.json'), 'utf8')
  assert.ok(!bytes.includes('SYNTHETIC_SECRET_MARKER'))
  assert.ok(!result.preparation.groups.some(group => group.files.includes('.env')))
})

test('actual CLI omissions for untracked provider paths remain explicit and sensitive files are redacted',
  { skip: !process.env.ITEROOM_OCR_BIN }, async t => {
    const f = await fixture(t)
    await writeFile(join(f.source.repository, 'vendor/untracked.ts'), 'export const providerMarker = true\n')
    await writeFile(join(f.source.repository, '.env'), 'SYNTHETIC_SECRET_MARKER=placeholder\n')
    const { ManagedReviewCoordinator } = await import('../src/host/managed-review-coordinator.js')
    const review = new ManagedReviewCoordinator(f.store)
    const result = await review.prepare({ requestId: 'actual-exclusions', input: { mode: 'workspace' } })
    assert.equal(result.preparation.coverage.length, 9)
    for (const path of ['vendor/untracked.ts', '.env']) {
      assert.equal(result.preparation.coverage.find(item => item.path === path).status, 'excluded')
      assert.equal(result.preparation.input.entries.find(item => item.new?.path === path).diff, null)
    }
    assert.equal(result.preparation.coverage.find(item => item.path === 'vendor/untracked.ts').includedBy,
      'iteroom-provider-exclusion')
    assert.ok(!JSON.stringify(result.preparation).includes('SYNTHETIC_SECRET_MARKER'))
    await review.cancel(result.task.id, 'cancel-exclusions')
  })

test('actual fixed OCR product preparation covers workspace, commit and range without changing source',
  { skip: !process.env.ITEROOM_OCR_BIN }, async t => {
    const f = await fixture(t)
    const { ManagedReviewCoordinator } = await import('../src/host/managed-review-coordinator.js')
    const review = new ManagedReviewCoordinator(f.store)
    const check = async (requestId, input) => {
      const before = await git(f.source, ['status', '--porcelain=v1', '-z'])
      const head = await git(f.source, ['rev-parse', 'HEAD'])
      const index = await readFile(join(f.source.repository, '.git/index'))
      const result = await review.prepare({ requestId, input })
      assert.equal(result.preparation.ocr.actualCli, true)
      assert.equal(result.preparation.coverage.length, 7)
      const { buildReviewPlan } = await import('../src/host/review/inference-plan.js')
      assert.ok(buildReviewPlan(result.preparation).groups.length > 0, 'actual OCR rules must fit at least one bounded group')
      assert.equal(result.preparation.coverage.find(item => item.path === 'test/greet.test.ts').status, 'pending_inference')
      assert.equal(result.preparation.coverage.find(item => item.path === 'src/gone.ts').ocrExcludeReason, 'deleted')
      assert.equal(result.preparation.coverage.find(item => item.path === 'src/renamed.ts').oldPath, 'src/original.ts')
      const reordered = await review.prepare({ requestId, input: Object.fromEntries(Object.entries(input).reverse()) })
      assert.equal(reordered.created, false)
      assert.equal(reordered.preparation.id, result.preparation.id)
      assert.equal(await git(f.source, ['status', '--porcelain=v1', '-z']), before)
      assert.equal(await git(f.source, ['rev-parse', 'HEAD']), head)
      assert.deepEqual(await readFile(join(f.source.repository, '.git/index')), index)
      await review.cancel(result.task.id, `cancel-${requestId}`)
    }
    await check('actual-workspace', { mode: 'workspace' })
    await git(f.source, ['add', '--all']); await git(f.source, ['commit', '--quiet', '-m', 'synthetic changes'])
    const commit = (await git(f.source, ['rev-parse', 'HEAD'])).trim()
    await check('actual-commit', { mode: 'commit', commit })
    await check('actual-range', { mode: 'range', from: f.source.base, to: commit })
  })
