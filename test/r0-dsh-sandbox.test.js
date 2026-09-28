import assert from 'node:assert/strict'
import { test } from 'node:test'

test('sandbox tool only accepts fixed actions and rejects host paths and commands before execution', async () => {
  const { validateAction } = await import('../scripts/r0/dsh-sandbox-tool.mjs')
  for (const action of ['repair', 'fail', 'wait']) assert.equal(validateAction({ action }), action)
  for (const args of [{ action: 'shell' }, { action: 'repair', path: '../outside' },
    { action: 'wait', command: 'anything' }, null, [], { action: 'repair', sandboxId: 'foreign' }]) {
    assert.throws(() => validateAction(args), { code: 'sandbox_action_denied' })
  }
})
test('combined probe refuses unapproved execution without reading private configuration', async () => {
  const { runDshSandboxProbe } = await import('../scripts/r0/dsh-sandbox-probe.mjs')
  const report = await runDshSandboxProbe(process.cwd())
  assert.equal(report.errorCode, 'sandbox_execution_not_authorized')
  assert.equal(report.actualSandbox, false)
})
test('public adapter forwarding retains prototype methods and endpoint authentication while replacing SSE fetch', async () => {
  const { forwardAdapterFactory } = await import('../scripts/r0/dsh-sandbox-tool.mjs')
  class Factory {
    createExecdStack(options) { return options }
    createLifecycleStack(options) { return options }
    createEgressStack(options) { return options }
    createNetworkPolicyStack(options) { return options }
  }
  const forwarded = forwardAdapterFactory(new Factory()), options = { endpointHeaders: { synthetic: 'header' }, connectionConfig: { disableMetrics: true } }
  for (const method of ['createLifecycleStack', 'createEgressStack', 'createNetworkPolicyStack']) assert.equal(forwarded[method](options), options)
  assert.deepEqual(forwarded.createExecdStack(options), { ...options, connectionConfig: { ...options.connectionConfig, sseFetch: globalThis.fetch } })
})
test('process evidence rejects invalid PIDs, access failures and malformed stat rather than treating them as stopped', async () => {
  const { verifyProcesses } = await import('../scripts/r0/dsh-sandbox-tool.mjs')
  const stat = pid => `${pid} (node) S 0`
  assert.equal(verifyProcesses([101, 102], stat, 'alive'), true)
  for (const pids of [[101], [101, 101], [-1, 102], ['101', 102]]) assert.throws(() => verifyProcesses(pids, stat, 'stopped'))
  assert.throws(() => verifyProcesses([101, 102], () => { throw Object.assign(Error('denied'), { code: 'EACCES' }) }, 'stopped'))
  assert.throws(() => verifyProcesses([101, 102], () => 'malformed', 'stopped'))
  assert.equal(verifyProcesses([101, 102], pid => { if (pid === 101) throw Object.assign(Error('gone'), { code: 'ENOENT' }); return `${pid} (node) Z 0` }, 'stopped'), true)
  assert.throws(() => verifyProcesses([101, 102], pid => `${pid} (node) Z 0`, 'alive'))
})
test('unknown volume inventory refuses confirmed cleanup and stopping the control service', async () => {
  const { dshCleanupDecision } = await import('../scripts/r0/dsh-sandbox-tool.mjs')
  assert.deepEqual(dshCleanupDecision({ allocationPending: false, cleanupFailed: false, resourceInventoryCaptured: false }),
    { stopService: false, cleanupConfirmed: false })
  assert.deepEqual(dshCleanupDecision({ allocationPending: false, cleanupFailed: false, resourceInventoryCaptured: true }),
    { stopService: true, cleanupConfirmed: true })
})
test('client cleanup still closes the manager when sandbox close fails', async () => {
  const { closeProbeClients } = await import('../scripts/r0/dsh-sandbox-probe.mjs')
  const calls = []
  const sandboxError = Object.assign(Error('sandbox close failed'), { code: 'sandbox_close_failed' })
  const error = await closeProbeClients(
    { async close() { calls.push('sandbox'); throw sandboxError } },
    { async close() { calls.push('manager') } },
  )
  assert.equal(error, sandboxError)
  assert.deepEqual(calls, ['sandbox', 'manager'])
})
test('official DSH loop invokes actual sandbox and preserves failures, cancellation and restart evidence', {
  skip: process.env.ITEROOM_R0_DSH_SANDBOX !== '1' && 'Explicit no-model sandbox authorization required.',
  timeout: 180000,
}, async t => {
  const { runDshSandboxProbe } = await import('../scripts/r0/dsh-sandbox-probe.mjs')
  const report = await runDshSandboxProbe(process.env.ITEROOM_SANDBOX_POC_ROOT, { authorized: true })
  assert.equal(report.status, 'passed', `${report.failedStage}: ${report.errorCode}`)
  assert.equal(report.actualSandbox, true)
  assert.equal(report.actualModel, false)
  assert.equal(report.gateA, 'not_completed')
  assert.equal(report.workspaceUnchanged, true)
  assert.deepEqual(report.toolRoster, ['iteroom_sandbox_probe'])
  await t.test('model sees successful remote test output and continues', () => {
    assert.equal(report.repair.toolExecutions, 1)
    assert.equal(report.repair.nextStepSawResult, true)
    assert.equal(report.repair.turnEnd, 'completed')
    assert.equal(report.repair.remoteExitCode, 0)
  })
  await t.test('nonzero remote command and guard rejection remain explicit', () => {
    assert.equal(report.failure.remoteExitCode, 7)
    assert.equal(report.failure.toolResultIsError, true)
    assert.equal(report.failure.nextStepSawError, true)
    assert.equal(report.denied.toolExecutions, 0)
    assert.equal(report.denied.guardDenials, 1)
  })
  await t.test('cancel confirms remote parent and child termination and DSH idle', () => {
    assert.equal(report.cancel.turnEnd, 'aborted')
    for (const key of ['signalObserved', 'parentAndChildAliveBeforeCancel', 'remoteStopped', 'descendantsStopped', 'whenIdleResolved']) assert.equal(report.cancel[key], true, key)
  })
  await t.test('restart preserves history without replaying completed or cancelled execution', () => {
    assert.equal(report.restart.historyPreserved, true)
    assert.equal(report.restart.remoteExecutionCountUnchanged, true)
    assert.equal(report.restart.startCount, 1)
    assert.equal(report.restart.toolExecutions, 0)
    assert.deepEqual(report.processExitCodes, [0, 0])
  })
  assert.equal(report.cleanup.runtimeAbsent, true)
  assert.equal(report.cleanup.resourceInventoryCaptured, true)
  assert.equal(report.cleanup.serviceStopped, true)
  assert.doesNotMatch(JSON.stringify(report), /AppData|apiKey|"sandboxId"|"owner"|Users[\\/]/)
  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await writeFile(join(process.env.ITEROOM_SANDBOX_POC_ROOT, 'dsh-sandbox-verified-report.json'), JSON.stringify(report, null, 2) + '\n')
})
