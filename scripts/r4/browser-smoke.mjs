import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createFixture, git } from '../r0/ocr-fixture.mjs'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { verifyExecutable } from '../../src/host/review/ocr-cli.js'
import { ManagedReviewInference } from '../../src/host/managed-review-inference.js'
import { runManagedReview } from '../../src/host/managed-review-runner.js'
import { ManagedReviewCoordinator } from '../../src/host/managed-review-coordinator.js'

const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = process.env.ITEROOM_PLAYWRIGHT_CLI
assert.ok(isAbsolute(cli ?? ''), 'external playwright-cli.js required')
await verifyExecutable(process.env.ITEROOM_OCR_BIN)
const root = await mkdtemp(join(tmpdir(), 'iteroom-r0-r4-browser-'))
const source = await createFixture(root), home = join(root, 'harness')
await writeFile(join(source.repository, 'src/greet.ts'), 'export const divide = value => value / 0\n')
await git(source, ['add', 'src/greet.ts'])
const historicalTree = (await git(source, ['write-tree'])).trim()
const historicalCommit = (await git(source, ['commit-tree', historicalTree, '-p', (await git(source, ['rev-parse', 'HEAD'])).trim(), '-m', 'synthetic historical review'])).trim()
const store = new ManagedTaskStore(join(home, 'iteroom'), source.repository)
const originalStatus = await git(source, ['status', '--porcelain=v1', '-z'])
const originalIndex = await readFile(join(source.repository, '.git/index'))
const originalHead = await git(source, ['rev-parse', 'HEAD'])
const session = `iteroom-r4-${randomUUID().slice(0, 8)}`
const call = async args => {
  const result = await exec(process.execPath, [cli, '--session', session, ...args], {
    cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024,
  })
  if (/### Error/.test(result.stdout)) throw Error('Browser assertion failed')
  return result.stdout
}
let child
try {
  child = spawn(process.execPath, [join(repo, 'bin/iteroom.mjs'), source.repository, '--no-open'], {
    cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ITEROOM_DSH_HOME: home, ITEROOM_DATA_HOME: store.dataHome,
      DEEPSEEK_API_KEY: 'synthetic-browser-placeholder', DSH_TELEMETRY_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  })
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
  await call(['open', url])
  await call(['run-code', `async (page) => {
    const intro = page.getByRole('dialog', { name: '内测声明' });
    if (await intro.isVisible()) await intro.getByRole('button', { name: '继续' }).click();
    await page.getByText('变更审查', { exact: true }).first().click();
    await page.getByRole('button', { name: '固定输入' }).click();
    await page.getByText('已固定 · 尚未推理', { exact: true }).waitFor({ timeout: 35000 });
    await page.getByText('7 个变更 · 0 个已审 · 6 个待审 · 0 个失败 · 1 个排除', { exact: true }).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '开始审查' && !button.disabled));
    await page.getByRole('button', { name: 'test/greet.test.ts 待审', exact: true }).click();
    await page.getByText('测试文件：显式纳入 · 新侧内容', { exact: true }).waitFor();
  }`])
  await call(['resize', '390', '844'])
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: 'src/gone.ts 待审', exact: true }).click();
    await page.getByText('删除文件：采用旧侧内容 · 旧侧内容', { exact: true }).waitFor();
    if (!await page.locator('pre').filter({ hasText: '-export const obsolete' }).count()) throw Error('deleted Diff missing');
    await page.getByRole('button', { name: 'vendor/lib.ts 已排除', exact: true }).click();
    await page.getByText('此文件已排除，准备记录不保留它的正文或 Diff。', { exact: true }).waitFor();
    if (await page.locator('[data-iteroom-managed-review] pre').count()) throw Error('excluded plaintext');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('viewport overflow');
  }`])
  // Run the actual SDK CLI with a local mock adapter outside the browser. Never click the paid production start action.
  const task = (await store.list()).find(task => task.kind === 'review')
  const review = new ManagedReviewInference(store, { modelKey: async () => 'synthetic-only', run: args => runManagedReview({ ...args,
    provider: 'iteroom-r4-mock', model: 'synthetic', timeoutMs: 20000,
    mockAdapterPath: fileURLToPath(new URL('../../test/fixtures/managed-review-model.mjs', import.meta.url)) }) })
  await review.start(task.id, 'browser-local-mock')
  assert.equal((await review.whenIdle(task.id)).status, 'completed')
  await call(['run-code', `async (page) => {
    await page.getByText('审查完成', { exact: true }).first().waitFor({ timeout: 15000 });
    await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).click();
    await page.getByRole('heading', { name: '固定源码', exact: true }).waitFor();
    if (!await page.locator('pre').filter({ hasText: '1: export const divide = value => value / 0' }).count()) throw Error('fixed source location missing');
    if (!await page.getByRole('button', { name: '创建修复任务', exact: true }).isDisabled()) throw Error('linked fix needs explicit test selection');
    if (!await page.getByRole('button', { name: '开始审查', exact: true }).isDisabled()) throw Error('replay enabled');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('result viewport overflow');
  }`])
  if (process.env.ITEROOM_R4_SCREENSHOT) {
    assert.ok(isAbsolute(process.env.ITEROOM_R4_SCREENSHOT))
    await call(['run-code', `async (page) => { await page.screenshot({ path: ${JSON.stringify(process.env.ITEROOM_R4_SCREENSHOT)}, fullPage: true }); }`])
  }
  await call(['run-code', `async (page) => {
    await page.reload();
    await page.getByRole('button', { name: '变更审查', exact: true }).click();
    await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '删除审查记录' }).click();
    await page.getByRole('button', { name: '固定输入' }).waitFor({ state: 'visible' });
    await page.getByRole('radio', { name: '单提交', exact: true }).check();
    await page.getByRole('textbox', { name: '提交 SHA', exact: true }).waitFor();
    await page.getByRole('radio', { name: '提交范围', exact: true }).check();
    await page.getByRole('textbox', { name: '起点 SHA', exact: true }).waitFor();
    await page.getByRole('textbox', { name: '终点 SHA', exact: true }).waitFor();
  }`])
  for (const input of [{ mode: 'commit', commit: historicalCommit }, { mode: 'range', from: originalHead.trim(), to: historicalCommit }]) {
    await call(['run-code', `async (page) => {
      await page.getByRole('radio', { name: '${input.mode === 'commit' ? '单提交' : '提交范围'}', exact: true }).check();
      ${input.mode === 'commit'
        ? `await page.getByRole('textbox', { name: '提交 SHA', exact: true }).fill('${input.commit}');`
        : `await page.getByRole('textbox', { name: '起点 SHA', exact: true }).fill('${input.from}'); await page.getByRole('textbox', { name: '终点 SHA', exact: true }).fill('${input.to}');`}
      await page.getByRole('button', { name: '固定输入', exact: true }).click();
      await page.getByText('已固定 · 尚未推理', { exact: true }).waitFor({ timeout: 35000 });
    }`])
    const historical = (await store.list()).find(item => item.reviewInput?.mode === input.mode)
    await review.start(historical.id, `browser-${input.mode}-mock`)
    assert.equal((await review.whenIdle(historical.id)).reviewOutcome, 'completed')
    const historicalReport = await review.result(historical.id)
    assert.equal(historicalReport.coverage.filter(item => item.status === 'completed').length, 5)
    assert.equal(historicalReport.findings[0].location, 'located')
    await call(['run-code', `async (page) => {
      await page.getByText('审查完成', { exact: true }).first().waitFor({ timeout: 15000 });
      await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).click();
      await page.getByRole('heading', { name: '固定源码', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('button', { name: '变更审查', exact: true }).click();
      await page.getByRole('button').filter({ hasText: 'Synthetic candidate: division uses zero.' }).waitFor();
      await page.getByRole('button', { name: '删除审查记录', exact: true }).click();
    }`])
  }
  const oversized = join(source.repository, 'src/oversize.ts')
  await writeFile(oversized, `export const large = '${'synthetic'.repeat(2000)}'\n`)
  const preparer = new ManagedReviewCoordinator(store)
  const partial = await preparer.prepare({ requestId: 'browser-partial', input: { mode: 'workspace' } })
  await review.start(partial.task.id, 'browser-partial-start')
  assert.equal((await review.whenIdle(partial.task.id)).reviewOutcome, 'partial')
  await call(['run-code', `async (page) => {
    await page.getByText('部分完成', { exact: true }).first().waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'src/oversize.ts 待审', exact: true }).click();
    await page.getByText('完整文件上下文超过预算', { exact: true }).waitFor();
    await page.getByRole('button', { name: '删除审查记录' }).click();
  }`])
  await rm(oversized)
  const failed = await preparer.prepare({ requestId: 'browser-failed', input: { mode: 'workspace' } })
  const failing = new ManagedReviewInference(store, { modelKey: async () => 'synthetic-only', run: async args => {
    await args.onReady()
    return { sessionId: args.taskId, turnEnd: 'completed', readGroupIds: [1], answer: '{synthetic-bad-json' }
  } })
  await failing.start(failed.task.id, 'browser-failed-start')
  assert.equal((await failing.whenIdle(failed.task.id)).status, 'failed')
  await call(['run-code', `async (page) => {
    await page.getByText('审查失败', { exact: true }).first().waitFor({ timeout: 15000 });
    await page.getByText('模型响应不符合审查契约，未生成有效发现。', { exact: true }).waitFor();
    if (!await page.getByRole('button', { name: '开始审查', exact: true }).isDisabled()) throw Error('failed run replay enabled');
    await page.getByRole('button', { name: '删除审查记录' }).click();
  }`])
  for (let attempt = 0; attempt < 25 && (await store.list()).length; attempt++) await delay(200)
  assert.equal((await store.list()).length, 0)
  assert.equal(await git(source, ['status', '--porcelain=v1', '-z']), originalStatus)
  assert.equal(await git(source, ['rev-parse', 'HEAD']), originalHead)
  assert.deepEqual(await readFile(join(source.repository, '.git/index')), originalIndex)
  process.stdout.write(JSON.stringify({ browser: 'playwright-cli', viewport: '390x844', modelRequests: 0,
    actualCli: true, workspacePrepared: true, testIncluded: true, deletedOldDiff: true, providerRedacted: true,
    inferenceButtonEnabled: true, productionModelStartClicked: false, inferenceViaLocalMockCoordinator: true,
    originalDshLoop: true, candidateLocatedInFixedSource: true, reloadRetainsResult: true, linkedFixRequiresTestSelection: true,
    partialCoverageVisible: true, failedJsonVisible: true, failedJsonViaInjectedRunner: true,
    historicalModeForms: true, historicalModeExecutedInBrowser: true, historicalInferenceViaLocalMock: true,
    historyDeleted: true, sourceHeadIndexStatusUnchanged: true }) + '\n')
} finally {
  await call(['close']).catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(done => child.once('exit', done)), delay(5000)])
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
  }
  const actual = await realpath(root), offset = relative(await realpath(tmpdir()), actual)
  assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  await rm(actual, { recursive: true, force: true })
}
