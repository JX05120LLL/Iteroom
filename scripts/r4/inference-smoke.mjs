import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFixture, git } from '../r0/ocr-fixture.mjs'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { ManagedReviewCoordinator } from '../../src/host/managed-review-coordinator.js'
import { ManagedReviewInference } from '../../src/host/managed-review-inference.js'
import { runManagedReview } from '../../src/host/managed-review-runner.js'
import { verifyExecutable } from '../../src/host/review/ocr-cli.js'

await verifyExecutable(process.env.ITEROOM_OCR_BIN)
const root = await mkdtemp(join(tmpdir(), 'iteroom-r4-inference-smoke-'))
try {
  const source = await createFixture(root)
  await writeFile(join(source.repository, 'src/greet.ts'), 'export const divide = value => value / 0\n')
  const originalStatus = await git(source, ['status', '--porcelain=v1', '-z'])
  const originalIndex = await readFile(join(source.repository, '.git/index')), originalHead = await git(source, ['rev-parse', 'HEAD'])
  const store = new ManagedTaskStore(join(root, 'data'), source.repository), prep = new ManagedReviewCoordinator(store)
  const prepared = await prep.prepare({ requestId: 'synthetic-inference-smoke', input: { mode: 'workspace' } })
  const review = new ManagedReviewInference(store, { preparer: prep, modelKey: async () => 'synthetic-only',
    run: args => runManagedReview({ ...args, provider: 'iteroom-r4-mock', model: 'synthetic', timeoutMs: 20000,
      mockAdapterPath: fileURLToPath(new URL('../../test/fixtures/managed-review-model.mjs', import.meta.url)) }) })
  await review.start(prepared.task.id, 'synthetic-start')
  const task = await review.whenIdle(prepared.task.id), report = await review.result(task.id), plan = await review.plan(task.id)
  assert.equal(task.status, 'completed'); assert.equal(report.outcome, 'completed')
  assert.equal(report.findings.length, 1); assert.equal(report.findings[0].location, 'located'); assert.equal(report.findings[0].startLine, 1)
  const metrics = JSON.parse(await readFile(join(store.dataHome, 'managed-engine-v1', task.id, 'review-metrics.json'), 'utf8'))
  assert.deepEqual(metrics.roster, ['iteroom_review_context']); assert.equal(metrics.calls, 2)
  assert.equal(await git(source, ['status', '--porcelain=v1', '-z']), originalStatus)
  assert.equal(await git(source, ['rev-parse', 'HEAD']), originalHead)
  assert.deepEqual(await readFile(join(source.repository, '.git/index')), originalIndex)
  const reopened = new ManagedReviewInference(store, { run: () => { throw Error('replay forbidden') } })
  await reopened.initialize(); assert.equal((await reopened.result(task.id)).id, report.id)
  process.stdout.write(JSON.stringify({ version: 1, evidence: 'actual-fixed-OCR-and-DSH-CLI-local-mock-model',
    actualCli: true, originalDshLoop: true, externalModelRequests: 0, sandboxExecutions: 0,
    syntheticModelCalls: metrics.calls, roster: metrics.roster, budgets: plan.budgets,
    ruleBytes: prepared.preparation.groups.map(group => Buffer.byteLength(group.rule)),
    groupWireBytes: plan.groups.map(group => group.wireBytes), outcome: report.outcome,
    coverage: Object.fromEntries(['pending', 'completed', 'failed', 'excluded'].map(status => [status, report.coverage.filter(item => item.status === status).length])),
    candidateCount: report.findings.length, candidateLocatedByHost: true, candidateVerified: false,
    restartRetainsSameReceipt: true, sourceHeadIndexStatusUnchanged: true }) + '\n')
} finally {
  const actual = await realpath(root), offset = relative(await realpath(tmpdir()), actual)
  assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  await rm(actual, { recursive: true, force: true })
}
