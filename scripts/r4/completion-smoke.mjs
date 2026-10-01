import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SandboxManager } from '@alibaba-group/opensandbox'
import { createOwnedService } from '../r0/sandbox-service.mjs'
import { inspectSandboxPreflight } from '../r0/sandbox-preflight.mjs'
import { git } from '../../src/host/review/git.js'
import { verifyExecutable } from '../../src/host/review/ocr-cli.js'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { ManagedReviewCoordinator } from '../../src/host/managed-review-coordinator.js'
import { ManagedReviewInference } from '../../src/host/managed-review-inference.js'
import { ManagedReviewFix } from '../../src/host/managed-review-fix.js'
import { ManagedModifyCoordinator, reconcileManagedSandbox } from '../../src/host/managed-modify-coordinator.js'
import { ManagedAcceptance } from '../../src/host/managed-acceptance.js'
import { loadManagedModelKey } from '../../src/host/managed-model-key.js'
import { readManagedArtifact } from '../../src/host/managed-artifact.js'
import { openManagedSandbox, runManagedTest } from '../../src/host/managed-sandbox.js'
import { runManagedModify } from '../../src/host/managed-engine-runner.js'
import { runManagedReview } from '../../src/host/managed-review-runner.js'
import { completionFixture, SOURCE, TEST, BAD, FIXED } from './completion-fixture.mjs'
import { finalizeCompletion } from './completion-cleanup.mjs'

