import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { verifyExecutable } from '../../src/host/review/ocr-cli.js'
import { ManagedReviewInference } from '../../src/host/managed-review-inference.js'
import { runManagedReview } from '../../src/host/managed-review-runner.js'
import { readManagedSnapshotFile } from '../../src/host/managed-snapshot.js'
import { saveManagedArtifact } from '../../src/host/managed-artifact.js'

const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const hash = value => createHash('sha256').update(value).digest('hex')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = process.env.ITEROOM_PLAYWRIGHT_CLI
assert.ok(isAbsolute(cli ?? ''), 'external playwright-cli.js required')
await verifyExecutable(process.env.ITEROOM_OCR_BIN)
const root = await mkdtemp(join(tmpdir(), 'iteroom-r4-fix-browser-'))
const project = join(root, 'project'), home = join(root, 'harness')
const sourcePath = 'src/divide.mjs', testPath = 'src/divide.test.mjs'
const baseline = 'export const divide = value => value\n'
const bad = 'export const divide = value => value / 0\n'
const fixed = 'export const divide = value => value / 2\n'
const git = args => exec('git', args, { cwd: project, windowsHide: true })
const store = new ManagedTaskStore(join(home, 'iteroom'), project)
const session = `iteroom-r4-fix-${randomUUID().slice(0, 8)}`
const call = async args => {
  const result = await exec(process.execPath, [cli, '--session', session, ...args], { cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 })
  if (/### Error/.test(result.stdout)) throw Error(`Browser assertion failed: ${result.stdout.slice(-2500)}`)
  return result.stdout
}
let child, review
try {
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(project, sourcePath), baseline)
  await writeFile(join(project, testPath), 'import assert from "node:assert/strict"\nimport { divide } from "./divide.mjs"\nassert.equal(divide(4), 2)\n')
  await git(['init', '-q']); await git(['add', '.'])
  await git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic baseline'])
  await writeFile(join(project, sourcePath), bad)
  const originalHead = (await git(['rev-parse', 'HEAD'])).stdout
  const originalIndex = await readFile(join(project, '.git/index'))
  child = spawn(process.execPath, [join(repo, 'bin/iteroom.mjs'), project, '--no-open'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ITEROOM_DSH_HOME: home, ITEROOM_DATA_HOME: store.dataHome, DEEPSEEK_API_KEY: 'synthetic-browser-placeholder', DSH_TELEMETRY_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } })
  const url = await new Promise((ready, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(Error('Web startup timeout')), 60000)
    const receive = chunk => {
      output = (output + chunk.toString()).slice(-12000)
      const found = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (found) { clearTimeout(timer); ready(found[1]) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('exit', () => { clearTimeout(timer); reject(Error('Web exited before ready')) })
  })
  await call(['open', url]); await call(['resize', '390', '844'])
  await call(['run-code', `async (page) => {
    const intro = page.getByRole('dialog', { name: '内测声明' });
    if (await intro.isVisible()) await intro.getByRole('button', { name: '继续' }).click();
    await page.getByRole('button', { name: '变更审查', exact: true }).click();
    await page.getByRole('button', { name: '固定输入', exact: true }).click();
    await page.getByText('已固定 · 尚未推理', { exact: true }).waitFor({ timeout: 35000 });
  }`])
  const original = (await store.list()).find(task => task.kind === 'review')
  review = new ManagedReviewInference(store, { modelKey: async () => 'synthetic-only', run: args => runManagedReview({ ...args, provider: 'iteroom-r4-mock', model: 'synthetic', timeoutMs: 20000,
    mockAdapterPath: fileURLToPath(new URL('../../test/fixtures/managed-review-model.mjs', import.meta.url)) }) })
  await review.start(original.id, 'original-synthetic-review'); await review.whenIdle(original.id)
  const originalReport = await review.result(original.id)
  assert.equal(originalReport.findings.length, 1)
  await call(['run-code', `async (page) => {
    await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).click();
    if (!await page.getByRole('button', { name: '创建修复任务', exact: true }).isDisabled()) throw Error('test scope should be required');
    await page.getByRole('textbox', { name: '修复目标', exact: true }).fill('Synthetic repair: divisor two');
    await page.getByRole('textbox', { name: '已有测试文件（每行一个）', exact: true }).fill('${testPath}');
    await page.getByRole('button', { name: '创建修复任务', exact: true }).click();
    await page.getByRole('heading', { name: '隔离修改', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Synthetic repair: divisor two', exact: true }).waitFor();
    await page.getByRole('button', { name: '查看原审查', exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('repair viewport overflow');
  }`])
  const task = (await store.list()).find(task => task.kind === 'modify')
  assert.equal(task.reviewOrigin.reviewTaskId, original.id)
  assert.equal((await readManagedSnapshotFile(store, task.id, sourcePath)).text, bad)
  assert.equal(await readFile(join(project, sourcePath), 'utf8'), bad)
  await call(['run-code', `async (page) => {
    await page.reload();
    await page.getByRole('button', { name: '隔离修改', exact: true }).click();
    await page.getByRole('heading', { name: 'Synthetic repair: divisor two', exact: true }).waitFor();
    await page.getByRole('button', { name: '查看原审查', exact: true }).click();
    await page.getByRole('heading', { name: '变更审查', exact: true }).waitFor();
    await page.getByRole('button', { name: '删除审查记录', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '仍被修复或复查任务引用' }).waitFor();
    await page.getByRole('button', { name: '隔离修改', exact: true }).click();
  }`])
  // This is an injected synthetic execution receipt, not an actual sandbox or test result.
  await store.claimModify(task.id, 'synthetic-modify-start')
  await store.recordSandbox(task.id, 'synthetic-sandbox-12345')
  await store.recordExecutionStart(task.id, { id: 'synthetic-exec-12345', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'synthetic-exec-12345', { status: 'completed', exitCode: 0, outputBytes: 2, outputSha256: hash('ok') })
  await store.markSandboxCleaned(task.id)
  const patch = `diff --git a/${sourcePath} b/${sourcePath}\n--- a/${sourcePath}\n+++ b/${sourcePath}\n@@ -1,1 +1,1 @@\n-${bad}+${fixed}`
  const artifact = await saveManagedArtifact(store, task.id, { version: 1, taskId: task.id, snapshotId: task.snapshotId,
    changes: [{ path: sourcePath, kind: 'modified', beforeSha256: hash(bad), afterSha256: hash(fixed), beforeBytes: Buffer.byteLength(bad), afterBytes: Buffer.byteLength(fixed) }], patch, sha256: hash(patch) })
  await store.finishModify(task.id, { artifactId: artifact.id, changeCount: 1, verificationId: 'synthetic-exec-12345' })
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: '接受并写回本地文件', exact: true }).click();
    await page.getByRole('button', { name: '固定修复后输入复查', exact: true }).waitFor();
    await page.getByRole('button', { name: '固定修复后输入复查', exact: true }).click();
    await page.getByRole('heading', { name: '变更审查', exact: true }).waitFor();
    await page.getByText('已固定 · 尚未推理', { exact: true }).first().waitFor({ timeout: 35000 });
    await page.getByText(/修复后新输入 · 关联修改任务/).waitFor();
  }`])
  assert.equal(await readFile(join(project, sourcePath), 'utf8'), fixed)
  const fresh = (await store.list()).find(item => item.recheckOrigin?.modifyTaskId === task.id)
  assert.ok(fresh); assert.notEqual(fresh.reviewSnapshotId, original.reviewSnapshotId); assert.equal(fresh.reviewReportId, undefined)
  await review.start(fresh.id, 'fresh-synthetic-review'); await review.whenIdle(fresh.id)
  const report = await review.result(fresh.id)
  assert.equal(report.findings.length, 0); assert.equal(report.outcome, 'completed')
  await call(['run-code', `async (page) => {
    await page.getByText('本次没有有效候选发现，请结合覆盖清单和执行状态判断范围。', { exact: true }).waitFor();
  }`])
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: '隔离修改', exact: true }).click();
    await page.getByRole('button', { name: '查看原审查', exact: true }).click();
    await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).waitFor();
    await page.locator('[data-iteroom-managed-review] aside button').first().click();
    await page.getByText(/修复后新输入 · 关联修改任务/).waitFor();
    await page.getByText('本次没有有效候选发现，请结合覆盖清单和执行状态判断范围。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '隔离修改', exact: true }).click();
    await page.getByRole('button', { name: '查看原审查', exact: true }).click();
    await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).waitFor();
    await page.locator('[data-iteroom-managed-review] aside button').first().click();
    await page.getByText('本次没有有效候选发现，请结合覆盖清单和执行状态判断范围。', { exact: true }).waitFor();
  }`])
  await call(['run-code', `async (page) => {
    await page.reload();
    await page.getByRole('button', { name: '变更审查', exact: true }).click();
    await page.getByText(/修复后新输入 · 关联修改任务/).waitFor();
    await page.getByText('本次没有有效候选发现，请结合覆盖清单和执行状态判断范围。', { exact: true }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('recheck viewport overflow');
  }`])
  assert.equal((await git(['rev-parse', 'HEAD'])).stdout, originalHead)
  assert.deepEqual(await readFile(join(project, '.git/index')), originalIndex)
  process.stdout.write(JSON.stringify({ version: 1, evidence: 'actual-browser-and-OCR-DSH-CLI-local-mock', viewport: '390x844', externalModelRequests: 0,
    originalDshLoop: true, actualOcr: true, reviewPasses: 2, actualSandboxExecuted: false, modifyReceipt: 'injected-synthetic',
    fixCreatedViaUi: true, testScopeRequired: true, fixedRepairSnapshot: true, modelStartButtonsNotClicked: true,
    provenanceAfterReload: true, parentDeletionBlocked: true, userAcceptedViaUi: true, freshInputPreparedViaUi: true,
    freshReceiptAfterReload: true, repeatedSameTargetNavigation: true, oldFindings: originalReport.findings.length, freshFindings: report.findings.length,
    zeroFindingsIsNotTestProof: true, noViewportOverflow: true, syntheticSourceChangedOnlyAfterAcceptance: true, sourceHeadIndexUnchanged: true }) + '\n')
} finally {
  await review?.dispose()
  await call(['close']).catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(done => child.once('exit', done)), delay(5000)])
    if (child.exitCode === null && child.signalCode === null && child.pid) await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  const actual = await realpath(root), offset = relative(await realpath(tmpdir()), actual)
  assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  await rm(actual, { recursive: true, force: true })
}
