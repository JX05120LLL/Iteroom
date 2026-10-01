import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { SandboxManager } from '@alibaba-group/opensandbox'
import { createOwnedService } from '../r0/sandbox-service.mjs'
import { inspectSandboxPreflight } from '../r0/sandbox-preflight.mjs'
import { git } from '../../src/host/review/git.js'
import { verifyExecutable } from '../../src/host/review/ocr-cli.js'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { loadManagedModelKey } from '../../src/host/managed-model-key.js'
import { readManagedArtifact } from '../../src/host/managed-artifact.js'
import { readReviewPreparation } from '../../src/host/managed-review-snapshot.js'
import { readReviewResult } from '../../src/host/managed-review-result.js'
import { completionFixture, SOURCE, TEST } from './completion-fixture.mjs'
import { finalizeCompletion } from './completion-cleanup.mjs'

assert.equal(process.env.ITEROOM_R4_LIVE_BROWSER, '1', 'New explicit real model authorization required')
const cli = process.env.ITEROOM_PLAYWRIGHT_CLI
assert.ok(isAbsolute(cli ?? ''), 'External Playwright CLI required')
const receipt = process.env.ITEROOM_R4_AUTHORIZATION_FILE
assert.equal(dirname(resolve(receipt ?? '.')), resolve(tmpdir()), 'Authorization receipt must be directly outside the project')
const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const docker = args => execFileSync('docker', ['-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim()
const resources = () => ({ containers: docker(['ps', '-aq', '--no-trunc']).split('\n').filter(Boolean).sort(), volumes: docker(['volume', 'ls', '-q']).split('\n').filter(Boolean).sort() })
const preflight = await inspectSandboxPreflight(process.env.ITEROOM_SANDBOX_POC_ROOT)
assert.equal(preflight.status, 'ready_for_poc')
await verifyExecutable(process.env.ITEROOM_OCR_BIN)
const pocRoot = process.env.ITEROOM_SANDBOX_POC_ROOT
const image = JSON.parse(await readFile(join(pocRoot, 'images.json'), 'utf8'))['node:24-bookworm-slim'].digest
assert.ok(docker(['image', 'inspect', image, '--format', '{{json .RepoDigests}}']).includes(image))
const root = await mkdtemp(join(tmpdir(), 'iteroom-r4-live-browser-')), home = join(root, 'harness')
const service = await createOwnedService(pocRoot), beforeResources = resources()
const browserSession = `iteroom-r4-live-${randomUUID().slice(0, 8)}`
const report = { version: 1, generatedAt: new Date().toISOString(), evidence: 'actual-production-UI-DeepSeek-DSH-OCR-OpenSandbox', viewport: '390x844',
  environment: { platform: process.platform, node: process.version, docker: preflight.dockerVersion, dsh: '0.1.5-rc.3', ocr: 'v1.12.9',
    sdk: '1.1.0', server: preflight.serverConfiguration.version, image },
  authorization: { maxRequests: 12, maxOutputTokens: 512, maxCostCny: 5, plannedUpperCostCny: 1.818624,
    priceSource: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', providerBillVerified: false },
  originalDshLoop: true, localMockModel: false, injectedModifyReceipt: false, syntheticInputOnly: true, userSourceTransmitted: false,
  reviews: [], phase: 'fixture', success: false }
let child, store, failure, cleanupFailure
const call = async args => {
  const result = await exec(process.execPath, [cli, '--session', browserSession, ...args], { cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 1048576 })
  if (/### Error/.test(result.stdout)) throw Object.assign(Error('Browser action failed'), { code: 'BROWSER_ACTION_FAILED' })
  return result.stdout
}
const journal = async taskId => {
  try { return JSON.parse(await readFile(join(store.dataHome, 'managed-engine-v1', taskId, 'model-attempts.json'), 'utf8')).attempts }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error }
}
const count = async () => {
  let total = 0
  for (const task of await store.list()) total += await journal(task.id)
  return total
}
const waitTask = async (predicate, terminal = false) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const task = (await store.list()).find(predicate)
    if (task && (!terminal || ['completed', 'awaiting_review', 'failed', 'interrupted', 'cancelled'].includes(task.status))) return task
    await delay(250)
  }
  throw Object.assign(Error('Task timeout'), { code: 'PROBE_TASK_TIMEOUT' })
}
const reviewReceipt = async task => {
  const preparation = await readReviewPreparation(store, task.id), result = await readReviewResult(store, task.id)
  report.reviews.push({ status: task.status, outcome: result.outcome, failureCode: task.failureCode ?? null,
    preparationId: preparation.id, reportId: result.id, requestsReserved: await journal(task.id),
    preparationCoverage: preparation.coverage, coverage: result.coverage,
    findings: result.findings.map(({ path, side, quote, message, severity, location, startLine, endLine }) => ({ path, side, quote, message, severity, location, startLine, endLine })), noTestsExecuted: true })
  assert.equal(task.status, 'completed', task.failureCode ?? 'Review incomplete')
  assert.equal(result.outcome, 'completed')
  return { preparation, result }
}
try {
  const source = await completionFixture(root)
  store = new ManagedTaskStore(join(home, 'iteroom'), source.repository)
  const modelKey = await loadManagedModelKey(source.repository)
  assert.ok(modelKey, 'External model configuration required')
  // Fail closed on duplicate attempts, before any service/model start. Keep this receipt after cleanup.
  await writeFile(receipt, JSON.stringify({ version: 1, generatedAt: report.generatedAt, maxRequests: 12, maxOutputTokens: 512,
    maxCostCny: 5, stages: ['review', 'modify', 'recheck'], reservedForOneAttempt: true }), { flag: 'wx', mode: 0o600 })
  const state = async () => ({ head: (await git(source, ['rev-parse', 'HEAD'])).trim(), index: hash(await readFile(join(source.repository, '.git/index'))),
    status: await git(source, ['status', '--porcelain=v1', '-z']), source: hash(await readFile(join(source.repository, SOURCE))), tests: hash(await readFile(join(source.repository, TEST))) })
  const original = await state()
  await service.start()
  child = spawn(process.execPath, [join(repository, 'bin/iteroom.mjs'), source.repository, '--no-open'], { cwd: repository, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ITEROOM_DSH_HOME: home, ITEROOM_DATA_HOME: store.dataHome, DEEPSEEK_API_KEY: modelKey,
      ITEROOM_SANDBOX_KEY_FILE: join(pocRoot, 'r0-key'), ITEROOM_SANDBOX_IMAGE: image, DSH_TELEMETRY_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } })
  const url = await new Promise((ready, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(Object.assign(Error('Web startup timeout'), { code: 'WEB_START_TIMEOUT' })), 60000)
    const receive = data => {
      output = (output + data.toString()).slice(-12000)
      const found = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (found) { clearTimeout(timer); ready(found[1]) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('exit', () => { clearTimeout(timer); reject(Object.assign(Error('Web exited'), { code: 'WEB_START_FAILED' })) })
  })
  await call(['open', url]); await call(['resize', '390', '844'])
  report.phase = 'original-review'
  await call(['run-code', `async (page) => {
    const intro = page.getByRole('dialog', { name: '内测声明' });
    await intro.waitFor();
    await intro.getByRole('button', { name: '继续' }).click();
    await intro.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '变更审查', exact: true }).click();
    await page.getByRole('button', { name: '固定输入', exact: true }).click();
    await page.getByText('已固定 · 尚未推理', { exact: true }).waitFor({ timeout: 35000 });
    await page.getByRole('button', { name: '开始审查', exact: true }).click();
  }`])
  const originalTask = await waitTask(task => task.kind === 'review', true)
  const originalReview = await reviewReceipt(originalTask)
  assert.deepEqual(await state(), original)
  const finding = originalReview.result.findings.find(item => item.sourcePath === SOURCE && item.side === 'new' && item.location === 'located')
  assert.ok(finding, 'The real model must produce a located candidate; no mock fallback')
  report.phase = 'linked-fix'
  await call(['run-code', `async (page) => {
    await page.getByRole('button').filter({ hasText: ${JSON.stringify(finding.message)} }).click();
    await page.getByRole('textbox', { name: '修复目标', exact: true }).fill('Change divide to divide its input by 2 rather than 0. Read source and test first; batch both reads if possible. Change only the source, run the selected test, and keep the final answer short.');
    await page.getByRole('textbox', { name: '已有测试文件（每行一个）', exact: true }).fill('${TEST}');
    await page.getByRole('button', { name: '创建修复任务', exact: true }).click();
    await page.getByRole('heading', { name: '隔离修改', exact: true }).waitFor();
    await page.getByRole('button', { name: '固定输入并在沙箱执行', exact: true }).click();
  }`])
  const candidate = await waitTask(task => task.kind === 'modify', true)
  report.modify = { status: candidate.status, failureCode: candidate.failureCode ?? null, sandboxStatus: candidate.sandboxStatus,
    requestsReserved: await journal(candidate.id), executions: candidate.executions.map(({ kind, command, cwd, status, exitCode, outputSha256 }) => ({ kind, command, cwd, status, exitCode, outputSha256 })) }
  assert.equal(candidate.status, 'awaiting_review', candidate.failureCode ?? 'No candidate')
  assert.equal(candidate.executions.at(-1).exitCode, 0)
  assert.equal(candidate.sandboxStatus, 'cleaned')
  assert.deepEqual(await state(), original)
  const artifact = await readManagedArtifact(store, candidate.id, candidate.artifactId)
  assert.deepEqual(artifact.changes.map(item => item.path), [SOURCE])
  execFileSync('git', ['apply', '--check', '-'], { cwd: source.repository, input: artifact.patch, windowsHide: true })
  const manager = SandboxManager.create({ connectionConfig: { domain: '127.0.0.1:3088', protocol: 'http',
    apiKey: (await readFile(join(pocRoot, 'r0-key'), 'utf8')).trim(), useServerProxy: true, disableMetrics: true } })
  try { await assert.rejects(manager.getSandboxInfo(candidate.sandboxId), error => error.statusCode === 404) }
  finally { await manager.close() }
  report.phase = 'acceptance'
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: '接受并写回本地文件', exact: true }).click();
    await page.getByRole('button', { name: '固定修复后输入复查', exact: true }).waitFor();
    await page.getByRole('button', { name: '固定修复后输入复查', exact: true }).click();
    await page.getByText('已固定 · 尚未推理', { exact: true }).waitFor({ timeout: 35000 });
    await page.getByText(/修复后新输入 · 关联修改任务/).waitFor();
  }`])
  const accepted = await store.get(candidate.id), after = await state()
  assert.equal(accepted.status, 'completed'); assert.equal(accepted.acceptance.mode, 'accept')
  assert.equal(after.source, artifact.changes[0].afterSha256)
  assert.equal(after.head, original.head); assert.equal(after.index, original.index); assert.equal(after.tests, original.tests)
  const freshTask = await waitTask(task => task.recheckOrigin?.modifyTaskId === candidate.id)
  assert.equal(freshTask.reviewReportId, undefined)
  assert.notEqual(freshTask.reviewSnapshotId, originalTask.reviewSnapshotId)
  report.phase = 'fresh-review'
  await call(['run-code', `async (page) => { await page.getByRole('button', { name: '开始审查', exact: true }).click(); }`])
  const fresh = await waitTask(task => task.id === freshTask.id, true), freshReview = await reviewReceipt(fresh)
  assert.notEqual(freshReview.result.id, originalReview.result.id)
  assert.ok(!freshReview.result.findings.some(item => item.sourcePath === SOURCE && item.side === 'new' && item.quote.includes('/ 0')))
  await call(['run-code', `async (page) => {
    await page.reload();
    await page.getByRole('button', { name: '变更审查', exact: true }).click();
    await page.getByText(/修复后新输入 · 关联修改任务/).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Viewport overflow');
  }`])
  report.acceptance = { sourceChangedOnlyAfterExplicitUiAccept: true, headIndexAndTestsUnchanged: true, patchApplicable: true,
    artifactSha256: artifact.sha256, provenanceRetained: accepted.reviewOrigin.reportId === originalReview.result.id }
  report.recheck = { newPreparationAndReport: true, sourceMatchesAcceptedArtifact: true, relatesToAcceptedModify: true,
    oldCandidateNotReported: true, zeroFindingsIsNotTestProof: true, findings: freshReview.result.findings.length }
  report.browser = { actualProductionStartButtons: true, fixCreatedViaUi: true, userAcceptedViaUi: true,
    recheckPreparedAndStartedViaUi: true, receiptAfterReload: true, noViewportOverflow: true }
  assert.deepEqual(await state(), after)
  const totalBeforeRestart = await count()
  await call(['close'])
  child.kill('SIGTERM')
  await Promise.race([new Promise(done => child.once('exit', done)), delay(5000)])
  assert.ok(child.exitCode !== null || child.signalCode !== null)
  const { ManagedReviewInference } = await import('../../src/host/managed-review-inference.js')
  const reopened = new ManagedReviewInference(new ManagedTaskStore(store.dataHome, source.repository), { run: () => { throw Error('Replay forbidden') } })
  await reopened.initialize()
  assert.equal((await reopened.result(fresh.id)).id, freshReview.result.id)
  assert.equal(await count(), totalBeforeRestart)
  report.restart = { sameReceipt: true, noReplay: true }
  report.success = true
} catch (error) {
  failure = error
  report.errorCode = /^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(error?.code ?? '') ? error.code : 'PROBE_FAILED'
  const redact = value => String(value ?? '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/token=[^\s)"\\]+/g, 'token=[redacted]').replaceAll(root, '<fixture>').replaceAll(cli, '<playwright-cli>')
  report.diagnostic = { name: error.name, message: redact(error.message).slice(0, 1800), stdoutTail: redact(error.stdout).slice(-2000) }
  if (error.code === 'ERR_ASSERTION') report.assertion = { actual: typeof error.actual === 'string' ? error.actual : null, expected: typeof error.expected === 'string' ? error.expected : null }
} finally {
  const settled = await finalizeCompletion({
    stopExecution: async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await Promise.race([new Promise(done => child.once('exit', done)), delay(5000)])
        if (child.exitCode === null && child.signalCode === null) await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        assert.ok(child.exitCode !== null || child.signalCode !== null)
      }
      await call(['close']).catch(() => {})
    }, readRequests: async () => store ? count() : 0,
    reconcile: async () => {
      const tasks = store ? await store.list() : []
      if (tasks.some(task => task.sandboxAllocationPending || ['allocated', 'cleanup_pending'].includes(task.sandboxStatus))) {
        throw Object.assign(Error('Owned sandbox unresolved'), { code: 'SANDBOX_CLEANUP_UNCONFIRMED' })
      }
    }, stopService: () => service.stop(),
  })
  cleanupFailure = settled.cleanupError ? /^[A-Z][A-Z0-9_]{1,79}$/.test(settled.cleanupError.code ?? '') ? settled.cleanupError.code : 'PROBE_CLEANUP_UNCONFIRMED' : null
  report.externalModelRequestsReserved = settled.requestsReserved
  if (settled.requestsReserved !== null && settled.requestsReserved > 12) cleanupFailure ??= 'PROBE_REQUEST_LIMIT'
  const afterResources = resources()
  report.cleanup = { serviceStopped: !service.running, confirmed: !cleanupFailure,
    containersUnchanged: JSON.stringify(beforeResources.containers) === JSON.stringify(afterResources.containers),
    volumesUnchanged: JSON.stringify(beforeResources.volumes) === JSON.stringify(afterResources.volumes),
    beforeContainers: beforeResources.containers.length, afterContainers: afterResources.containers.length,
    beforeVolumes: beforeResources.volumes.length, afterVolumes: afterResources.volumes.length, ...(cleanupFailure ? { errorCode: cleanupFailure } : {}) }
  report.success &&= !cleanupFailure && report.cleanup.containersUnchanged && report.cleanup.volumesUnchanged
  if (!cleanupFailure) {
    const actual = await realpath(root), offset = relative(await realpath(tmpdir()), actual)
    assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
    await rm(actual, { recursive: true, force: true })
  }
  process.stdout.write(JSON.stringify(report) + '\n')
}
if (failure || !report.success) process.exitCode = 1
