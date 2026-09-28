import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { inspectDshContract } from './dsh-contract.mjs'
import { runtime, DISABLED, persistedSessions } from './dsh-loop-probe.mjs'
import { PROVIDER, MODEL } from './fixtures/sandbox-plugin.mjs'
import { inspectSandboxPreflight, validatePocRoot, SANDBOX_PIN } from './sandbox-preflight.mjs'
import { createOwnedService } from './sandbox-service.mjs'
import { createOptions, shellCommand } from './sandbox-runtime.mjs'
import { allocationIdentity } from './sandbox-faults.mjs'
import { forwardAdapterFactory, processProbeSource, dshCleanupDecision } from './dsh-sandbox-tool.mjs'
import { controlledEnv, failure, runBounded } from './ocr-process.mjs'
import { sha256 } from './review-files.mjs'
import { validateApprovedModelConfig } from './model-cost-bound.mjs'

const delay = ms => new Promise(done => setTimeout(done, ms))
const requireFact = (value, code) => { if (!value) throw failure(code) }
function summary(events) {
  const end = events.findLast(event => event.type === 'turn/end')
  return { turnEnd: end?.data.reason.kind ?? 'missing', toolResultIsError: events.some(event => event.type === 'tool/result'
    && event.data.message.content.some(block => block.type === 'tool-result' && block.isError)) }
}
export function summarizeObservedUsage(events, expectedAttempts) {
  const usage = events.filter(event => event.type === 'assistant/message' && event.data?.usage)
    .map(event => event.data.usage)
  if (!Number.isSafeInteger(expectedAttempts) || expectedAttempts < 1 || expectedAttempts > 6
    || usage.length !== expectedAttempts || usage.some(item =>
      !Number.isSafeInteger(item.inputTokens) || item.inputTokens < 0
      || !Number.isSafeInteger(item.outputTokens) || item.outputTokens < 0
      || item.cacheReadTokens !== undefined && (!Number.isSafeInteger(item.cacheReadTokens) || item.cacheReadTokens < 0))) {
    throw failure('model_usage_incomplete')
  }
  const totals = { successfulSteps: usage.length,
    inputTokens: usage.reduce((sum, item) => sum + item.inputTokens, 0),
    cacheReadTokens: usage.reduce((sum, item) => sum + (item.cacheReadTokens ?? 0), 0),
    outputTokens: usage.reduce((sum, item) => sum + item.outputTokens, 0) }
  if (Object.values(totals).some(value => !Number.isSafeInteger(value))) throw failure('model_usage_incomplete')
  return totals
}
export async function closeProbeClients(sandbox, manager) {
  let error
  try { await sandbox?.close() } catch (caught) { error = caught }
  try { await manager.close() } catch (caught) { error ??= caught }
  return error
}
export async function runDshSandboxProbe(value, { authorized = false, realModel = false } = {}) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), pin: SANDBOX_PIN,
    evidenceKind: realModel ? 'official-dsh-cli-live-model-actual-sandbox-tool' : 'official-dsh-cli-mock-model-actual-sandbox-tool', gateA: 'not_completed',
    actualModel: false, actualSandbox: false, userSourceRead: false, cleanup: {},
    unverified: [...(realModel ? [] : ['real-model-tool-loop']), 'product-permission-approval',
      'product-crash-or-unknown-execution-recovery', 'browser', 'release'] }
  if (!authorized) return { ...report, status: 'unavailable', errorCode: realModel ? 'model_not_authorized' : 'sandbox_execution_not_authorized' }
  let modelConfigPath
  if (realModel) {
    if (!process.env.LOCALAPPDATA) return { ...report, status: 'unavailable', errorCode: 'model_config_unavailable' }
    modelConfigPath = join(process.env.LOCALAPPDATA, 'Iteroom', 'r0-model.json')
    try {
      const info = await lstat(modelConfigPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw failure('model_config_unsafe')
      validateApprovedModelConfig(JSON.parse(await readFile(modelConfigPath, 'utf8')))
    } catch (caught) { return { ...report, status: 'unavailable', errorCode: caught.code ?? 'model_config_unavailable' } }
  }
  const preflight = await inspectSandboxPreflight(value)
  if (preflight.status !== 'ready_for_poc') return { ...report, status: 'unavailable', errorCode: preflight.errorCode }
  const contract = await inspectDshContract()
  if (contract.status !== 'passed') return { ...report, status: 'unavailable', errorCode: 'dsh_contract_failed' }
  const root = await validatePocRoot(value), journal = join(root, 'owned-dsh-sandboxes.json')
  try {
    const previous = JSON.parse(await readFile(journal, 'utf8'))
    if (previous.allocationPending || previous.cleanupConfirmed === false || previous.ids?.length) return { ...report, status: 'unavailable', errorCode: 'prior_sandbox_cleanup_pending' }
  } catch (error) { if (error.code !== 'ENOENT') return { ...report, status: 'unavailable', errorCode: 'invalid_allocation_journal' } }
  const service = await createOwnedService(root), owner = randomBytes(16).toString('hex')
  const images = JSON.parse(await readFile(join(root, 'images.json'), 'utf8'))
  const key = (await readFile(join(root, 'r0-key'), 'utf8')).trim()
  const sdk = await import(pathToFileURL(join(root, 'sdk/node_modules/@alibaba-group/opensandbox/dist/index.js')).href)
  const connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http', apiKey: key, useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 15 }
  const manager = sdk.SandboxManager.create({ connectionConfig }), owned = new Set(), volumes = new Set(), allocated = new Set(), captured = new Set()
  let pending = false, attempted = false, sandbox, app, scratch, budgetRoot, error, cleanupError, stage = 'start-service'
  const saveJournal = () => writeFile(journal, JSON.stringify({ owner, ids: [...owned], allocatedIds: [...allocated],
    managedVolumes: [...volumes], allocationPending: pending, resourceInventoryCaptured: [...allocated].every(id => captured.has(id)), cleanupConfirmed: false }))
  const factory = sdk.createDefaultAdapterFactory()
  const adapterFactory = { ...forwardAdapterFactory(factory),
    createLifecycleStack(options) {
      const stack = factory.createLifecycleStack(options)
      return { sandboxes: new Proxy(stack.sandboxes, { get(target, field) {
        if (field === 'createSandbox') return async (...args) => {
          let result
          try { result = await target.createSandbox(...args) }
          catch (error) { if ([401, 403, 422].includes(error.statusCode)) pending = false; throw error }
          requireFact(result.metadata?.['iteroom-r0-owner'] === owner, 'sandbox_ownership_mismatch')
          owned.add(result.id); allocated.add(result.id); pending = false; await saveJournal(); report.actualSandbox = true
          // Capture managed volumes before SDK readiness/adapter failure may delete the allocation.
          await captureRuntime(`sandbox-${result.id}`)
          return result
        }
        const result = target[field]; return typeof result === 'function' ? result.bind(target) : result
      } }) }
    },
  }
  const docker = args => runBounded('docker', ['-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', ...args], { cwd: root,
    env: controlledEnv(join(root, 'home')), timeoutMs: 15000 })
  const captureRuntime = async container => {
    const actual = JSON.parse((await docker(['inspect', container, '--format', '{{json .}}'])).stdout)
    const id = allocationIdentity(actual, owner); owned.add(id); allocated.add(id)
    requireFact(Array.isArray(actual.Mounts), 'resource_inventory_missing')
    for (const mount of actual.Mounts) if (mount.Type === 'volume') volumes.add(mount.Name)
    captured.add(id)
    await saveJournal()
    return actual
  }
  try {
    await service.start()
    stage = 'create-sandbox'; attempted = true; pending = true; await saveJournal()
    sandbox = await sdk.Sandbox.create({ ...createOptions(images['node:24-bookworm-slim'].digest, owner), connectionConfig, adapterFactory })
    const actual = await captureRuntime(`sandbox-${sandbox.id}`)
    requireFact(actual.Mounts.every(mount => mount.Type !== 'bind') && !actual.Config.Env.some(item => item.includes(key)), 'host_bind_or_key_exposed')
    requireFact(await sandbox.isHealthy(), 'sandbox_not_ready')
    await sandbox.files.createDirectories([{ path: '/workspace', mode: 755 }])
    const fixture = { 'add.mjs': 'export const add = (a,b) => a-b;\n',
      'add.test.mjs': 'import{test}from"node:test";import assert from"node:assert/strict";import{add}from"./add.mjs";test("synthetic addition",()=>assert.equal(add(2,3),5));\n' }
    await sandbox.files.writeFiles(Object.entries(fixture).map(([path, data]) => ({ path: `/workspace/${path}`, data, mode: 644 })))
    scratch = await mkdtemp(join(tmpdir(), 'iteroom-r0-dsh-sandbox-'))
    if (realModel) budgetRoot = await mkdtemp(join(tmpdir(), 'iteroom-r0-model-budget-'))
    const workspace = join(scratch, 'workspace'), home = join(scratch, 'home')
    await mkdir(workspace); await mkdir(home)
    for (const [path, data] of Object.entries(fixture)) await writeFile(join(workspace, path), data)
    const hostHash = async () => sha256(JSON.stringify(await Promise.all((await readdir(workspace)).sort().map(async path => [path, sha256(await readFile(join(workspace, path)))]))))
    const inputHash = await hostHash()
    const privateConfig = join(home, 'sandbox-config.json'), metricsFile = join(home, realModel ? 'live-metrics.json' : 'sandbox-metrics.json'), patch = join(scratch, 'sandbox.patch.yml')
    await writeFile(privateConfig, JSON.stringify({ root, sandboxId: sandbox.id, owner,
      ...(realModel ? { modelConfigPath, budgetRoot } : {}) }))
    const pluginPath = fileURLToPath(new URL(realModel ? './fixtures/live-model-plugin.mjs' : './fixtures/sandbox-plugin.mjs', import.meta.url))
    await writeFile(patch, DISABLED.map(id => `- id: ${id}\n  disabled: true`).join('\n')
      + '\n- id: tools\n  config:\n    mode: native\n'
      + `- insert:\n    - id: iter-room-sandbox-probe\n      name: ${JSON.stringify(pluginPath)}\n      config:\n        privateConfig: ${JSON.stringify(privateConfig)}\n`)
    app = runtime(workspace, home, patch, { timeoutMs: realModel ? 120000 : 10000 })
    const initialize = () => app.request('initialize', { cwd: workspace,
      provider: realModel ? 'deepseek-official' : PROVIDER, model: realModel ? 'deepseek-flash' : MODEL, maxTokens: 128 })
    stage = 'dsh-initialize'; await initialize()
    if (realModel) {
      stage = 'dsh-live-repair'
      const liveEvents = await app.prompt('r0-live-repair', 'Only synthetic fixtures are in scope. First call iteroom_read_fixture with path src/greet.ts. Then call iteroom_sandbox_probe with action repair exactly once. Read the tool result and briefly report the actual test exit code. Do not invent execution or call any other tool.')
      const firstCode = await app.stop()
      const firstMetrics = JSON.parse(await readFile(metricsFile, 'utf8'))
      const before = await persistedSessions(join(home, 'sessions'))
      const beforeActions = await sandbox.files.readFile('/workspace/actions.txt')
      stage = 'dsh-live-restart'
      await writeFile(patch, (await readFile(patch, 'utf8')) + '        resume: true\n')
      app = runtime(workspace, home, patch, { timeoutMs: 120000 }); await initialize()
      const secondCode = await app.stop()
      const after = await persistedSessions(join(home, 'sessions'))
      const secondMetrics = JSON.parse(await readFile(metricsFile, 'utf8'))
      const afterActions = await sandbox.files.readFile('/workspace/actions.txt')
      const observedUsage = summarizeObservedUsage(liveEvents, firstMetrics.modelAttempts)
      const lastTool = liveEvents.findLastIndex(event => event.type === 'tool/result')
      const nextStepSawResult = lastTool >= 0 && liveEvents.slice(lastTool + 1).some(event => event.type === 'assistant/message' && !!event.data.usage)
      const historyPreserved = [...before].every(([id, events]) => JSON.stringify(after.get(id)?.slice(0, events.length)) === JSON.stringify(events))
      Object.assign(report, { inventory: contract.inventory, actualModel: true,
        toolRoster: firstMetrics.toolRoster, modelRequests: firstMetrics.modelAttempts,
        worstCostCny: firstMetrics.worstCostCny, observedUsage,
        workspaceUnchanged: inputHash === await hostHash(), inputSha256: inputHash,
        processExitCodes: [firstCode, secondCode], repair: {
          ...summary(liveEvents), readExecutions: firstMetrics.readExecutions,
          ...firstMetrics.sandbox, nextStepSawResult },
        restart: { historyPreserved, remoteExecutionCountUnchanged: beforeActions === afterActions,
          modelRequestCountUnchanged: firstMetrics.modelAttempts === secondMetrics.modelAttempts,
          remoteActionCount: afterActions.trim().split('\n').length },
        persistence: { sessions: after.size, contiguousSequences: [...after.values()].every(events => events.every((event, i) => event.seq === i)) },
      })
      requireFact(report.actualModel && report.toolRoster.length === 2 && report.toolRoster.includes('iteroom_read_fixture')
        && report.toolRoster.includes('iteroom_sandbox_probe') && report.modelRequests >= 2 && report.modelRequests <= 6
        && report.worstCostCny < 5 && report.observedUsage.successfulSteps >= 2 && report.workspaceUnchanged
        && report.repair.readExecutions === 1 && report.repair.toolExecutions === 1
        && report.repair.remoteExitCode === 0 && report.repair.nextStepSawResult && report.repair.turnEnd === 'completed'
        && report.restart.historyPreserved && report.restart.remoteExecutionCountUnchanged
        && report.restart.modelRequestCountUnchanged && report.restart.remoteActionCount === 1
        && report.persistence.sessions === 1 && report.persistence.contiguousSequences
        && firstCode === 0 && secondCode === 0, 'dsh_live_evidence_incomplete')
    } else {
    stage = 'dsh-repair'; const repairEvents = await app.prompt('r0-sandbox-repair', 'R0_REPAIR')
    stage = 'dsh-command-failure'; const failureEvents = await app.prompt('r0-sandbox-fail', 'R0_FAIL')
    stage = 'dsh-guard'; const deniedEvents = await app.prompt('r0-sandbox-denied', 'R0_DENIED')
    stage = 'dsh-tool-cancel'; const cancelEvents = await app.prompt('r0-sandbox-cancel', 'R0_CANCEL')
    const firstCode = await app.stop()
    const firstMetrics = JSON.parse(await readFile(metricsFile, 'utf8')), before = await persistedSessions(join(home, 'sessions'))
    const beforeActions = await sandbox.files.readFile('/workspace/actions.txt')
    requireFact(beforeActions === 'repair\nfail\nwait\n', 'remote_action_count_mismatch')
    stage = 'dsh-restart'
    await writeFile(patch, (await readFile(patch, 'utf8')) + '        resume: true\n')
    app = runtime(workspace, home, patch); await initialize()
    const secondCode = await app.stop(), secondMetrics = JSON.parse(await readFile(metricsFile, 'utf8'))
    const after = await persistedSessions(join(home, 'sessions'))
    const historyPreserved = [...before].every(([id, events]) => JSON.stringify(after.get(id)?.slice(0, events.length)) === JSON.stringify(events))
    const afterActions = await sandbox.files.readFile('/workspace/actions.txt'), starts = await sandbox.files.readFile('/workspace/starts.txt')
    const verify = await sandbox.commands.run(shellCommand(['node', '-e', processProbeSource('stopped')]), { timeoutSeconds: 10 })
    requireFact(verify.exitCode === 0 && !verify.error, 'restart_cancelled_descendants_alive')
    Object.assign(report, { inventory: contract.inventory, toolRoster: firstMetrics.toolRoster,
      workspaceUnchanged: inputHash === await hostHash(), inputSha256: inputHash,
      processExitCodes: [firstCode, secondCode], repair: { ...firstMetrics.cases.R0_REPAIR, ...summary(repairEvents) },
      failure: { ...firstMetrics.cases.R0_FAIL, ...summary(failureEvents) },
      denied: { ...firstMetrics.cases.R0_DENIED, ...summary(deniedEvents) },
      cancel: { ...firstMetrics.cases.R0_CANCEL, ...summary(cancelEvents) },
      restart: { ...secondMetrics.cases.R0_RESUME, historyPreserved,
        remoteExecutionCountUnchanged: beforeActions === afterActions, remoteActionCount: afterActions.trim().split('\n').length,
        startCount: starts === 'start\n' ? 1 : -1, cancelledDescendantsStillStopped: true },
      persistence: { sessions: after.size, contiguousSequences: [...after.values()].every(events => events.every((event, i) => event.seq === i)) },
    })
    requireFact(report.toolRoster.length === 1 && report.toolRoster[0] === 'iteroom_sandbox_probe' && report.workspaceUnchanged
      && report.repair.remoteExitCode === 0 && report.repair.nextStepSawResult && report.repair.toolExecutions === 1 && report.repair.turnEnd === 'completed'
      && report.failure.remoteExitCode === 7 && report.failure.toolResultIsError && report.failure.nextStepSawError
      && report.denied.toolExecutions === 0 && report.denied.guardDenials === 1 && report.denied.toolResultIsError
      && report.cancel.turnEnd === 'aborted' && report.cancel.signalObserved && report.cancel.parentAndChildAliveBeforeCancel && report.cancel.remoteStopped && report.cancel.descendantsStopped && report.cancel.whenIdleResolved
      && report.restart.toolExecutions === 0 && report.restart.historySawTool && historyPreserved && beforeActions === afterActions && starts === 'start\n'
      && report.persistence.sessions === 4 && report.persistence.contiguousSequences && firstCode === 0 && secondCode === 0, 'dsh_sandbox_evidence_incomplete')
    }
  } catch (caught) {
    error = caught; report.failedStage = stage
    await writeFile(join(root, realModel ? 'dsh-live-debug.json' : 'dsh-sandbox-debug.json'), realModel
      ? JSON.stringify({ stage, code: caught.code ?? 'probe_failed' })
      : JSON.stringify({ message: caught.message, stack: caught.stack, cause: caught.cause }))
  } finally {
    try { await app?.dispose() } catch (caught) { cleanupError = caught }
    if (realModel && budgetRoot) {
      try { report.modelRequests ??= JSON.parse(await readFile(join(budgetRoot, 'budget.json'), 'utf8')).attempts }
      catch { report.budgetRecordUnavailable = true }
    }
    try {
      if (error && attempted) {
        const containers = (await docker(['ps', '-a', '--filter', `label=iteroom-r0-owner=${owner}`, '--format', '{{.ID}}'])).stdout.trim().split(/\r?\n/).filter(Boolean)
        for (const id of containers) { await captureRuntime(id); report.actualSandbox = true }
      }
      for (const id of owned) {
        let exists = true
        try { requireFact((await manager.getSandboxInfo(id)).metadata?.['iteroom-r0-owner'] === owner, 'cleanup_ownership_mismatch') }
        catch (caught) { if (caught.statusCode !== 404) throw caught; exists = false }
        if (exists) await manager.killSandbox(id)
        try { await manager.getSandboxInfo(id); throw failure('api_cleanup_unconfirmed') } catch (caught) { if (caught.statusCode !== 404) throw caught }
        let absent = false
        for (let i = 0; i < 60; i++) {
          const appIds = (await docker(['ps', '-a', '--filter', `label=opensandbox.io/id=${id}`, '--format', '{{.ID}}'])).stdout.trim()
          const sidecars = (await docker(['ps', '-a', '--filter', `label=opensandbox.io/egress-sidecar-for=${id}`, '--format', '{{.ID}}'])).stdout.trim()
          const allVolumes = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).stdout.trim().split(/\r?\n/)
          if (!appIds && !sidecars && ![...volumes].some(name => allVolumes.includes(name))) { absent = true; break }
          await delay(250)
        }
        requireFact(absent, 'runtime_cleanup_unconfirmed'); owned.delete(id)
      }
      report.cleanup.runtimeAbsent = attempted && !pending && owned.size === 0 && [...allocated].every(id => captured.has(id))
    } catch (caught) { cleanupError ??= caught }
    const closeError = await closeProbeClients(sandbox, manager)
    cleanupError ??= closeError
    report.cleanup.resourceInventoryCaptured = [...allocated].every(id => captured.has(id))
    const decision = dshCleanupDecision({ allocationPending: pending, cleanupFailed: !!cleanupError,
      resourceInventoryCaptured: report.cleanup.resourceInventoryCaptured })
    if (decision.stopService) {
      try { await service.stop(); report.cleanup.serviceStopped = true } catch (caught) { cleanupError ??= caught }
    } else { cleanupError ??= failure('allocation_or_cleanup_unconfirmed'); report.cleanup.controlServiceRetained = true }
    if (attempted) await writeFile(journal, JSON.stringify({ owner, ids: [...owned], allocatedIds: [...allocated], managedVolumes: [...volumes],
      allocationPending: pending, resourceInventoryCaptured: report.cleanup.resourceInventoryCaptured, cleanupConfirmed: !cleanupError && !pending }))
    if (scratch && !cleanupError && (!realModel || !error)) {
      requireFact(dirname(resolve(scratch)) === resolve(tmpdir()) && scratch.startsWith(join(tmpdir(), 'iteroom-r0-dsh-sandbox-')), 'unmanaged_probe_cleanup')
      await rm(scratch, { recursive: true, force: true })
    }
    if (budgetRoot && !error && !cleanupError) {
      requireFact(dirname(resolve(budgetRoot)) === resolve(tmpdir()) && budgetRoot.startsWith(join(tmpdir(), 'iteroom-r0-model-budget-')), 'unmanaged_budget_cleanup')
      await rm(budgetRoot, { recursive: true, force: true })
      report.cleanup.budgetRootRemoved = true
    }
    report.service = service.summary()
  }
  return { ...report, gateA: realModel && !error && !cleanupError ? 'passed_limited' : 'not_completed',
    status: error || cleanupError ? 'failed' : 'passed',
    ...(error ? { errorCode: error.code ?? 'dsh_sandbox_probe_failed' } : {}), ...(cleanupError ? { cleanupErrorCode: cleanupError.code ?? 'cleanup_failed' } : {}) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runDshSandboxProbe(process.env.ITEROOM_SANDBOX_POC_ROOT, {
    authorized: process.env.ITEROOM_R0_DSH_SANDBOX === '1', realModel: process.env.ITEROOM_R0_LIVE_MODEL === '1' })
  process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'passed' ? 0 : 1
}
