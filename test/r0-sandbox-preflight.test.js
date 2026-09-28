import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('sandbox preflight refuses actual project and redirected installation roots before access', async t => {
  const { validatePocRoot } = await import('../scripts/r0/sandbox-preflight.mjs')
  await assert.rejects(validatePocRoot(process.cwd()), { code: 'unmanaged_sandbox_poc' })
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r0-sandbox-test-'))
  const external = await mkdtemp(join(tmpdir(), 'iteroom-r0-sandbox-external-'))
  t.after(() => rm(root, { recursive: true, force: true })); t.after(() => rm(external, { recursive: true, force: true }))
  await mkdir(join(root, 'sdk')); await symlink(external, join(root, 'sdk/node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(validatePocRoot(root), { code: 'unmanaged_sandbox_poc' })
})
test('missing installed SDK is unavailable and cannot count as Gate C verification', async t => {
  const { inspectSandboxPreflight } = await import('../scripts/r0/sandbox-preflight.mjs')
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r0-sandbox-empty-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const report = await inspectSandboxPreflight(root)
  assert.equal(report.status, 'unavailable'); assert.equal(report.gateC, 'not_completed')
  assert.equal(report.sdkInstalled, false); assert.equal(report.actualSandboxCreated, false)
  assert.ok(!JSON.stringify(report).includes(root))
})
test('installed real SDK contracts and actual Docker preflight report separate evidence', {
  skip: !process.env.ITEROOM_SANDBOX_POC_ROOT && 'Isolated real SDK/server installation required.',
}, async () => {
  const { inspectSandboxPreflight } = await import('../scripts/r0/sandbox-preflight.mjs')
  const report = await inspectSandboxPreflight(process.env.ITEROOM_SANDBOX_POC_ROOT)
  assert.equal(report.sdkInstalled, true); assert.equal(report.sdkVersion, '1.1.0')
  assert.equal(report.sdkTelemetryDisabled, true); assert.equal(report.sdkPublicContracts, true)
  assert.equal(report.gateC, 'not_completed'); assert.equal(report.actualSandboxCreated, false)
  assert.ok(['ready_for_poc', 'unavailable'].includes(report.status))
  assert.ok(!/AppData|Users[\\/]|api_key|r0-key/.test(JSON.stringify(report)))
})
