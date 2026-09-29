import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Sandbox, SandboxManager, createDefaultAdapterFactory } from '@alibaba-group/opensandbox'
import { createOwnedService } from '../r0/sandbox-service.mjs'
import { validatePocRoot } from '../r0/sandbox-preflight.mjs'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { captureManagedSnapshot } from '../../src/host/managed-snapshot.js'
import { openManagedSandbox, runManagedTest, exportManagedPatch } from '../../src/host/managed-sandbox.js'
import { reconcileManagedSandbox } from '../../src/host/managed-modify-coordinator.js'

const digest = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const inside = (parent, child) => {
  const part = relative(parent, child)
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

/** Runs only against a fresh synthetic Git project and an owned loopback service. */
export async function runR2SandboxSmoke(pocRoot) {
  const root = await validatePocRoot(pocRoot)
  const fixture = await mkdtemp(join(tmpdir(), 'iteroom-r2-live-'))
  const config = { image: JSON.parse(await readFile(join(root, 'images.json'), 'utf8'))['node:24-bookworm-slim'].digest,
    connectionConfig: { domain: '127.0.0.1:3088', protocol: 'http',
      apiKey: (await readFile(join(root, 'r0-key'), 'utf8')).trim(), useServerProxy: true,
      disableMetrics: true, requestTimeoutSeconds: 15 } }
  const service = await createOwnedService(root)
  const store = new ManagedTaskStore(join(fixture, 'data'), join(fixture, 'project'))
  let session, taskId, serviceStarted = false, result, cleanupError
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
    const task = (await store.create({ requestId: 'r2-live-smoke', kind: 'modify',
      objective: 'Fix the synthetic greeting', paths: ['greet.mjs', 'greet.test.mjs'] })).task
    taskId = task.id
    await captureManagedSnapshot(store, taskId)
    await store.claimModify(taskId, 'r2-live-start')
    await service.start(); serviceStarted = true
    session = await openManagedSandbox({ store, taskId, sdk: { Sandbox, SandboxManager, createDefaultAdapterFactory },
      connectionConfig: config.connectionConfig, image: config.image })
    const failing = await runManagedTest(session, ['greet.test.mjs'])
    assert.equal(failing.status, 'failed')
    await session.sandbox.files.writeFiles([{ path: '/workspace/greet.mjs',
      data: 'export const greet = () => "Hello"\n', mode: 644 }])
    const passing = await runManagedTest(session, ['greet.test.mjs'])
    assert.equal(passing.status, 'completed')
    const patch = await exportManagedPatch(session)
    execFileSync('git', ['apply', '--check', '-'], { cwd: store.projectRoot,
      input: patch.patch, windowsHide: true })
    await session.sandbox.files.writeFiles([{ path: '/workspace/greet.test.mjs',
      data: 'import { test } from "node:test"\ntest("slow synthetic test", async () => { await new Promise(resolve => setTimeout(resolve, 20000)) })\n', mode: 644 }])
    const commands = session.sandbox.commands
    const faultSession = { ...session, sandbox: { commands: {
      run: (command, options, handlers) => commands.run(command, options, { ...handlers,
        onInit: async init => { await handlers.onInit(init); throw Error('synthetic after-init stream fault') } }),
      getCommandStatus: commands.getCommandStatus.bind(commands),
      interrupt: commands.interrupt.bind(commands),
    } } }
    let injectedFailure
    try { await runManagedTest(faultSession, ['greet.test.mjs']) }
    catch (error) { injectedFailure = error.code }
    const faultRecord = (await store.get(taskId)).executions.at(-1)
    assert.equal(injectedFailure, 'SANDBOX_EXECUTION_UNKNOWN')
    assert.equal(faultRecord.status, 'interrupted')
    const inFlight = runManagedTest(session, ['greet.test.mjs']).then(() => 'returned', error => error.code ?? 'error')
    let runningId
    for (let attempt = 0; attempt < 100; attempt++) {
      runningId = (await store.get(taskId)).executions?.at(-1)?.id
      if ((await store.get(taskId)).executions?.length === 4) break
      await delay(50)
    }
    assert.ok(runningId)
    assert.equal((await store.get(taskId)).executions.length, 4)
    await session.cleanup(); session = null
    const inFlightResult = await inFlight
    const inFlightRecord = (await store.get(taskId)).executions.at(-1)
    result = { schemaVersion: 1, evidenceKind: 'actual-opensandbox-no-model',
      sandboxCreated: true, executionCount: 4, baselineExitCode: failing.exitCode,
      fixedExitCode: passing.exitCode, changeCount: patch.changes.length,
      patchSha256: patch.sha256, hostUnchanged: beforeHead === git(store.projectRoot, ['rev-parse', 'HEAD'])
        && beforeStatus === git(store.projectRoot, ['status', '--porcelain'])
        && beforeSource === digest(await readFile(join(store.projectRoot, 'greet.mjs'))),
      injectedFailure, injectedStatus: faultRecord.status,
      inFlightResult, inFlightStatus: inFlightRecord.status, inFlightExitCode: inFlightRecord.exitCode,
      sandboxCleaned: (await store.get(taskId)).sandboxStatus === 'cleaned' }
    assert.equal(result.hostUnchanged, true)
    assert.equal(result.sandboxCleaned, true)
    assert.equal(result.inFlightStatus, 'interrupted')
  } finally {
    if (session) {
      try { await session.cleanup() } catch (error) { cleanupError = error }
    } else if (serviceStarted && taskId) {
      const task = await store.get(taskId)
      if (task.sandboxAllocationPending || task.sandboxStatus === 'allocated') {
        try { await reconcileManagedSandbox({ store, taskId, config }) }
        catch (error) { cleanupError = error }
      }
    }
    if (serviceStarted) await service.stop()
    const temp = await realpath(tmpdir()), actual = await realpath(fixture)
    if (inside(temp, actual)) await rm(actual, { recursive: true, force: true })
    else throw Error('Synthetic cleanup path escaped temp root')
    if (cleanupError) throw cleanupError
  }
  return { ...result, serviceStopped: !service.running }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.ITEROOM_R2_SANDBOX_SMOKE !== '1') throw Error('Synthetic sandbox smoke not authorized')
  process.stdout.write(`${JSON.stringify(await runR2SandboxSmoke(process.env.ITEROOM_SANDBOX_POC_ROOT))}\n`)
}
