import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { inspectSandboxPreflight, validatePocRoot, SANDBOX_PIN } from './sandbox-preflight.mjs'
import { createOwnedService } from './sandbox-service.mjs'
import { createOptions, shellCommand } from './sandbox-runtime.mjs'
import { controlledEnv, failure, runBounded } from './ocr-process.mjs'
import { sha256 } from './review-files.mjs'

const delay = ms => new Promise(done => setTimeout(done, ms))
function requireFact(value, code) { if (!value) throw failure(code) }
export function assertNetworkEvidence(evidence) {
  requireFact(evidence.status === 'ok' && evidence.enforcementMode === 'dns+nft', 'network_enforcement_unsupported')
  requireFact(evidence.allowedDns === true && evidence.allowedTcp === true, 'network_control_unavailable')
  requireFact(evidence.deniedDns === true && evidence.deniedIp === true, 'network_policy_bypassed')
}
export function allocationIdentity(runtime, owner) {
  const labels = runtime?.Config?.Labels, id = labels?.['opensandbox.io/id']
  requireFact(labels?.['iteroom-r0-owner'] === owner && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id ?? ''), 'sandbox_ownership_mismatch')
  return id
}
export function assertTtlEvidence(evidence) {
  requireFact(evidence.runningBeforeExpiry === true && evidence.parentAndChildAliveBeforeExpiry === true
    && Number.isFinite(evidence.lastAliveSecondsBeforeExpiry) && evidence.lastAliveSecondsBeforeExpiry >= 0
    && evidence.lastAliveSecondsBeforeExpiry <= 12 && evidence.commandTimeoutSeconds > evidence.requestedSeconds,
  'ttl_execution_evidence_missing')
}
export function cleanupDecision({ allocationPending, cleanupFailed }) {
  const confirmed = allocationPending === false && !cleanupFailed
  return { stopService: confirmed, cleanupConfirmed: confirmed }
}
export async function inspectSandboxFaults(value, { authorized = false } = {}) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), pin: SANDBOX_PIN,
    evidenceKind: 'actual-sandbox-service-outage-ttl-and-network', gateC: 'not_completed',
    modelCalled: false, userSourceRead: false, actualSandboxCreated: false, checks: {}, executions: [],
    peakApplicationSandboxes: 0, unverified: ['DSH-sandbox-tool-loop', 'real-model', 'other-platforms'] }
  if (!authorized) return { ...report, status: 'unavailable', errorCode: 'sandbox_execution_not_authorized' }
  const preflight = await inspectSandboxPreflight(value)
  if (preflight.status !== 'ready_for_poc') return { ...report, status: 'unavailable', errorCode: preflight.errorCode }
  const root = await validatePocRoot(value)
  try {
    const prior = JSON.parse(await readFile(join(root, 'owned-fault-sandboxes.json'), 'utf8'))
    if (prior.allocationPending || prior.cleanupConfirmed === false || prior.ids?.length) {
      return { ...report, status: 'unavailable', errorCode: 'prior_sandbox_cleanup_pending' }
    }
  } catch (error) { if (error.code !== 'ENOENT') return { ...report, status: 'unavailable', errorCode: 'invalid_allocation_journal' } }
  const service = await createOwnedService(root), owner = randomBytes(16).toString('hex')
  const images = JSON.parse(await readFile(join(root, 'images.json'), 'utf8'))
  const key = (await readFile(join(root, 'r0-key'), 'utf8')).trim()
  const sdk = await import(pathToFileURL(join(root, 'sdk/node_modules/@alibaba-group/opensandbox/dist/index.js')).href)
  const connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http', apiKey: key, useServerProxy: true,
    disableMetrics: true, requestTimeoutSeconds: 15 }
  const manager = sdk.SandboxManager.create({ connectionConfig }), owned = new Set(), volumes = new Map(), handles = []
  let allocationPending = false
  const factory = sdk.createDefaultAdapterFactory()
  const adapterFactory = { ...factory,
    createExecdStack: options => factory.createExecdStack({ ...options, connectionConfig: {
      ...options.connectionConfig, fetch: options.connectionConfig.fetch, sseFetch: globalThis.fetch } }),
    createEgressStack: options => factory.createEgressStack(options),
    createNetworkPolicyStack: options => factory.createNetworkPolicyStack(options),
    createLifecycleStack(options) {
      const stack = factory.createLifecycleStack(options)
      return { sandboxes: new Proxy(stack.sandboxes, { get(target, field) {
        if (field === 'createSandbox') return async (...args) => {
          let result
          try { result = await target.createSandbox(...args) }
          catch (error) {
            if ([401, 403, 422].includes(error.statusCode)) allocationPending = false
            throw error
          }
          requireFact(result.metadata?.['iteroom-r0-owner'] === owner, 'sandbox_ownership_mismatch')
          allocationPending = false
          owned.add(result.id); report.actualSandboxCreated = true
          report.peakApplicationSandboxes = Math.max(report.peakApplicationSandboxes, owned.size)
          await writeFile(join(root, 'owned-fault-sandboxes.json'), JSON.stringify({ owner, ids: [...owned] }))
          return result
        }
        const result = target[field]; return typeof result === 'function' ? result.bind(target) : result
      } }) }
    },
  }
  const docker = args => runBounded('docker', ['-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args],
    { cwd: root, env: controlledEnv(join(root, 'home')), timeoutMs: 15000 })
  const runtime = async id => {
    const result = JSON.parse((await docker(['inspect', `sandbox-${id}`, '--format', '{{json .}}'])).stdout)
    requireFact(result.Config.Labels['iteroom-r0-owner'] === owner, 'sandbox_ownership_mismatch')
    volumes.set(id, result.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name))
    return result
  }
  const absent = async id => {
    const started = Date.now()
    for (let attempt = 0; attempt < 60; attempt++) {
      let remaining = false
      for (const label of ['opensandbox.io/id', 'opensandbox.io/egress-sidecar-for']) {
        remaining ||= !!(await docker(['ps', '-a', '--filter', `label=${label}=${id}`, '--format', '{{.ID}}'])).stdout.trim()
      }
      const existing = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim().split(/\r?\n/)
      remaining ||= (volumes.get(id) ?? []).some(name => existing.includes(name))
      if (!remaining) {
        owned.delete(id)
        await writeFile(join(root, 'owned-fault-sandboxes.json'), JSON.stringify({ owner, ids: [...owned] }))
        return { polls: attempt + 1, durationMs: Date.now() - started }
      }
      await delay(250)
    }
    throw failure('runtime_reclamation_unconfirmed')
  }
  const remove = async id => {
    let exists = true
    try { requireFact((await manager.getSandboxInfo(id)).metadata?.['iteroom-r0-owner'] === owner, 'cleanup_ownership_mismatch') }
    catch (error) { if (error.statusCode !== 404) throw error; exists = false }
    if (exists) await manager.killSandbox(id)
    try { await manager.getSandboxInfo(id); throw failure('api_cleanup_unconfirmed') } catch (error) { if (error.statusCode !== 404) throw error }
    await absent(id)
  }
  let stage = 'start-service', error, cleanupError, allocationAttempted = false
  try {
    await service.start()
    const create = async ttl => {
      stage = 'create-sandbox'
      requireFact(owned.size === 0, 'parallel_sandbox_refused')
      allocationAttempted = true
      allocationPending = true
      await writeFile(join(root, 'owned-fault-sandboxes.json'), JSON.stringify({ owner, ids: [...owned], allocationPending: true }))
      const sb = await sdk.Sandbox.create({ ...createOptions(images['node:24-bookworm-slim'].digest, owner),
        timeoutSeconds: ttl, connectionConfig, adapterFactory })
      handles.push(sb); await runtime(sb.id); return sb
    }
    let sandbox = await create(300)
    const run = async (name, argv, options = {}) => {
      stage = name; let output = ''
      const append = msg => { output += msg.text; requireFact(Buffer.byteLength(output) <= 65536, 'output_limit') }
      const result = await sandbox.commands.run(shellCommand(argv), { timeoutSeconds: 15, ...options },
        { onStdout: append, onStderr: append, skipAccumulation: true })
      report.executions.push({ name, executionIdSha256: result.id && sha256(result.id), exitCode: result.exitCode ?? null,
        errorPresent: !!result.error, outputBytes: Buffer.byteLength(output), outputSha256: sha256(output) })
      return { ...result, output }
    }
    stage = 'network-capability'
    const response = await fetch(`http://127.0.0.1:3088/v1/sandboxes/${encodeURIComponent(sandbox.id)}/networkpolicy`,
      { headers: { 'OPEN-SANDBOX-API-KEY': key }, signal: AbortSignal.timeout(5000) })
    requireFact(response.ok, 'network_capability_unavailable')
    const capability = await response.json()
    const facts = { status: capability.status, enforcementMode: capability.enforcementMode }
    report.network = facts
    requireFact(facts.status === 'ok' && facts.enforcementMode === 'dns+nft', 'network_enforcement_unsupported')
    const dnsScript = 'import{resolve4}from"node:dns/promises";const timer=setTimeout(()=>{console.log(JSON.stringify({ok:false,code:"timeout"}));process.exit(0)},3000);try{const ips=await resolve4("example.com");clearTimeout(timer);console.log(JSON.stringify({ok:true,ip:ips[0]}))}catch(e){clearTimeout(timer);console.log(JSON.stringify({ok:false,code:e.code}))}'
    const dns = async name => { const result = await run(name, ['node', '-e', dnsScript]); requireFact(result.exitCode === 0, 'network_probe_failed'); return JSON.parse(result.output) }
    facts.deniedDns = !(await dns('deny-dns')).ok
    await sandbox.patchEgressRules([{ action: 'allow', target: 'example.com' }])
    const allowed = await dns('allow-dns-control'); facts.allowedDns = allowed.ok
    requireFact(allowed.ok && /^[0-9.]+$/.test(allowed.ip), 'network_control_unavailable')
    const tcpScript = 'import{connect}from"node:net";const socket=connect({host:process.argv[1],port:443});const finish=ok=>{console.log(JSON.stringify({ok}));socket.destroy()};socket.setTimeout(3000,()=>finish(false));socket.once("connect",()=>finish(true));socket.once("error",()=>finish(false));'
    const tcp = async name => { const result = await run(name, ['node', '-e', tcpScript, allowed.ip]); requireFact(result.exitCode === 0, 'network_probe_failed'); return JSON.parse(result.output).ok }
    facts.allowedTcp = await tcp('allow-tcp-control')
    await sandbox.deleteEgressRules(['example.com'])
    facts.deniedIp = !(await tcp('deny-direct-same-ip'))
    facts.sameTargetSha256 = sha256(allowed.ip)
    assertNetworkEvidence(facts); report.checks.networkPolicyEnforced = true
    const sentinel = 'import{spawn}from"node:child_process";import{writeFileSync,appendFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});appendFileSync("/tmp/starts.txt","start\\n");writeFileSync("/tmp/pids.json",JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);'
    const active = await run('restart-sentinel', ['node', '-e', sentinel], { background: true })
    requireFact(active.id, 'execution_id_missing')
    for (let attempt = 0; attempt < 30; attempt++) {
      try { if (await sandbox.files.readFile('/tmp/starts.txt') === 'start\n') break } catch (e) { if (e.statusCode !== 404) throw e }
      await delay(100)
    }
    stage = 'control-service-restart'
    await service.stop(); await service.start()
    sandbox = await sdk.Sandbox.connect({ sandboxId: sandbox.id, connectionConfig, adapterFactory }); handles.push(sandbox)
    requireFact((await sandbox.commands.getCommandStatus(active.id)).running === true, 'restart_execution_lost')
    requireFact(await sandbox.files.readFile('/tmp/starts.txt') === 'start\n', 'execution_replayed')
    await sandbox.commands.interrupt(active.id)
    requireFact((await sandbox.commands.getCommandStatus(active.id)).running === false, 'restart_stop_unconfirmed')
    report.restart = { executionIdSha256: sha256(active.id), reconnected: true, runningBeforeInterrupt: true, startCount: 1, replayed: false }
    report.checks.restartWithoutReplay = true
    stage = 'cleanup-outage'
    await service.stop()
    let failed = false
    try { await manager.killSandbox(sandbox.id) } catch { failed = true }
    requireFact(failed && (await runtime(sandbox.id)).State.Running, 'cleanup_failure_not_observed')
    report.cleanupFailure = { actualControlServiceOutage: true, deleteRequestFailed: true, resourceStillPresent: true, retryAfterRestart: true }
    await service.start(); await remove(sandbox.id)
    report.checks.cleanupFailureRecovered = true
    stage = 'ttl'
    sandbox = await create(60)
    const ttlActive = await run('ttl-parent-and-child', ['node', '-e', sentinel], { background: true, timeoutSeconds: 120 })
    requireFact(ttlActive.id && (await sandbox.commands.getCommandStatus(ttlActive.id)).running === true, 'ttl_execution_not_running')
    const expires = Date.parse((await sandbox.getInfo()).expiresAt)
    requireFact(Number.isFinite(expires), 'expiration_missing')
    while (Date.now() < expires - 10000) await delay(500)
    requireFact((await sandbox.commands.getCommandStatus(ttlActive.id)).running === true, 'ttl_execution_not_running')
    const aliveScript = 'import{readFileSync}from"node:fs";const pids=JSON.parse(readFileSync("/tmp/pids.json","utf8"));if(pids.length!==2)process.exit(1);for(const pid of pids){try{if(readFileSync("/proc/"+pid+"/stat","utf8").split(") ")[1].startsWith("Z"))process.exit(1)}catch{process.exit(1)}}'
    requireFact((await run('ttl-parent-and-child-alive-near-expiry', ['node', '-e', aliveScript])).exitCode === 0, 'ttl_descendants_not_running')
    const ttlEvidence = { requestedSeconds: 60, commandTimeoutSeconds: 120, runningBeforeExpiry: true,
      parentAndChildAliveBeforeExpiry: true, lastAliveSecondsBeforeExpiry: (expires - Date.now()) / 1000 }
    assertTtlEvidence(ttlEvidence)
    stage = 'ttl-expiration'
    let expired = false
    for (let attempt = 0; attempt < 140; attempt++) {
      try { await manager.getSandboxInfo(sandbox.id) } catch (e) { if (e.statusCode !== 404) throw e; expired = true; break }
      await delay(500)
    }
    requireFact(expired, 'ttl_not_reclaimed')
    const reclamation = await absent(sandbox.id)
    report.ttl = { ...ttlEvidence, executionIdSha256: sha256(ttlActive.id),
      expiredWithoutKill: true, apiNotFound: true, dockerAndVolumesAbsent: true, reclamation }
    report.checks.ttlReclaimed = true
  } catch (caught) {
    error = caught; report.failedStage = stage
    await writeFile(join(root, 'fault-debug.json'), JSON.stringify({ message: caught.message, stack: caught.stack,
      cause: caught.cause?.message, error: caught.error }))
  }
  finally {
    try {
      if (error && allocationAttempted) {
        // A create timeout does not prove the server made no allocation.
        // Keep this service alive while reconciling the persisted request owner.
        await delay(1000)
        const ids = (await docker(['ps', '-a', '--filter', `label=iteroom-r0-owner=${owner}`, '--format', '{{.ID}}'])).stdout.trim().split(/\r?\n/).filter(Boolean)
        for (const container of ids) {
          const actual = JSON.parse((await docker(['inspect', container, '--format', '{{json .}}'])).stdout)
          const id = allocationIdentity(actual, owner)
          owned.add(id); volumes.set(id, actual.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name))
          report.actualSandboxCreated = true
        }
        report.allocationReconciliation = { matchingRuntimeAllocations: ids.length, performedAfterFailure: true,
          serverCreateResponseConfirmed: !allocationPending }
      }
      if (owned.size && !service.running) await service.start()
      for (const id of [...owned]) await remove(id)
    } catch (caught) { cleanupError = caught }
    for (const handle of handles) await handle.close()
    await manager.close()
    const decision = cleanupDecision({ allocationPending, cleanupFailed: !!cleanupError })
    if (decision.stopService) {
      try { await service.stop(); report.checks.ownedServiceStopped = true } catch (caught) { cleanupError ??= caught }
    } else {
      cleanupError ??= failure('allocation_or_cleanup_unconfirmed')
      report.controlServiceRetainedForReconciliation = true
    }
    if (allocationAttempted) await writeFile(join(root, 'owned-fault-sandboxes.json'), JSON.stringify({ owner,
      ids: [...owned], allocationPending, cleanupConfirmed: !cleanupError && !allocationPending }))
    report.service = service.summary()
  }
  return { ...report, status: error || cleanupError ? 'failed' : 'passed',
    ...(error ? { errorCode: error.code ?? error.error?.code ?? (/Request timed out/.test(error.message) ? 'client_request_timeout' : 'sandbox_fault_probe_failed') } : {}),
    ...(cleanupError ? { cleanupErrorCode: cleanupError.code ?? 'cleanup_failed' } : {}) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await inspectSandboxFaults(process.env.ITEROOM_SANDBOX_POC_ROOT,
    { authorized: process.env.ITEROOM_R0_SANDBOX_FAULTS === '1' })
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.status === 'passed' ? 0 : 1
}
