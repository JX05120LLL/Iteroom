import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { captureManagedSnapshot } from '../../src/host/managed-snapshot.js'
import { saveManagedArtifact } from '../../src/host/managed-artifact.js'
import { ManagedAcceptance } from '../../src/host/managed-acceptance.js'

const exec = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

async function seed(store) {
  const task = (await store.create({ requestId: 'r3-browser-task', kind: 'modify', objective: 'Change synthetic greeting',
    paths: ['greet.mjs', 'greet.test.mjs'] })).task
  const snapshot = await captureManagedSnapshot(store, task.id)
  await store.claimModify(task.id, 'start-1')
  await store.recordSandbox(task.id, 'synthetic-sandbox-1')
  await store.recordExecutionStart(task.id, { id: 'synthetic-test-1', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'synthetic-test-1', { status: 'completed', exitCode: 0,
    outputSha256: digest('ok'), outputBytes: 2 })
  await store.markSandboxCleaned(task.id)
  const before = 'export const greet = () => "Hi"\n'
  const after = 'export const greet = () => "Hello"\n'
  const patch = 'diff --git a/greet.mjs b/greet.mjs\n--- a/greet.mjs\n+++ b/greet.mjs\n@@ -1,1 +1,1 @@\n-export const greet = () => "Hi"\n+export const greet = () => "Hello"\n'
  const artifact = await saveManagedArtifact(store, task.id, { version: 1, taskId: task.id, snapshotId: snapshot.id,
    changes: [{ path: 'greet.mjs', kind: 'modified', beforeSha256: digest(before), afterSha256: digest(after),
      beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) }], patch, sha256: digest(patch) })
  await store.finishModify(task.id, { artifactId: artifact.id, changeCount: 1, verificationId: 'synthetic-test-1' })
  return task.id
}

