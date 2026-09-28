import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { inspectSandboxPreflight, validatePocRoot, SANDBOX_PIN } from './sandbox-preflight.mjs'
import { failure, runBounded, controlledEnv } from './ocr-process.mjs'
import { sha256 } from './review-files.mjs'

export function createOptions(image, owner) {
  if (!/^node@sha256:[0-9a-f]{64}$/.test(image)) throw failure('invalid_sandbox_image')
  if (!/^[0-9a-f]{32}$/.test(owner)) throw failure('invalid_sandbox_owner')
  return { image, metadata: { 'iteroom-r0-owner': owner }, platform: { os: 'linux', arch: 'amd64' },
    resource: { cpu: '1', memory: '512Mi' }, volumes: [], env: {},
    networkPolicy: { defaultAction: 'deny', egress: [] }, timeoutSeconds: 300,
    readyTimeoutSeconds: 60, healthCheckPollingInterval: 500 }
}
const delay = ms => new Promise(done => setTimeout(done, ms))
export function shellCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv[0] || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw failure('invalid_sandbox_command')
  return argv.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')
}
function requireFact(value, code = 'sandbox_assertion') { if (!value) throw failure(code) }
export async function inspectSandboxRuntime(value, { authorized = false } = {}) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), pin: SANDBOX_PIN,
    evidenceKind: 'actual-opensandbox-docker-runtime', gateC: 'not_completed',
    sseTransport: 'native-fetch-via-public-adapter-factory',
    actualSandboxCreated: false, modelCalled: false, userSourceRead: false, checks: {}, executions: [],
    unverified: ['ttl', 'control-service-restart', 'cleanup-failure-retry',
      'full-network-policy-enforcement', 'DSH-sandbox-tool-loop'] }
  if (!authorized) return { ...report, status: 'unavailable', errorCode: 'sandbox_execution_not_authorized' }
  const preflight = await inspectSandboxPreflight(value)
  if (preflight.status !== 'ready_for_poc') return { ...report, status: 'unavailable', errorCode: preflight.errorCode }
  const root = await validatePocRoot(value), owner = randomBytes(16).toString('hex'), owned = []
  const images = JSON.parse(await readFile(join(root, 'images.json'), 'utf8'))
  const key = (await readFile(join(root, 'r0-key'), 'utf8')).trim()
  const sdk = await import(pathToFileURL(join(root, 'sdk/node_modules/@alibaba-group/opensandbox/dist/index.js')).href)
  const connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http', apiKey: key,
    useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 15 }
  const manager = sdk.SandboxManager.create({ connectionConfig })
  const baseFactory = sdk.createDefaultAdapterFactory()
  const adapterFactory = {
    ...baseFactory,
    // SDK 1.1.0 removes its abort relay after response headers. Native fetch
    // preserves the caller signal for the whole SSE body; all HTTP stays real.
    createExecdStack: options => baseFactory.createExecdStack({ ...options, connectionConfig: {
      ...options.connectionConfig, fetch: options.connectionConfig.fetch, sseFetch: globalThis.fetch,
    } }),
    createEgressStack: options => baseFactory.createEgressStack(options),
    createNetworkPolicyStack: options => baseFactory.createNetworkPolicyStack(options),
    createLifecycleStack(options) {
      const stack = baseFactory.createLifecycleStack(options), service = stack.sandboxes
      return { sandboxes: new Proxy(service, { get(target, field) {
        if (field === 'createSandbox') return async (...args) => {
          const response = await target.createSandbox(...args)
          requireFact(response.metadata?.['iteroom-r0-owner'] === owner, 'sandbox_ownership_mismatch')
          owned.push(response.id)
          await writeFile(join(root, 'owned-sandboxes.json'), JSON.stringify({ owner, ids: owned }))
          report.allocationState = response.status.state
          return response
        }
        const result = target[field]; return typeof result === 'function' ? result.bind(target) : result
      } }) }
    },
  }
  const docker = args => runBounded('docker', ['-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args],
    { cwd: root, env: controlledEnv(join(root, 'home')), timeoutMs: 15000 })
  const hostFixture = join(root, `synthetic-input-${owner}`)
  let sandbox, error, cleanupError, stage = 'create'
  const managedVolumes = new Set()
  try {
    const image = images['node:24-bookworm-slim'].digest
    report.images = images
    const fixture = { 'greet.mjs': 'export function greet(name) { return "Hi, " + name }\n',
      'greet.test.mjs': 'import {test} from "node:test"; import assert from "node:assert/strict"; import {greet} from "./greet.mjs"; test("synthetic greeting",()=>assert.equal(greet("fixture"),"Hello, fixture"));\n' }
    await mkdir(hostFixture)
    for (const [path, data] of Object.entries(fixture)) await writeFile(join(hostFixture, path), data)
    const hostHash = async () => sha256(JSON.stringify(await Promise.all(Object.keys(fixture).map(async path =>
      [path, sha256(await readFile(join(hostFixture, path)))]))))
    const inputHash = await hostHash(), options = createOptions(image, owner)
    sandbox = await sdk.Sandbox.create({ ...options, connectionConfig, adapterFactory })
    report.actualSandboxCreated = true
    const info = await sandbox.getInfo()
    requireFact(info.status.state === 'Running' && await sandbox.isHealthy(), 'sandbox_not_ready')
    report.checks.waitedForReadyAndHealth = true
    const runtime = JSON.parse((await docker(['inspect', `sandbox-${sandbox.id}`, '--format', '{{json .}}'])).stdout)
    requireFact(runtime.Config.Labels['opensandbox.io/id'] === sandbox.id
      && runtime.Config.Labels['iteroom-r0-owner'] === owner, 'sandbox_ownership_mismatch')
    report.runtimeLimits = { memoryBytes: runtime.HostConfig.Memory, nanoCpus: runtime.HostConfig.NanoCpus,
      cpuQuota: runtime.HostConfig.CpuQuota, cpuPeriod: runtime.HostConfig.CpuPeriod,
      pidsLimit: runtime.HostConfig.PidsLimit, mountTypes: runtime.Mounts.map(mount => mount.Type), securityOpt: runtime.HostConfig.SecurityOpt }
    for (const mount of runtime.Mounts) if (mount.Type === 'volume') managedVolumes.add(mount.Name)
    const oneCpu = runtime.HostConfig.NanoCpus === 1000000000
      || (runtime.HostConfig.CpuPeriod > 0 && runtime.HostConfig.CpuQuota / runtime.HostConfig.CpuPeriod === 1)
    requireFact(runtime.HostConfig.Memory === 512 * 1024 * 1024 && oneCpu
      && runtime.HostConfig.PidsLimit === 128 && runtime.Mounts.every(mount => mount.Type !== 'bind')
      && runtime.HostConfig.SecurityOpt.some(option => /^no-new-privileges(?:[=:]true)?$/.test(option))
      && !runtime.Config.Env.some(item => item.includes(key)), 'sandbox_isolation_mismatch')
    report.checks.actualLimitsNoHostBindsNoKey = true
    stage = 'create-workspace-directory'
    // SDK 1.1.0 serializes mode as decimal digits while execd parses base 8.
    await sandbox.files.createDirectories([{ path: '/workspace', mode: 755 }])
    stage = 'import-files'
    await sandbox.files.writeFiles(Object.entries(fixture).map(([path, data]) => ({ path: `/workspace/${path}`, data, mode: 644 })))
    for (const [path, data] of Object.entries(fixture)) requireFact(await sandbox.files.readFile(`/workspace/${path}`) === data)
    const run = async (name, command, extra = {}, handlers = {}) => {
      stage = name
      let bytes = 0, log = ''
      const append = msg => { bytes += Buffer.byteLength(msg.text); if (bytes > 65536) throw failure('output_limit'); log += msg.text }
      // Published execd v1.1.0 requires command, despite SDK's newer argv type.
      const result = await sandbox.commands.run(shellCommand(command), { workingDirectory: '/workspace', timeoutSeconds: 15, ...extra },
        { ...handlers, onStdout: append, onStderr: append, skipAccumulation: true })
      report.executions.push({ name, executionIdSha256: result.id && sha256(result.id),
        commandSha256: sha256(JSON.stringify(command)), cwd: '/workspace', exitCode: result.exitCode ?? null,
        errorPresent: !!result.error, outputBytes: bytes, outputSha256: sha256(log) })
      return result
    }
    const literalArgs = ["a'b", '$HOME; echo unsafe', 'space and 中文']
    const literal = await run('literal-argv', ['node', '-e',
      `import assert from "node:assert/strict";assert.deepEqual(process.argv.slice(1),${JSON.stringify(literalArgs)});`,
      ...literalArgs])
    requireFact(literal.exitCode === 0, 'literal_argv_changed')
    report.checks.literalArgvPreserved = true
    const before = await run('failing-node-test', ['node', '--test', 'greet.test.mjs'])
    requireFact(before.exitCode === 1, 'failed_test_not_preserved')
    const changed = 'export function greet(name) { return "Hello, " + name }\n'
    await sandbox.files.writeFiles([{ path: '/workspace/greet.mjs', data: changed, mode: 644 }])
    const after = await run('passing-node-test', ['node', '--test', 'greet.test.mjs'])
    requireFact(after.exitCode === 0 && !after.error, 'actual_test_failed')
    const exported = await sandbox.files.readFile('/workspace/greet.mjs')
    requireFact(exported === changed)
    report.artifact = { path: 'greet.mjs', inputSha256: sha256(fixture['greet.mjs']), outputSha256: sha256(exported), bytes: Buffer.byteLength(exported) }
    report.checks.importModifyTestExport = true
    const afterHash = await hostHash()
    requireFact(inputHash === afterHash, 'host_input_changed')
    report.hostInput = { files: Object.keys(fixture).length, beforeSha256: inputHash, afterSha256: afterHash }
    report.checks.hostInputUnchanged = true
    const policy = await sandbox.getEgressPolicy()
    requireFact(policy.defaultAction === 'deny' && !(policy.egress?.length))
    report.checks.explicitDenyPolicy = true
    const sentinel = 'import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync("pids.json",JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);'
    const active = await run('background-parent-and-child', ['node', '-e', sentinel], { background: true, timeoutSeconds: 30 })
    requireFact(active.id, 'execution_id_missing')
    for (let attempt = 0; attempt < 20; attempt++) {
      try { if ((await sandbox.files.readFile('/workspace/pids.json')).trim()) break } catch (e) { if (e.statusCode !== 404) throw e }
      await delay(100)
    }
    await sandbox.commands.interrupt(active.id)
    const status = await sandbox.commands.getCommandStatus(active.id)
    requireFact(status.running === false, 'cancellation_unconfirmed')
    const checkPids = 'import{readFileSync}from"node:fs";const pids=JSON.parse(readFileSync("pids.json","utf8"));let alive=0;for(const pid of pids){try{const s=readFileSync("/proc/"+pid+"/stat","utf8");if(!s.split(") ")[1].startsWith("Z"))alive++}catch{}}console.log(alive);process.exit(alive?1:0);'
    const stopped = await run('confirm-parent-and-child-stopped', ['node', '-e', checkPids])
    requireFact(stopped.exitCode === 0, 'descendant_cancellation_unconfirmed')
    report.checks.backgroundDescendantsStopped = true
    const waitPids = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        try { if ((await sandbox.files.readFile('/workspace/pids.json')).trim()) return } catch (e) { if (e.statusCode !== 404) throw e }
        await delay(100)
      }
      throw failure('sentinel_not_ready')
    }
    await sandbox.files.writeFiles([{ path: '/workspace/pids.json', data: '', mode: 644 }])
    let foregroundId
    const foreground = run('foreground-parent-and-child', ['node', '-e', sentinel], {},
      { onInit: init => { foregroundId = init.id } }).then(result => ({ result }), caught => ({ caught }))
    await waitPids()
    requireFact(foregroundId, 'execution_id_missing')
    await sandbox.commands.interrupt(foregroundId)
    const ended = await foreground
    if (ended.caught) throw ended.caught
    requireFact((await sandbox.commands.getCommandStatus(foregroundId)).running === false, 'foreground_cancellation_unconfirmed')
    requireFact((await run('confirm-foreground-descendants-stopped', ['node', '-e', checkPids])).exitCode === 0,
      'foreground_descendants_alive')
    report.checks.foregroundDescendantsStopped = true
    await sandbox.files.writeFiles([{ path: '/workspace/pids.json', data: '', mode: 644 }])
    const timed = await run('command-timeout', ['node', '-e', sentinel], { timeoutSeconds: 2 })
    requireFact(timed.error && timed.exitCode !== 0 && timed.id, 'command_timeout_missing')
    requireFact((await sandbox.commands.getCommandStatus(timed.id)).running === false, 'timeout_unconfirmed')
    requireFact((await run('confirm-timeout-descendants-stopped', ['node', '-e', checkPids])).exitCode === 0,
      'timeout_descendants_alive')
    report.checks.timeoutDescendantsStopped = true
    stage = 'stream-disconnect'
    await sandbox.files.writeFiles([{ path: '/workspace/pids.json', data: '', mode: 644 }])
    const abort = new AbortController()
    let detachedId
    const detached = sandbox.commands.run(shellCommand(['node', '-e', sentinel]),
      { workingDirectory: '/workspace', timeoutSeconds: 30 },
      { onInit: init => { detachedId = init.id }, skipAccumulation: true }, abort.signal)
      .then(result => ({ result }), caught => ({ caught }))
    await waitPids()
    requireFact(detachedId, 'execution_id_missing')
    abort.abort()
    const disconnected = await detached
    requireFact(disconnected.caught, 'client_disconnect_missing')
    const remote = await sandbox.commands.getCommandStatus(detachedId)
    report.disconnect = { executionIdSha256: sha256(detachedId), clientRequestAborted: true,
      remoteRunningAfterAbort: remote.running, explicitlyInterrupted: remote.running === true, replayed: false }
    if (remote.running) await sandbox.commands.interrupt(detachedId)
    requireFact((await sandbox.commands.getCommandStatus(detachedId)).running === false, 'disconnect_stop_unconfirmed')
    requireFact((await run('confirm-disconnect-descendants-stopped', ['node', '-e', checkPids])).exitCode === 0,
      'disconnect_descendants_alive')
    report.checks.disconnectReconciledWithoutReplay = true
  } catch (caught) {
    error = caught
    report.failedStage = stage
    const message = String(caught.error?.message ?? caught.message ?? '')
    report.errorSummary = message.replaceAll(key, '[key]').replaceAll(root, '[poc-root]').slice(0, 300)
  }
  finally {
    for (const id of owned) {
      try {
        const info = await manager.getSandboxInfo(id)
        requireFact(info.metadata?.['iteroom-r0-owner'] === owner, 'cleanup_ownership_mismatch')
        await manager.killSandbox(id)
        try { await manager.getSandboxInfo(id); throw failure('cleanup_unconfirmed') }
        catch (e) { if (e.statusCode !== 404) throw e }
        for (const label of ['opensandbox.io/id', 'opensandbox.io/egress-sidecar-for']) {
          const remaining = await docker(['ps', '-a', '--filter', `label=${label}=${id}`, '--format', '{{.ID}}'])
          requireFact(!remaining.stdout.trim(), 'cleanup_unconfirmed')
        }
        const volumes = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim().split(/\r?\n/)
        requireFact([...managedVolumes].every(name => !volumes.includes(name)), 'managed_volume_cleanup_unconfirmed')
        report.checks.managedVolumesDeleted = true
        report.checks.deletedAndDockerConfirmed = true
      } catch (caught) { cleanupError ??= caught }
    }
    await sandbox?.close(); await manager.close()
    await rm(hostFixture, { recursive: true, force: true })
  }
  if (error || cleanupError) return { ...report, status: 'failed', errorCode: error?.code ?? error?.error?.code ?? 'sandbox_probe_failed',
    ...(cleanupError ? { cleanupErrorCode: cleanupError.code ?? cleanupError.error?.code ?? 'cleanup_failed' } : {}) }
  return { ...report, status: 'passed' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await inspectSandboxRuntime(process.env.ITEROOM_SANDBOX_POC_ROOT,
    { authorized: process.env.ITEROOM_R0_SANDBOX_EXECUTE === '1' })
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.status === 'passed' ? 0 : 1
}
