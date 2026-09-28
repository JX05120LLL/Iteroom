import assert from 'node:assert/strict'
import { test } from 'node:test'

test('service ownership refuses a reused PID, different config and prior process', async () => {
  const { assertOwnedService } = await import('../scripts/r0/sandbox-service.mjs')
  const root = 'C:\\synthetic-poc', started = Date.parse('2026-09-27T12:00:00Z')
  const process = { ProcessId: 123, CommandLine: 'python from opensandbox_server.cli import main; main() --config C:\\synthetic-poc\\r0.toml', CreationDate: '2026-09-27T12:00:01Z' }
  assert.doesNotThrow(() => assertOwnedService(process, { pid: 123, root, started }))
  for (const changed of [{ ...process, ProcessId: 124 }, { ...process, CommandLine: 'unrelated python' },
    { ...process, CreationDate: '2026-09-27T11:59:00Z' }]) {
    assert.throws(() => assertOwnedService(changed, { pid: 123, root, started }), { code: 'service_ownership_mismatch' })
  }
})
test('network proof requires active packet enforcement and a successful same-target control', async () => {
  const { assertNetworkEvidence } = await import('../scripts/r0/sandbox-faults.mjs')
  const evidence = { status: 'ok', enforcementMode: 'dns+nft', deniedDns: true, allowedDns: true, allowedTcp: true, deniedIp: true }
  assert.doesNotThrow(() => assertNetworkEvidence(evidence))
  assert.throws(() => assertNetworkEvidence({ ...evidence, allowedTcp: false }), { code: 'network_control_unavailable' })
  assert.throws(() => assertNetworkEvidence({ ...evidence, allowedTcp: 'false' }), { code: 'network_control_unavailable' })
  assert.throws(() => assertNetworkEvidence({ ...evidence, enforcementMode: 'dns' }), { code: 'network_enforcement_unsupported' })
  assert.throws(() => assertNetworkEvidence({ ...evidence, deniedIp: false }), { code: 'network_policy_bypassed' })
})
test('occupied control port is refused before reading config or spawning a service', async () => {
  const { createOwnedService } = await import('../scripts/r0/sandbox-service.mjs')
  const { createServer } = await import('node:net')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r0-sandbox-service-'))
  const server = createServer()
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(3088, '127.0.0.1', done) })
    const service = await createOwnedService(root)
    await assert.rejects(service.start(), { code: 'service_port_in_use' })
    assert.equal(service.running, false)
  } finally { await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }) }
})
test('fault probe refuses unapproved execution before accessing an installation', async () => {
  const { inspectSandboxFaults } = await import('../scripts/r0/sandbox-faults.mjs')
  const report = await inspectSandboxFaults(process.cwd())
  assert.equal(report.errorCode, 'sandbox_execution_not_authorized')
  assert.equal(report.actualSandboxCreated, false)
})
test('TTL proof rejects early-only running status and a shorter command timeout', async () => {
  const { assertTtlEvidence } = await import('../scripts/r0/sandbox-faults.mjs')
  assert.throws(() => assertTtlEvidence({ runningBeforeExpiry: true, requestedSeconds: 60, commandTimeoutSeconds: 15 }), { code: 'ttl_execution_evidence_missing' })
  assert.doesNotThrow(() => assertTtlEvidence({ runningBeforeExpiry: true, parentAndChildAliveBeforeExpiry: true,
    lastAliveSecondsBeforeExpiry: 10, requestedSeconds: 60, commandTimeoutSeconds: 120 }))
})
test('an in-flight sidecar allocation or failed cleanup cannot authorize stopping the control service', async () => {
  const { cleanupDecision } = await import('../scripts/r0/sandbox-faults.mjs')
  assert.deepEqual(cleanupDecision({ allocationPending: true, observedApplications: 0, sidecarCreated: true }),
    { stopService: false, cleanupConfirmed: false })
  assert.deepEqual(cleanupDecision({ allocationPending: false, cleanupFailed: true }),
    { stopService: false, cleanupConfirmed: false })
  assert.deepEqual(cleanupDecision({ allocationPending: false, cleanupFailed: false }),
    { stopService: true, cleanupConfirmed: true })
})
test('allocation reconciliation requires matching owner and immutable runtime ID', async () => {
  const { allocationIdentity } = await import('../scripts/r0/sandbox-faults.mjs')
  const owner = 'a'.repeat(32), id = '00000000-0000-4000-8000-000000000001'
  assert.equal(allocationIdentity({ Config: { Labels: { 'iteroom-r0-owner': owner, 'opensandbox.io/id': id } } }, owner), id)
  assert.throws(() => allocationIdentity({ Config: { Labels: { 'iteroom-r0-owner': 'other', 'opensandbox.io/id': id } } }, owner), { code: 'sandbox_ownership_mismatch' })
  assert.throws(() => allocationIdentity({ Config: { Labels: { 'iteroom-r0-owner': owner, 'opensandbox.io/id': '../foreign' } } }, owner), { code: 'sandbox_ownership_mismatch' })
})
test('actual restart, cleanup retry, network controls and TTL have independent evidence', {
  skip: process.env.ITEROOM_R0_SANDBOX_FAULTS !== '1' && 'Explicit isolated fault execution required.',
}, async () => {
  const { inspectSandboxFaults } = await import('../scripts/r0/sandbox-faults.mjs')
  const report = await inspectSandboxFaults(process.env.ITEROOM_SANDBOX_POC_ROOT, { authorized: true })
  assert.equal(report.status, 'passed', `${report.failedStage}: ${report.errorCode}`)
  for (const key of ['restartWithoutReplay', 'cleanupFailureRecovered', 'networkPolicyEnforced', 'ttlReclaimed', 'ownedServiceStopped']) assert.ok(report.checks[key], key)
  assert.equal(report.modelCalled, false)
  assert.equal(report.peakApplicationSandboxes, 1)
  assert.equal(report.ttl.parentAndChildAliveBeforeExpiry, true)
  assert.ok(report.ttl.lastAliveSecondsBeforeExpiry <= 12)
  assert.ok(!/AppData|Users[\\/]|api_key|export function/.test(JSON.stringify(report)))
  const { writeFile } = await import('node:fs/promises'); const { join } = await import('node:path')
  const { validatePocRoot } = await import('../scripts/r0/sandbox-preflight.mjs')
  const root = await validatePocRoot(process.env.ITEROOM_SANDBOX_POC_ROOT)
  await writeFile(join(root, 'fault-verified-report.json'), JSON.stringify(report, null, 2) + '\n')
})
