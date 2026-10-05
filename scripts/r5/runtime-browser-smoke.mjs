import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createFixture, git } from '../r0/ocr-fixture.mjs'

const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = process.env.ITEROOM_PLAYWRIGHT_CLI
assert.ok(isAbsolute(cli ?? ''), 'Existing external playwright-cli.js required')
const root = await mkdtemp(join(tmpdir(), 'iteroom-r5-runtime-'))
const session = `iteroom-r5-${randomUUID().slice(0, 8)}`
const report = { version: 1, generatedAt: new Date().toISOString(), viewport: '390x844',
  evidence: 'production UI and SDK against synthetic loopback HTTP service', realModelRequests: 0,
  actualOpenSandboxServer: false, actualSandboxAllocations: 0, success: false }
let child, control, guard, mode = 'ok', modelRequests = 0, failure
const requests = []
const call = async args => {
  const result = await exec(process.execPath, [cli, '--session', session, ...args], {
    cwd: root, windowsHide: true, timeout: 45000, maxBuffer: 1048576,
  })
  if (/### Error/.test(result.stdout)) throw Error('Browser assertion failed')
  return result.stdout
}
const listen = (server, port) => new Promise((ready, reject) => {
  server.once('error', reject); server.listen(port, '127.0.0.1', ready)
})
const close = server => server?.listening ? new Promise((done, reject) => server.close(error => error ? reject(error) : done())) : Promise.resolve()
try {
  const fixture = await createFixture(root)
  const sourceHashes = async () => Object.fromEntries(await Promise.all(
    (await git(fixture, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      .map(async path => [path, createHash('sha256').update(await readFile(join(fixture.repository, path))).digest('hex')])))
  const originalSource = await sourceHashes()
  const original = await git(fixture, ['status', '--porcelain=v1', '-z'])
  const index = await readFile(join(fixture.repository, '.git/index'))
  const head = await git(fixture, ['rev-parse', 'HEAD'])
  const home = join(root, 'harness'), keyFile = join(root, 'sandbox-key')
  await writeFile(keyFile, 'synthetic-r5-sandbox')
  guard = createServer((_, response) => { modelRequests++; response.writeHead(503).end() })
  await listen(guard, 0)
  control = createServer((request, response) => {
    requests.push({ method: request.method, path: new URL(request.url, 'http://127.0.0.1:3088').pathname })
    if (request.method !== 'GET' || requests.at(-1).path !== '/v1/sandboxes'
      || request.headers['open-sandbox-api-key'] !== 'synthetic-r5-sandbox') return response.writeHead(403).end()
    if (mode === 'redirect') return response.writeHead(302, { location: `http://127.0.0.1:${guard.address().port}/redirect-target` }).end()
    if (mode === 'unavailable') return response.writeHead(503).end('synthetic-r5-sandbox')
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: [] }))
  })
  await listen(control, 3088) // Never stops or changes another service if the port is occupied.
  const env = { ...process.env, ITEROOM_DSH_HOME: home, ITEROOM_DATA_HOME: join(home, 'iteroom'),
    DEEPSEEK_API_KEY: 'sk-synthetic-r5', DEEPSEEK_BASE_URL: `http://127.0.0.1:${guard.address().port}`,
    ITEROOM_SANDBOX_KEY_FILE: keyFile, ITEROOM_SANDBOX_IMAGE: `node@sha256:${'a'.repeat(64)}`,
    ITEROOM_MANAGED_MAX_REQUESTS: '2', ITEROOM_MANAGED_MAX_OUTPUT_TOKENS: '128', DSH_TELEMETRY_DISABLED: '1',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }
  delete env.ITEROOM_MODEL_KEY_FILE
  child = spawn(process.execPath, [join(repository, 'bin/iteroom.mjs'), fixture.repository, '--no-open'], {
    cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env,
  })
  const url = await new Promise((ready, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(Error('Web startup timeout')), 60000)
    const receive = data => {
      output = (output + data.toString()).slice(-12000)
      const found = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (found) { clearTimeout(timer); ready(found[1]) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('exit', () => { clearTimeout(timer); reject(Error('Web exited before ready')) })
  })
  await call(['open', url]); await call(['resize', '390', '844'])
  await call(['run-code', `async (page) => {
    const intro = page.getByRole('dialog', { name: '内测声明' });
    await intro.waitFor({ state: 'visible', timeout: 15000 });
    await intro.getByRole('button', { name: '继续', exact: true }).click();
    await intro.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '隔离修改', exact: true }).click();
    await page.locator('summary').filter({ hasText: '运行配置' }).click();
    await page.getByText('DeepSeek Flash · 已配置 · 账户未验证', { exact: true }).waitFor();
    await page.getByText('最多 4 次请求，每次最多 512 输出 tokens', { exact: true }).waitFor();
    await page.getByText('尚未检查', { exact: true }).waitFor();
  }`])
  assert.equal(requests.length, 0, 'opening status must not call the service')
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: '检查沙箱连接', exact: true }).click();
    await page.getByText('可连接 · 未验证镜像或执行', { exact: false }).waitFor();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Horizontal overflow');
  }`])
  assert.equal(requests.length, 1)
  await mkdir(join(repository, 'docs/r5'), { recursive: true })
  await call(['run-code', `async (page) => {
    await page.locator('[data-iteroom-managed-modify]').screenshot({ path: ${JSON.stringify(join(repository, 'docs/r5/runtime-status-390.png'))} });
  }`])
  mode = 'unavailable'
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: '检查沙箱连接', exact: true }).click();
    await page.getByText('当前不可连接', { exact: false }).waitFor();
    const text = await page.locator('[data-iteroom-managed-modify]').innerText();
    if (text.includes('synthetic-r5-sandbox') || text.includes('sk-synthetic-r5')) throw Error('Private value visible');
  }`])
  mode = 'redirect'
  await call(['run-code', `async (page) => {
    await page.getByRole('button', { name: '检查沙箱连接', exact: true }).click();
    await page.getByText('当前不可连接', { exact: false }).waitFor();
    await page.getByRole('button', { name: '检查沙箱连接', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '刷新配置', exact: true }).click();
    await page.getByText('尚未检查', { exact: true }).waitFor();
    await page.getByRole('button', { name: '代码理解', exact: true }).click();
    await page.locator('summary').filter({ hasText: '运行配置' }).click();
    await page.getByText('最多 2 次请求，每次最多 128 输出 tokens', { exact: true }).waitFor();
    await page.getByRole('button', { name: '变更审查', exact: true }).click();
    await page.locator('summary').filter({ hasText: '运行配置' }).click();
    await page.getByText('最多 4 次请求，每次最多 512 输出 tokens', { exact: true }).waitFor();
  }`])
  assert.equal(modelRequests, 0, 'no model call or redirected credential request')
  assert.ok(requests.length >= 3 && requests.every(request => request.method === 'GET' && request.path === '/v1/sandboxes'))
  assert.equal(await git(fixture, ['status', '--porcelain=v1', '-z']), original)
  assert.deepEqual(await readFile(join(fixture.repository, '.git/index')), index)
  assert.equal(await git(fixture, ['rev-parse', 'HEAD']), head)
  assert.deepEqual(await sourceHashes(), originalSource)
  Object.assign(report, { productionButtons: true, sourceHeadIndexStatusUnchanged: true, getHasNoServiceCall: true,
    credentialValuesHidden: true, unavailableVisible: true, redirectRefused: true, budgetsMatchCoordinators: true,
    refreshClearsServiceObservation: true, sourceFilesHashChecked: Object.keys(originalSource).length, sandboxRequests: requests, success: true })
} catch (error) { failure = error; report.failure = 'R5_RUNTIME_BROWSER_FAILED' }
finally {
  await call(['close']).catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(done => child.once('exit', done)), delay(5000)])
    if (child.exitCode === null && child.signalCode === null) await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
  await close(control); await close(guard)
  report.modelGuardRequests = modelRequests
  report.probeServicesStopped = true
  report.clientHash = createHash('sha256').update(await readFile(join(repository, 'lib/client.js'))).digest('hex')
  await writeFile(join(repository, 'docs/r5/runtime-browser-report.json'), JSON.stringify(report, null, 2) + '\n')
  const actual = await realpath(root), offset = relative(await realpath(tmpdir()), actual)
  assert.ok(offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  await rm(actual, { recursive: true, force: true })
}
if (failure) throw Error('R5 runtime browser evidence failed; inspect anonymous report')
console.log(JSON.stringify(report))
