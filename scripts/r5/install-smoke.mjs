// Verifies a real tarball in an isolated consumer using the existing public npm cache.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createFixture, git } from '../r0/ocr-fixture.mjs'
import { ProbeBrowserSession } from './browser-session.mjs'

const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = process.env.ITEROOM_PLAYWRIGHT_CLI
const npmCli = process.env.ITEROOM_NPM_CLI ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
assert.equal(process.platform, 'win32', 'This probe currently verifies Windows only')
assert.ok(isAbsolute(cli ?? '') && isAbsolute(npmCli), 'Existing external Playwright and npm CLI paths required')
const evidenceName = process.argv[2] ?? 'installation'
assert.match(evidenceName, /^[a-z0-9-]{1,80}$/)
const flags = process.argv.slice(3)
assert.ok(flags.every(flag => ['--fail-after-start', '--online'].includes(flag)) && new Set(flags).size === flags.length)
const injectFailure = flags.includes('--fail-after-start'), online = flags.includes('--online')
const root = await mkdtemp(join(tmpdir(), 'iteroom-r5-install-'))
const session = `iteroom-install-${randomUUID().slice(0, 8)}`
const report = { version: 1, generatedAt: new Date().toISOString(), scope: 'Windows isolated tarball consumer, existing npm cache and optional public registry',
  platform: process.platform, node: process.version, parent: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim(),
  success: false, realModelRequests: 0, actualSandboxAllocations: 0, userSourceTransmitted: false, published: false,
  cleanMachineVerified: false, fullAcceptancePassed: false }
const inherited = { ...process.env }
for (const name of Object.keys(inherited)) if (/^(ITEROOM_|DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_)/.test(name)
  || ['NODE_PATH', 'NODE_OPTIONS'].includes(name)) delete inherited[name]