const mode = process.env.ITEROOM_R4_COMPLETION
assert.ok(['synthetic', 'live'].includes(mode), 'Set an explicit authorized completion mode')
const live = mode === 'live', sha = bytes => createHash('sha256').update(bytes).digest('hex')
const safeCode = error => /^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(error?.code ?? '') ? error.code : 'PROBE_ASSERTION_FAILED'
const docker = args => execFileSync('docker', ['-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args], { windowsHide: true, timeout: 10000, encoding: 'utf8' }).trim()
const resources = () => ({ containers: docker(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort(),
  volumes: docker(['volume', 'ls', '-q']).split('\n').filter(Boolean).sort() })
const preflight = await inspectSandboxPreflight(process.env.ITEROOM_SANDBOX_POC_ROOT)
assert.equal(preflight.status, 'ready_for_poc', 'Actual sandbox prerequisites required')
await verifyExecutable(process.env.ITEROOM_OCR_BIN)
const pocRoot = process.env.ITEROOM_SANDBOX_POC_ROOT
const images = JSON.parse(await readFile(join(pocRoot, 'images.json'), 'utf8'))
const image = images['node:24-bookworm-slim'].digest
assert.ok(/^node@sha256:[0-9a-f]{64}$/.test(image))
assert.ok(docker(['image', 'inspect', image, '--format', '{{json .RepoDigests}}']).includes(image))
const key = (await readFile(join(pocRoot, 'r0-key'), 'utf8')).trim()
const config = { image, key, connectionConfig: { domain: '127.0.0.1:3088', protocol: 'http', apiKey: key,
  useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 15 } }
const baselineResources = resources(), root = await mkdtemp(join(tmpdir(), 'iteroom-r4-completion-'))
const service = await createOwnedService(pocRoot)
const report = { version: 1, generatedAt: new Date().toISOString(), evidence: live ? 'real-DeepSeek-original-DSH-OCR-and-OpenSandbox' : 'local-mock-original-DSH-OCR-and-actual-OpenSandbox',
  environment: { platform: process.platform, node: process.version, docker: preflight.dockerVersion,
    sdk: '1.1.0', server: preflight.serverConfiguration.version, dsh: '0.1.5-rc.3', ocr: 'v1.12.9', image },
  syntheticInputOnly: true, userSourceTransmitted: false, externalModelRequestsReserved: 0,
  authorization: live ? { maxRequests: 12, maxOutputTokens: 512, maxCostCny: 5, plannedUpperCostCny: 1.818624,
    priceSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', providerBillVerified: false } : null,
  reviews: [], phase: 'fixture', success: false }
let store, prep, review, fix, modify, modifyId, failure, cleanupFailure
const journal = async taskId => {
  try { return JSON.parse(await readFile(join(store.dataHome, 'managed-engine-v1', taskId, 'model-attempts.json'), 'utf8')).attempts }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error }
}
const count = async () => {
  if (!store) return 0
  let total = 0
  for (const task of await store.list()) total += await journal(task.id)
  return total
}
try {
  const source = await completionFixture(root)
  store = new ManagedTaskStore(join(root, 'data'), source.repository)
  const modelKey = live ? await loadManagedModelKey(source.repository) : 'synthetic-only'
  assert.ok(modelKey, 'Project-external model configuration required')
  if (live) {
    // One attempt per approved receipt. Failure does not permit reusing the allowance.
    const receipt = process.env.ITEROOM_R4_AUTHORIZATION_FILE
    assert.ok(isAbsolute(receipt ?? '') && receipt.startsWith(tmpdir() + sep), 'External authorization receipt required')
    await writeFile(receipt, JSON.stringify({ version: 1, generatedAt: report.generatedAt, maxRequests: 12,
      maxOutputTokens: 512, maxCostCny: 5, stages: ['review', 'modify', 'recheck'], reservedForOneAttempt: true }), { flag: 'wx', mode: 0o600 })
  }
  const unchanged = async () => ({ head: (await git(source, ['rev-parse', 'HEAD'])).trim(),
    index: sha(await readFile(join(source.repository, '.git/index'))), status: await git(source, ['status', '--porcelain=v1', '-z']),
    source: sha(await readFile(join(source.repository, SOURCE))), tests: sha(await readFile(join(source.repository, TEST))) })
  const original = await unchanged()
  prep = new ManagedReviewCoordinator(store)
  review = new ManagedReviewInference(store, { preparer: prep, modelKey: async () => modelKey,
    ...(live ? {} : { run: args => runManagedReview({ ...args, provider: 'iteroom-r4-mock', model: 'synthetic', modelKey: undefined,
      mockAdapterPath: fileURLToPath(new URL('../../test/fixtures/managed-review-model.mjs', import.meta.url)) }) }) })
  fix = new ManagedReviewFix(store, { preparer: prep })
  const runReview = async (prepared, label) => {
    report.phase = label
    await review.start(prepared.task.id, `${label}-start`)
    const task = await review.whenIdle(prepared.task.id), result = await review.result(task.id)
    report.reviews.push({ label, mode: prepared.preparation.input.selection.mode, status: task.status,
      failureCode: task.failureCode ?? null, outcome: result.outcome, preparationId: prepared.preparation.id, reportId: result.id,
      requestsReserved: await journal(task.id), preparationCoverage: prepared.preparation.coverage, coverage: result.coverage,
      findings: result.findings.map(({ path, side, quote, message, severity, location, startLine, endLine }) =>
        ({ path, side, quote, message, severity, location, startLine, endLine })), noTestsExecuted: result.noTestsExecuted })
    assert.equal(task.status, 'completed', task.failureCode ?? 'Review did not complete')
    assert.equal(result.outcome, 'completed', 'All selected review context must complete')
    return result
  }
  const validateCoverage = prepared => {
    const items = prepared.preparation.coverage
    for (const path of [SOURCE, TEST, 'src/added.mjs', 'src/deleted.mjs', 'src/renamed.mjs']) {
      assert.ok(items.some(item => item.path === path && item.status === 'pending_inference'), `Missing ${path}`)
    }
    assert.equal(items.find(item => item.path === TEST).status, 'pending_inference')
    assert.equal(items.find(item => item.path === 'test/coverage.test.ts').includedBy, 'iteroom-test-include')
    assert.equal(items.find(item => item.path === 'src/deleted.mjs').side, 'old')
    assert.equal(items.find(item => item.path === 'src/renamed.mjs').oldPath, 'src/original.mjs')
    assert.equal(items.find(item => item.path === 'vendor/lib.mjs').status, 'excluded')
  }
  // Historical execution uses the original CLI/Loop, not just browser form checks.
  if (!live) for (const input of [{ mode: 'commit', commit: source.head }, { mode: 'range', from: source.base, to: source.head }]) {
    const prepared = await prep.prepare({ requestId: `historical-${input.mode}`, input })
    validateCoverage(prepared)
    const result = await runReview(prepared, `historical-${input.mode}`)
    assert.ok(result.findings.some(item => item.sourcePath === SOURCE && item.location === 'located'))
    assert.deepEqual(await unchanged(), original)
  }
  const prepared = await prep.prepare({ requestId: 'original-review', input: { mode: 'workspace' } })
  validateCoverage(prepared)
  const originalReport = await runReview(prepared, 'original-review')
  const finding = originalReport.findings.find(item => item.sourcePath === SOURCE && item.side === 'new' && item.location === 'located')
  assert.ok(finding, 'Real report must locate a source candidate; no fabricated fallback')
  assert.deepEqual(await unchanged(), original)
  const linked = await fix.create({ taskId: prepared.task.id, findingId: finding.id, requestId: 'linked-fix',
    objective: 'Fix divide to divide its input by 2 rather than 0. Read source and the selected existing test, change only the source, and run the selected test. Batch the two read calls if possible. Keep the final answer short.', testPaths: [TEST] })
  modifyId = linked.task.id
  assert.equal(linked.task.reviewOrigin.reportId, originalReport.id)
  report.phase = 'sandbox-modify'
  modify = new ManagedModifyCoordinator(store, { sandboxConfig: async () => config, modelKey: async () => modelKey,
    open: async args => {
      const session = await openManagedSandbox(args)
      try {
        const initial = await runManagedTest(session, [TEST])
        report.initialSandboxTest = { status: initial.status, exitCode: initial.exitCode }
        assert.equal(initial.exitCode, 1)
        return session
      } catch (error) { await session.cleanup(); throw error }
    }, ...(live ? {} : { run: args => runManagedModify({ ...args, provider: 'iteroom-r2-mock', model: 'synthetic', modelKey: undefined,
      mockAdapterPath: fileURLToPath(new URL('../../test/fixtures/managed-r4-modify-model.mjs', import.meta.url)) }) }) })
  await service.start()
  await modify.start(modifyId, 'linked-fix-start')
  const candidate = await modify.whenIdle(modifyId)
  report.modify = { status: candidate.status, failureCode: candidate.failureCode ?? null, sandboxStatus: candidate.sandboxStatus,
    requestsReserved: await journal(modifyId), executions: candidate.executions.map(({ kind, command, cwd, status, exitCode, outputSha256 }) =>
      ({ kind, command, cwd, status, exitCode, outputSha256 })) }
  assert.equal(candidate.status, 'awaiting_review', candidate.failureCode ?? 'No artifact')
  assert.equal(candidate.sandboxStatus, 'cleaned')
  assert.equal(candidate.executions.at(-1).exitCode, 0)
  assert.deepEqual(await unchanged(), original)
  const artifact = await readManagedArtifact(store, modifyId, candidate.artifactId)
  assert.deepEqual(artifact.changes.map(item => item.path), [SOURCE])
  execFileSync('git', ['apply', '--check', '-'], { cwd: source.repository, input: artifact.patch, windowsHide: true })
  const manager = SandboxManager.create({ connectionConfig: config.connectionConfig })
  try { await assert.rejects(manager.getSandboxInfo(candidate.sandboxId), error => error.statusCode === 404) }
  finally { await manager.close() }
  const acceptance = new ManagedAcceptance(store)
  const accepted = await acceptance.accept(modifyId, 'user-accept-synthetic-fixture')
  assert.equal(accepted.status, 'completed')
  const after = await unchanged()
  assert.equal(after.head, original.head); assert.equal(after.index, original.index); assert.equal(after.tests, original.tests)
  const acceptedSource = await readFile(join(source.repository, SOURCE), 'utf8')
  assert.notEqual(sha(acceptedSource), original.source)
  if (!live) assert.equal(acceptedSource, FIXED)
  report.acceptance = { status: accepted.status, mode: accepted.acceptance.mode, sourceChangedOnlyAfterExplicitAccept: true, headIndexAndTestsUnchanged: true,
    patchApplicable: true, artifactSha256: artifact.sha256 }
  const fresh = await fix.recheck({ taskId: modifyId, requestId: 'fresh-review' })
  assert.notEqual(fresh.preparation.id, prepared.preparation.id)
  assert.equal(fresh.task.recheckOrigin.modifyTaskId, modifyId)
  assert.equal(fresh.task.reviewReportId, undefined)
  const freshReport = await runReview(fresh, 'fresh-review')
  assert.notEqual(freshReport.id, originalReport.id)
  // This case has a real regression test. Zero review findings alone cannot prove repair.
  assert.ok(!freshReport.findings.some(item => item.sourcePath === SOURCE && item.side === 'new' && item.quote.includes('/ 0')), 'Original zero divisor candidate remains')
  const reopenedStore = new ManagedTaskStore(store.dataHome, source.repository)
  const reopened = new ManagedReviewInference(reopenedStore, { run: () => { throw Error('Replay forbidden') } })
  const requestsBeforeRestart = await count()
  await reopened.initialize()
  assert.equal((await reopened.result(fresh.task.id)).id, freshReport.id)
  assert.equal((await reopenedStore.get(modifyId)).reviewOrigin.findingId, finding.id)
  assert.equal(await count(), requestsBeforeRestart)
  assert.deepEqual(await unchanged(), after)
  report.sourceInput = { sourceSha256: sha(BAD), testIncluded: true, dirtyStagedUnstagedUntracked: true }
  report.freshInput = { differentPreparationAndReport: true, relatedToAcceptedArtifact: true, noOldReportReuse: true,
    zeroFindingsIsNotTestProof: true, originalCandidateNotReported: true }
  report.restart = { sameReceipt: true, relationshipsRetained: true, noReplay: true }
  report.success = true
} catch (error) {
  failure = error
  report.errorCode = safeCode(error)
  if (error.code === 'ERR_ASSERTION') report.assertion = { actual: typeof error.actual === 'string' ? error.actual : null, expected: typeof error.expected === 'string' ? error.expected : null }
} finally {
  const settled = await finalizeCompletion({
    stopExecution: async () => { await review?.dispose(); await fix?.dispose(); await modify?.dispose() },
    readRequests: count,
    reconcile: async () => {
      if (!modifyId) return
      const current = await store.get(modifyId)
      if (current.sandboxAllocationPending || ['allocated', 'cleanup_pending'].includes(current.sandboxStatus)) {
        if (!service.running) throw Object.assign(Error('Service unavailable for cleanup'), { code: 'SANDBOX_CLEANUP_UNCONFIRMED' })
        await reconcileManagedSandbox({ store, taskId: modifyId, config })
      }
    }, stopService: () => service.stop(),
  })
  cleanupFailure = settled.cleanupError
  report.externalModelRequestsReserved = settled.requestsReserved
  if (settled.requestsReserved !== null && settled.requestsReserved > (live ? 12 : 0)) cleanupFailure ??= Object.assign(Error('Request bound exceeded'), { code: 'PROBE_REQUEST_LIMIT' })
  const finalResources = resources()
  report.cleanup = { serviceStopped: !service.running, containersUnchanged: JSON.stringify(finalResources.containers) === JSON.stringify(baselineResources.containers),
    volumesUnchanged: JSON.stringify(finalResources.volumes) === JSON.stringify(baselineResources.volumes),
    beforeContainers: baselineResources.containers.length, afterContainers: finalResources.containers.length,
    beforeVolumes: baselineResources.volumes.length, afterVolumes: finalResources.volumes.length,
    confirmed: !cleanupFailure, ...(cleanupFailure ? { errorCode: safeCode(cleanupFailure) } : {}) }
  report.success &&= !cleanupFailure && report.cleanup.containersUnchanged && report.cleanup.volumesUnchanged
  if (!cleanupFailure) {
    const actual = await realpath(root), offset = relative(await realpath(tmpdir()), actual)
    assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
    await rm(actual, { recursive: true, force: true })
  }
  process.stdout.write(JSON.stringify(report) + '\n')
}
if (failure || !report.success) process.exitCode = 1
