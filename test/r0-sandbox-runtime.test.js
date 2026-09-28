import assert from 'node:assert/strict'
import { test } from 'node:test'
test('sandbox command conversion preserves quotes and shell metacharacters as literal argv', async () => {
  const { shellCommand } = await import('../scripts/r0/sandbox-runtime.mjs')
  assert.equal(shellCommand(['node', "a'b", '$HOME; echo unsafe']), "'node' 'a'\\''b' '$HOME; echo unsafe'")
  assert.throws(() => shellCommand([]), { code: 'invalid_sandbox_command' })
  assert.throws(() => shellCommand(['node', '\0']), { code: 'invalid_sandbox_command' })
})
test('sandbox requests require a fixed public Node image and synthetic ownership without host mounts', async () => {
  const { createOptions } = await import('../scripts/r0/sandbox-runtime.mjs')
  assert.throws(() => createOptions('node:24', 'synthetic-owner'), { code: 'invalid_sandbox_image' })
  assert.throws(() => createOptions('private@sha256:' + 'a'.repeat(64), 'synthetic-owner'), { code: 'invalid_sandbox_image' })
  const options = createOptions('node@sha256:' + 'a'.repeat(64), 'a'.repeat(32))
  assert.deepEqual(options.resource, { cpu: '1', memory: '512Mi' })
  assert.deepEqual(options.volumes, [])
  assert.deepEqual(options.networkPolicy, { defaultAction: 'deny', egress: [] })
  assert.equal(options.timeoutSeconds, 300)
})
test('runtime refuses execution without explicit run authorization before checking an installation', async () => {
  const { inspectSandboxRuntime } = await import('../scripts/r0/sandbox-runtime.mjs')
  const report = await inspectSandboxRuntime(process.cwd())
  assert.equal(report.errorCode, 'sandbox_execution_not_authorized')
  assert.equal(report.actualSandboxCreated, false); assert.equal(report.gateC, 'not_completed')
})
test('actual sandbox lifecycle and command failures remain distinct from model and product completion', {
  skip: process.env.ITEROOM_R0_SANDBOX_EXECUTE !== '1' && 'Explicit isolated real sandbox execution required.',
}, async () => {
  const { inspectSandboxRuntime } = await import('../scripts/r0/sandbox-runtime.mjs')
  const report = await inspectSandboxRuntime(process.env.ITEROOM_SANDBOX_POC_ROOT, { authorized: true })
  assert.equal(report.status, 'passed', report.errorCode)
  assert.equal(report.actualSandboxCreated, true); assert.equal(report.modelCalled, false)
  assert.ok(report.checks.importModifyTestExport)
  assert.ok(report.checks.hostInputUnchanged)
  assert.equal(report.hostInput.files, 2)
  assert.equal(report.hostInput.beforeSha256, report.hostInput.afterSha256)
  assert.ok(report.checks.literalArgvPreserved)
  assert.ok(report.checks.foregroundDescendantsStopped)
  assert.ok(report.checks.timeoutDescendantsStopped)
  assert.ok(report.checks.disconnectReconciledWithoutReplay)
  assert.ok(report.checks.managedVolumesDeleted)
  assert.ok(report.checks.deletedAndDockerConfirmed)
  assert.equal(report.gateC, 'not_completed')
  assert.ok(!/AppData|Users[\\/]|export function|api_key|r0-key/.test(JSON.stringify(report)))
})
