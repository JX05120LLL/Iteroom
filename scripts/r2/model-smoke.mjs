import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createOwnedService } from '../r0/sandbox-service.mjs'
import { validatePocRoot } from '../r0/sandbox-preflight.mjs'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { ManagedModifyCoordinator, reconcileManagedSandbox } from '../../src/host/managed-modify-coordinator.js'
import { loadManagedModelKey } from '../../src/host/managed-model-key.js'
import { readManagedArtifact } from '../../src/host/managed-artifact.js'
import { ManagedAcceptance } from '../../src/host/managed-acceptance.js'
import { runManagedModify } from '../../src/host/managed-engine-runner.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
const inside = (parent, child) => {
  const part = relative(parent, child)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** One authorized attempt; failure never starts a second model task. */
export async function runR2ModelSmoke(pocRoot, modelKeyPath, synthetic = false, cancel = false, accept = false) {
  if (accept && (!synthetic || cancel)) throw Error('R3 acceptance smoke requires the synthetic model and a completed task')
  const root = await validatePocRoot(pocRoot)
  const fixture = await mkdtemp(join(tmpdir(), 'iteroom-r2-model-'))
  const config = { image: JSON.parse(await readFile(join(root, 'images.json'), 'utf8'))['node:24-bookworm-slim'].digest,
    key: (await readFile(join(root, 'r0-key'), 'utf8')).trim() }
  config.connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http', apiKey: config.key,
    useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 15 }
  const service = await createOwnedService(root)
  const store = new ManagedTaskStore(join(fixture, 'data'), join(fixture, 'project'))
  let coordinator, taskId, started = false, report, cleanupError
  try {
    await mkdir(store.projectRoot)
    await writeFile(join(store.projectRoot, 'greet.mjs'), 'export const greet = () => "Hi"\n')
    await writeFile(join(store.projectRoot, 'greet.test.mjs'),
      'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { greet } from "./greet.mjs"\ntest("greet", () => assert.equal(greet(), "Hello"))\n')
    git(store.projectRoot, ['init', '--quiet'])
    git(store.projectRoot, ['-c', 'user.name=Iteroom Synthetic', '-c', 'user.email=synthetic@example.invalid', 'add', '.'])
    git(store.projectRoot, ['-c', 'user.name=Iteroom Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'synthetic baseline'])
    const beforeHead = git(store.projectRoot, ['rev-parse', 'HEAD'])
    const beforeStatus = git(store.projectRoot, ['status', '--porcelain'])
    const beforeSource = digest(await readFile(join(store.projectRoot, 'greet.mjs')))
    const key = synthetic ? 'synthetic' : await loadManagedModelKey(store.projectRoot,
      { ITEROOM_MODEL_KEY_FILE: modelKeyPath })
    const task = (await store.create({ requestId: 'r2-model-smoke', kind: 'modify',
      objective: cancel ? 'Hold synthetic model before modification' :
        'In greet.mjs, change greet() to return Hello instead of Hi. Run the selected test.',
      paths: ['greet.mjs', 'greet.test.mjs'] })).task
    taskId = task.id
    const mockAdapterPath = fileURLToPath(new URL('../../test/fixtures/managed-modify-model.mjs', import.meta.url))
    coordinator = new ManagedModifyCoordinator(store, { sandboxConfig: async () => config,
      modelKey: async () => key, engineLimits: { maxRequests: 4, maxOutputTokens: 512 },
      ...(synthetic ? { run: args => runManagedModify({ ...args, provider: 'iteroom-r2-mock',
        model: 'synthetic', modelKey: undefined, mockAdapterPath }) } : {}) })
    await service.start(); started = true
    await coordinator.start(taskId, 'r2-model-start')
    if (cancel) {
      let ready = false
      for (let attempt = 0; attempt < 200; attempt++) {
        const current = await store.get(taskId)
        if (current.engineStatus === 'running' && current.sandboxStatus === 'allocated') {
          ready = true; break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.equal(ready, true)
      await coordinator.cancel(taskId, 'r2-model-cancel')
    }
    const result = await coordinator.whenIdle(taskId)
    const journal = join(store.dataHome, 'managed-engine-v1', taskId, 'model-attempts.json')
    let requestCount = 0
    try { requestCount = JSON.parse(await readFile(journal, 'utf8')).attempts }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const hostUnchanged = beforeHead === git(store.projectRoot, ['rev-parse', 'HEAD'])
      && beforeStatus === git(store.projectRoot, ['status', '--porcelain'])
      && beforeSource === digest(await readFile(join(store.projectRoot, 'greet.mjs')))
    report = { schemaVersion: 1, evidenceKind: synthetic
      ? 'synthetic-dsh-model-actual-opensandbox' : 'actual-dsh-model-opensandbox',
      modelCalled: !synthetic && requestCount > 0,
      cancelledDuringRunningLoop: cancel,
      taskStatus: result.status, failureCode: result.failureCode ?? null,
      sandboxStatus: result.sandboxStatus ?? null, requestCount,
      maxRequests: 4, maxOutputTokensPerRequest: 512,
      executionStates: result.executions?.map(item => ({ kind: item.kind, status: item.status,
        exitCode: item.exitCode ?? null })) ?? [], hostUnchanged }
    if (result.status === 'awaiting_review') {
      const artifact = await readManagedArtifact(store, taskId, result.artifactId)
      execFileSync('git', ['apply', '--check', '-'], { cwd: store.projectRoot,
        input: artifact.patch, windowsHide: true })
      report.patchSha256 = artifact.sha256
      report.changeCount = artifact.changes.length
      report.patchApplicable = true
      if (accept) {
        const reviewer = new ManagedAcceptance(store)
        const preview = await reviewer.preview(taskId)
        assert.deepEqual(preview.files.map(item => item.status), ['ready'])
        const accepted = await reviewer.accept(taskId, 'r3-sandbox-accept')
        report.acceptedStatus = accepted.status
        report.acceptedSourceSha256 = digest(await readFile(join(store.projectRoot, 'greet.mjs')))
        report.headUnchangedAfterAccept = beforeHead === git(store.projectRoot, ['rev-parse', 'HEAD'])
        report.indexUnchangedAfterAccept = git(store.projectRoot, ['diff', '--cached', '--name-only']) === ''
        assert.equal(accepted.status, 'completed')
        assert.equal(await readFile(join(store.projectRoot, 'greet.mjs'), 'utf8'), 'export const greet = () => "Hello"\n')
        assert.equal(report.headUnchangedAfterAccept, true)
        assert.equal(report.indexUnchangedAfterAccept, true)
      }
    }
    assert.equal(hostUnchanged, true)
    if (cancel) { assert.equal(result.status, 'cancelled'); assert.equal(result.sandboxStatus, 'cleaned') }
  } finally {
    await coordinator?.dispose()
    if (started && taskId) {
      const task = await store.get(taskId)
      if (task.sandboxAllocationPending || task.sandboxStatus === 'allocated'
        || task.sandboxStatus === 'cleanup_pending') {
        try { await reconcileManagedSandbox({ store, taskId, config }) }
        catch (error) { cleanupError = error }
      }
    }
    if (started) await service.stop()
    const temp = await realpath(tmpdir()), actual = await realpath(fixture)
    if (inside(temp, actual)) await rm(actual, { recursive: true, force: true })
    else throw Error('Synthetic cleanup path escaped temp root')
    if (cleanupError) throw cleanupError
  }
  return { ...report, serviceStopped: !service.running }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!['1', 'synthetic', 'cancel', 'accept'].includes(process.env.ITEROOM_R2_MODEL_SMOKE)) throw Error('R2 model smoke not authorized')
  process.stdout.write(`${JSON.stringify(await runR2ModelSmoke(
    process.env.ITEROOM_SANDBOX_POC_ROOT, process.env.ITEROOM_MODEL_KEY_FILE,
    process.env.ITEROOM_R2_MODEL_SMOKE !== '1', process.env.ITEROOM_R2_MODEL_SMOKE === 'cancel',
    process.env.ITEROOM_R2_MODEL_SMOKE === 'accept'))}\n`)
}