let child, guard, phase = 'pack', guardRequests = 0, cleanupOk = true
const within = (parent, path) => { const offset = relative(parent, path); return offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const call = async args => {
  const result = await exec(process.execPath, [cli, '--session', session, ...args], {
    cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 1048576,
  })
  if (/### Error/.test(result.stdout)) {
    await writeFile(join(tmpdir(), `iteroom-r5-${evidenceName}-browser-private.log`), result.stdout, { mode: 0o600 })
    throw Error('BROWSER_CHECK_FAILED')
  }
  return result.stdout
}
const browserSession = new ProbeBrowserSession(call)
const ownedProcesses = async () => {
  const literal = root.replace(/'/g, "''")
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*${literal}*' } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`],
  { windowsHide: true, timeout: 15000 })
  return stdout.trim() ? [JSON.parse(stdout)].flat() : []
}
try {
  const packed = JSON.parse((await exec(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', root],
    { cwd: repository, env: inherited, windowsHide: true, timeout: 60000, maxBuffer: 1048576 })).stdout)[0]
  assert.equal(basename(packed.filename), packed.filename)
  const tarball = join(root, packed.filename)
  const files = packed.files.map(item => item.path)
  assert.ok(files.includes('lib/client.js') && files.includes('lib/host/managed-runtime-status.js') && files.includes('iteroom.patch.yml'))
  assert.ok(files.every(path => !/^(src|test|scripts|node_modules)\/|(^|\/)(\.env|sandbox-key|managed-tasks)/.test(path)))
  Object.assign(report, { packageVersion: packed.version, tarballSha256: hash(await readFile(tarball)), packedFiles: files.length })
  phase = 'install'
  const consumer = join(root, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'iteroom-synthetic-consumer', private: true, type: 'module' }))
  await exec(process.execPath, [npmCli, 'install', tarball, ...(online ? ['--offline=false', '--prefer-offline'] : ['--offline']), '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org'], { cwd: consumer, env: inherited, windowsHide: true, timeout: 180000, maxBuffer: 2097152 })
  const installed = join(consumer, 'node_modules/iteroom')
  assert.equal((await lstat(installed)).isSymbolicLink(), false)
  assert.ok(within(await realpath(root), await realpath(installed)))
  for (const path of files) assert.equal(hash(await readFile(join(installed, path))), hash(await readFile(join(repository, path))))
  const require = createRequire(join(installed, 'package.json'))
  const dshManifest = require.resolve('@deepseek-ai/dsh/package.json')
  assert.ok(within(await realpath(root), await realpath(dshManifest)))
  const dsh = JSON.parse(await readFile(dshManifest, 'utf8'))
  const sdk = JSON.parse(await readFile(join(consumer, 'node_modules/@alibaba-group/opensandbox/package.json'), 'utf8'))
  assert.equal(dsh.version, '0.1.5-rc.3'); assert.equal(sdk.version, '1.1.0')
  Object.assign(report, { installedFileHashesMatched: files.length, consumerIsLinked: false, dshResolvedInsideConsumer: true,
    dshVersion: dsh.version, sandboxSdkVersion: sdk.version, installationOffline: !online, lifecycleScriptsEnabled: false,
    consumerLockSha256: hash(await readFile(join(consumer, 'package-lock.json'))) })
  const lock = JSON.parse(await readFile(join(consumer, 'package-lock.json'), 'utf8'))
  report.installedDependencies = {}
  for (const [path, item] of Object.entries(lock.packages)) if (path && item.version
    && await lstat(join(consumer, path)).then(() => true, () => false)) report.installedDependencies[path] = item.version
  phase = 'host-start'
  const fixture = await createFixture(root)
  await writeFile(join(fixture.repository, 'src/math.js'), 'export const identity = value => value\n')
  await writeFile(join(fixture.repository, 'test/math.test.js'), 'import { test } from "node:test"\ntest("synthetic", () => {})\n')
  const sourceHashes = async () => Object.fromEntries(await Promise.all(
    (await git(fixture, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      .map(async path => [path, hash(await readFile(join(fixture.repository, path)))])))
  const before = { hashes: await sourceHashes(), head: await git(fixture, ['rev-parse', 'HEAD']),
    index: hash(await readFile(join(fixture.repository, '.git/index'))), status: await git(fixture, ['status', '--porcelain=v1', '-z']) }
  guard = createServer((_, response) => { guardRequests++; response.writeHead(503).end() })
  await new Promise((done, reject) => { guard.once('error', reject); guard.listen(0, '127.0.0.1', done) })
  const home = join(root, 'harness'), env = { ...inherited, ITEROOM_DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${guard.address().port}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
  const bin = join(consumer, 'node_modules/.bin/iteroom.cmd')
  await lstat(bin)
  const launcher = join(installed, 'bin/iteroom.mjs')
  const help = await exec(process.execPath, [launcher, '--help'], { cwd: consumer, env, windowsHide: true })
  assert.match(help.stdout, /Usage: iteroom/)
  child = spawn(process.execPath, [launcher, fixture.repository, '--no-open'], {
    cwd: consumer, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tokenUrl = await new Promise((done, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(Error('STARTUP_TIMEOUT')), 45000)
    const receive = data => {
      output = (output + data.toString()).slice(-12000)
      const found = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (found) { clearTimeout(timer); done(found[1]) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('error', () => { clearTimeout(timer); reject(Error('STARTUP_FAILED')) })
    child.once('exit', () => { clearTimeout(timer); reject(Error('EARLY_EXIT')) })
  })
  report.installedLauncherStarted = true
  if (injectFailure) { phase = 'injected-after-start'; throw Error('INJECTED_FAILURE') }
  phase = 'api'
  const origin = new URL(tokenUrl).origin
  const exchange = await fetch(tokenUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.ok(exchange.status >= 300 && exchange.status < 400)
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie)
  const headers = { cookie, origin, 'content-type': 'application/json' }
  const request = async (path, body) => {
    const response = await fetch(origin + path, { headers, signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await fetch(origin + '/api/iteroom/runtime')).status, 401)
  assert.equal((await fetch(origin + '/api/iteroom/runtime', { headers: { cookie, origin: 'http://foreign.invalid' } })).status, 403)
  const runtime = await request('/api/iteroom/runtime')
  assert.equal(runtime.status, 200)
  assert.equal(runtime.body.model.status, 'missing'); assert.equal(runtime.body.sandbox.configuration, 'missing')
  assert.deepEqual(runtime.body.budgets.understand, { maxRequests: 3, maxOutputTokens: 256 })
  const rejected = []
  for (const kind of ['understand', 'modify']) {
    const created = await request('/api/iteroom/managed-tasks/create', { requestId: randomUUID(), kind,
      objective: 'synthetic installation validation', paths: kind === 'understand' ? ['src/math.js'] : ['src/math.js', 'test/math.test.js'] })
    assert.equal(created.status, 201)
    const taskId = created.body.task.id
    const base = '/api/iteroom/managed-tasks' + (kind === 'modify' ? '/modify' : '')
    const started = await request(base + '/start', { taskId, requestId: randomUUID() })
    assert.equal(started.status, 503)
    assert.equal(started.body.code, kind === 'understand' ? 'MODEL_NOT_CONFIGURED' : 'SANDBOX_NOT_CONFIGURED')
    const unchanged = (await request('/api/iteroom/managed-tasks?taskId=' + taskId)).body.task
    assert.equal(unchanged.status, 'queued'); assert.equal(unchanged.engineStatus, 'not_started')
    assert.equal(unchanged.sessionId, null)
    assert.equal((await request(base + '/cancel', { taskId, requestId: randomUUID() })).status, 200)
    rejected.push({ kind, code: started.body.code, engineStatus: unchanged.engineStatus })
  }
  Object.assign(report, { runtimeAuthenticationVerified: true, missingConfigurationVisible: true, missingConfigurationRejected: rejected })
  phase = 'browser'
  await browserSession.open(tokenUrl)
  await call(['resize', '390', '844'])
  await call(['run-code', `async (page) => {
    const intro = page.getByRole('dialog', { name: '内测声明' });
    await intro.waitFor({ state: 'visible', timeout: 15000 });
    await intro.getByRole('button', { name: '继续', exact: true }).click();
    await intro.waitFor({ state: 'hidden' });
    const later = page.getByRole('button', { name: '稍后配置', exact: true });
    if (await later.isVisible()) await later.click();
    await page.getByRole('button', { name: '隔离修改', exact: true }).click();
    await page.locator('summary').filter({ hasText: '运行配置' }).click();
    await page.getByText('DeepSeek Flash · 未配置 · 账户未验证', { exact: true }).waitFor();
    if (await page.getByRole('button', { name: '检查沙箱连接', exact: true }).isEnabled()) throw Error('Missing config must disable connection check');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Horizontal overflow');
    await page.locator('[data-iteroom-managed-modify]').screenshot({ path: ${JSON.stringify(join(repository, `docs/r5/${evidenceName}-status-390.png`))} });
    await page.getByRole('button', { name: '代码理解', exact: true }).click();
    await page.getByLabel('想了解什么', { exact: true }).fill('synthetic browser cancellation');
    await page.getByLabel('文件路径', { exact: true }).fill('src/math.js');
    await page.getByRole('button', { name: '创建任务', exact: true }).click();
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/iteroom/managed-tasks/start'));
    await page.getByRole('button', { name: '固定输入并开始理解', exact: true }).click();
    const response = await rejected;
    if (response.status() !== 503 || (await response.json()).code !== 'MODEL_NOT_CONFIGURED') throw Error('Missing model must reject before engine start');
    await page.getByRole('button', { name: '取消任务', exact: true }).click({ timeout: 5000 });
    await page.getByRole('button', { name: '创建任务', exact: true }).waitFor();
    if (!await page.getByRole('button', { name: '创建任务', exact: true }).isEnabled()) throw Error('Cancelled queued task must release the project');
  }`])
  Object.assign(report, { installedProductionBrowserPassed: true, viewport: '390x844',
    queuedUnderstandingRecoveryBrowserPassed: true,
    clientHash: hash(await readFile(join(installed, 'lib/client.js'))) })
  phase = 'source-preservation'
  assert.deepEqual(await sourceHashes(), before.hashes)
  assert.equal(await git(fixture, ['rev-parse', 'HEAD']), before.head)
  assert.equal(hash(await readFile(join(fixture.repository, '.git/index'))), before.index)
  assert.equal(await git(fixture, ['status', '--porcelain=v1', '-z']), before.status)
  assert.equal(guardRequests, 0)
  Object.assign(report, { syntheticSourceFilesHashChecked: Object.keys(before.hashes).length, sourceHeadIndexStatusUnchanged: true, success: true })
} catch (error) {
  report.failureStage = phase
  const code = error.stderr?.match(/(?:error|ERR!) code ([A-Z_]+)/)?.[1]
  if (code) report.failureCode = code
  await writeFile(join(tmpdir(), `iteroom-r5-${evidenceName}-private.log`), error.stderr || error.stdout || error.stack || String(error), { mode: 0o600 })
  report.privateDiagnosticsSaved = true
}
finally {
  try { report.browserSessionCloseConfirmed = await browserSession.close() }
  catch { cleanupOk = false; report.browserSessionCloseConfirmed = false }
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 })
      await Promise.race([new Promise(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)), delay(3000)])
    }
    for (const pid of await ownedProcesses()) await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 })
    report.ownedNodeProcessesRemaining = (await ownedProcesses()).length
    assert.equal(report.ownedNodeProcessesRemaining, 0)
  } catch { cleanupOk = false }
  try { if (guard?.listening) await new Promise((done, reject) => guard.close(error => error ? reject(error) : done())) }
  catch { cleanupOk = false }
  report.modelGuardRequests = guardRequests
  report.probeServicesStopped = cleanupOk
  try {
    const actual = await realpath(root)
    assert.ok(within(await realpath(tmpdir()), actual) && basename(actual).startsWith('iteroom-r5-install-'))
    if (cleanupOk) { await rm(actual, { recursive: true, force: true }); report.temporaryDirectoryRemoved = true }
    else report.temporaryDirectoryRemoved = false
  } catch { cleanupOk = false; report.temporaryDirectoryRemoved = false }
  if (!cleanupOk) report.success = false
  report.expectedFailureCleanupPassed = injectFailure && phase === 'injected-after-start' && cleanupOk
  report.scriptHash = hash(await readFile(fileURLToPath(import.meta.url)))
  report.browserSessionHelperHash = hash(await readFile(join(repository, 'scripts/r5/browser-session.mjs')))
  await writeFile(join(repository, `docs/r5/${evidenceName}-report.json`), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ success: report.success, failureStage: report.failureStage,
  installedFileHashesMatched: report.installedFileHashesMatched, installedDependencies: Object.keys(report.installedDependencies ?? {}).length,
  installedProductionBrowserPassed: report.installedProductionBrowserPassed, modelGuardRequests: report.modelGuardRequests,
  ownedNodeProcessesRemaining: report.ownedNodeProcessesRemaining, temporaryDirectoryRemoved: report.temporaryDirectoryRemoved,
  expectedFailureCleanupPassed: report.expectedFailureCleanupPassed }))
if ((!report.success && !report.expectedFailureCleanupPassed) || !cleanupOk) throw Error(`Installation evidence failed at ${report.failureStage ?? 'cleanup'}; inspect anonymous report`)