async function seedRecovery(store, project) {
  const changed = ['first.mjs', 'second.mjs']
  for (const path of changed) await writeFile(join(project, path), `export const ${path.split('.')[0]} = 1\n`)
  await writeFile(join(project, 'recover.test.mjs'), 'import "./first.mjs"\n')
  const task = (await store.create({ requestId: 'r3-browser-recovery', kind: 'modify',
    objective: 'Recover synthetic partial write', paths: [...changed, 'recover.test.mjs'] })).task
  const snapshot = await captureManagedSnapshot(store, task.id)
  await store.claimModify(task.id, 'start-2')
  await store.recordSandbox(task.id, 'synthetic-sandbox-2')
  await store.recordExecutionStart(task.id, { id: 'synthetic-test-2', kind: 'test', command: 'node --test', cwd: '/workspace' })
  await store.finishExecution(task.id, 'synthetic-test-2', { status: 'completed', exitCode: 0,
    outputSha256: digest('ok'), outputBytes: 2 })
  await store.markSandboxCleaned(task.id)
  const changes = changed.map(path => {
    const name = path.split('.')[0]
    const before = `export const ${name} = 1\n`, after = `export const ${name} = 2\n`
    return { path, kind: 'modified', beforeSha256: digest(before), afterSha256: digest(after),
      beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) }
  })
  const patch = changed.map(path => {
    const name = path.split('.')[0]
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-export const ${name} = 1\n+export const ${name} = 2\n`
  }).join('')
  const artifact = await saveManagedArtifact(store, task.id, { version: 1, taskId: task.id, snapshotId: snapshot.id,
    changes, patch, sha256: digest(patch) })
  await store.finishModify(task.id, { artifactId: artifact.id, changeCount: 2, verificationId: 'synthetic-test-2' })
  await assert.rejects(new ManagedAcceptance(store, { afterWrite: async index => {
    if (index === 0) throw Error('synthetic interruption')
  } }).accept(task.id, 'r3-browser-inject'))
  assert.equal((await store.get(task.id)).status, 'interrupted')
  return task.id
}

async function start(project, home) {
  const child = spawn(process.execPath, [join(repo, 'bin', 'iteroom.mjs'), project, '--no-open'], {
    cwd: repo, env: { ...process.env, ITEROOM_DSH_HOME: home, ITEROOM_DATA_HOME: join(home, 'iteroom'),
      DEEPSEEK_API_KEY: 'synthetic-browser-placeholder', DSH_TELEMETRY_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''
  const url = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(Error('Web startup timed out')), 90_000)
    const receive = chunk => {
      output = (output + chunk.toString('utf8')).slice(-12000)
      const found = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (found) { clearTimeout(timer); resolveReady(found[1]) }
    }
    child.stdout.on('data', receive); child.stderr.on('data', receive)
    child.once('exit', code => { clearTimeout(timer); rejectReady(Error(`Web exited ${code}: ${output.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-1000)}`)) })
  })
  return { child, url }
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(5000)])
  if (child.exitCode === null && child.signalCode === null && process.platform === 'win32' && child.pid) {
    await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  }
}

async function main() {
  const cli = process.env.ITEROOM_PLAYWRIGHT_CLI
  if (!isAbsolute(cli ?? '')) throw Error('ITEROOM_PLAYWRIGHT_CLI must point to an installed external playwright-cli.js')
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r3-browser-'))
  const project = join(root, 'project'), home = join(root, 'harness')
  await mkdir(project)
  await writeFile(join(project, 'greet.mjs'), 'export const greet = () => "Hi"\n')
  await writeFile(join(project, 'greet.test.mjs'), 'import "./greet.mjs"\n')
  const store = new ManagedTaskStore(join(home, 'iteroom'), project)
  const taskId = await seed(store)
  const session = `iteroom-r3-${randomUUID().slice(0, 8)}`
  const cliCall = async args => {
    try { return (await exec(process.execPath, [cli, '--session', session, ...args], { cwd: root, windowsHide: true,
      maxBuffer: 1024 * 1024, timeout: 20000 })).stdout }
    catch (error) { throw Error(String([error.stdout, error.stderr, error.message].filter(Boolean).join('\n'))
      .replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-2500)) }
  }
  let runtime
  try {
    runtime = await start(project, home)
    await cliCall(['open', runtime.url])
    const before = await cliCall(['snapshot'])
    assert.match(before, /隔离修改/)
    if (process.env.ITEROOM_R3_BROWSER_DEBUG === '1') process.stdout.write(before.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-5000))
    await cliCall(['run-code', `async (page) => { const intro = page.getByRole('dialog', { name: '内测声明' }); if (await intro.isVisible()) await intro.getByRole('button', { name: '继续' }).click(); }`])
    const afterIntro = await cliCall(['snapshot'])
    if (process.env.ITEROOM_R3_BROWSER_DEBUG === '1') process.stdout.write(afterIntro.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-2500))
    await cliCall(['run-code', `async (page) => { await page.getByText('隔离修改', { exact: true }).first().click({ timeout: 5000 }); }`])
    const panel = await cliCall(['snapshot'])
    assert.match(panel, /接受并写回本地文件/, panel.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-1800))
    await cliCall(['resize', '390', '844'])
    assert.match(await cliCall(['snapshot']), /导出 \.patch/)
    await cliCall(['run-code', `async (page) => {
      const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
      await page.getByRole('button', { name: '导出 .patch' }).click({ timeout: 5000 });
      const download = await downloadPromise;
      if (!download.suggestedFilename().endsWith('.patch')) throw Error('patch download missing');
    }`])
    await cliCall(['run-code', `async (page) => {
      await page.getByRole('button', { name: '接受并写回本地文件' }).click({ timeout: 5000 });
      await page.getByText('已接受', { exact: true }).waitFor({ timeout: 5000 });
    }`])
    assert.equal((await store.get(taskId)).status, 'completed')
    assert.equal(await readFile(join(project, 'greet.mjs'), 'utf8'), 'export const greet = () => "Hello"\n')
    await cliCall(['run-code', `async (page) => {
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: '删除任务历史' }).click();
      await page.getByText('Change synthetic greeting').waitFor({ state: 'detached', timeout: 15000 });
    }`])
    let deleted = false
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await store.get(taskId) }
      catch (error) { if (error.code === 'TASK_NOT_FOUND') { deleted = true; break } throw error }
      await delay(200)
    }
    if (!deleted) {
      const state = await cliCall(['snapshot'])
      throw Error(`History not deleted: ${state.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-1800)}`)
    }
    const recoveryTaskId = await seedRecovery(store, project)
    await cliCall(['run-code', `async (page) => {
      await page.reload();
      await page.getByRole('button', { name: '隔离修改' }).click({ timeout: 5000 });
      await page.getByRole('button', { name: '核对后撤销已写入' }).waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: '核对后撤销已写入' }).click();
      await page.getByText('已放弃', { exact: true }).waitFor({ timeout: 10000 });
    }`])
    assert.equal((await store.get(recoveryTaskId)).status, 'discarded')
    assert.equal(await readFile(join(project, 'first.mjs'), 'utf8'), 'export const first = 1\n')
    process.stdout.write(JSON.stringify({ browser: 'playwright-cli', viewport: '390x844', modelRequests: 0,
      patchDownloaded: true, accepted: true, sourceChanged: true, historyDeleted: true,
      recoveryRolledBack: true }) + '\n')
  } finally {
    await cliCall(['close']).catch(() => {})
    await stop(runtime?.child)
    await rm(root, { recursive: true, force: true })
  }
}

await main()
