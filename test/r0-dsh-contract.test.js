import assert from 'node:assert/strict'
import { test } from 'node:test'

const modulePath = '../scripts/r0/dsh-contract.mjs'
const load = () => import(modulePath)
const core = [
  ['agent', '@deepseek-ai/dsh-agent'], ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
  ['session', '@deepseek-ai/dsh-session'], ['sessions', '@deepseek-ai/dsh-session-persistence-jsonl'],
  ['llm', '@deepseek-ai/dsh-llm'], ['tools', '@deepseek-ai/dsh-tools'],
  ['system-prompt', '@deepseek-ai/dsh-system-prompt'], ['session-projection', '@deepseek-ai/dsh-session-projection'],
].map(([id, name]) => ({ id, name }))

test('configuration parsing keeps executable YAML inert', async () => {
  const { parseConfigDump } = await load()
  const rows = parseConfigDump('- id: probe\n  name: "@deepseek-ai/dsh-tools"\n  disabled: !!js (() => { throw new Error("must not execute") })()\n')
  assert.equal(rows[0].id, 'probe')
  assert.notEqual(rows[0].disabled, true)
})

test('malformed rows and duplicate identifiers are rejected', async () => {
  const { parseConfigDump } = await load()
  assert.throws(() => parseConfigDump('credentials: secret'), /array/i)
  assert.throws(() => parseConfigDump('- id: x\n  name: "@deepseek-ai/dsh-tools"\n- id: x\n  name: "@deepseek-ai/dsh-tools"\n'), /duplicate/i)
  assert.throws(() => parseConfigDump('- id: x\n  name: 3\n'), /name/i)
  assert.throws(() => parseConfigDump('- id: x\n  name: "@deepseek-ai/dsh-tools"\n  disabled: yes\n'), /disabled/i)
})

test('an unknown disabled expression does not count as disabled', async () => {
  const { parseConfigDump, assessConfiguration } = await load()
  const row = parseConfigDump('- id: unsafe\n  name: "@deepseek-ai/dsh-tool-fs"\n  disabled: !!js process.platform === "win32"\n')[0]
  assert.deepEqual(assessConfiguration([...core, row]).hostExecution, ['unsafe'])
})

test('all host providers and additional tool plugins must be disabled', async () => {
  const { assessConfiguration } = await load()
  const rows = [...core, { id: 'new-shell', name: '@deepseek-ai/dsh-tool-bash', disabled: false }, { id: 'executor', name: '@deepseek-ai/dsh-subprocess-local' }]
  assert.deepEqual(assessConfiguration(rows).hostExecution, ['new-shell', 'executor'])
  assert.deepEqual(assessConfiguration(rows.map(r => r.id === 'new-shell' || r.id === 'executor' ? { ...r, disabled: true } : r)).hostExecution, [])
})

test('an unfamiliar plugin cannot silently become an execution escape route', async () => {
  const { assessConfiguration } = await load()
  assert.deepEqual(assessConfiguration([...core, { id: 'unknown-provider', name: '@deepseek-ai/dsh-custom-executor' }]).hostExecution, ['unknown-provider'])
})

test('missing or disabled engine services are not reported as ready', async () => {
  const { assessConfiguration } = await load()
  const missing = assessConfiguration(core.filter(r => r.id !== 'tools'))
  assert.ok(missing.missingCore.includes('@deepseek-ai/dsh-tools'))
  const disabled = assessConfiguration(core.map(r => r.id === 'agent-loop' ? { ...r, disabled: true } : r))
  assert.ok(disabled.missingCore.includes('@deepseek-ai/dsh-agent-loop'))
  const conditional = assessConfiguration(core.map(r => r.id === 'llm' ? { ...r, disabled: { expressionNotEvaluated: true } } : r))
  assert.ok(conditional.missingCore.includes('@deepseek-ai/dsh-llm'))
})

test('oversized and unknown-tag configuration is rejected', async () => {
  const { parseConfigDump } = await load()
  assert.throws(() => parseConfigDump('x'.repeat(1024 * 1024 + 1)), /exceeds/i)
  assert.throws(() => parseConfigDump('- id: probe\n  name: !unknown x\n'))
})

test('fixed versions must match the inspected inventory', async () => {
  const { checkVersions } = await load()
  assert.deepEqual(checkVersions([{ name: '@deepseek-ai/cordis', version: '4.0.2' }, { name: '@deepseek-ai/dsh-tools', version: '0.1.5-rc.3' }]), [])
  assert.deepEqual(checkVersions([{ name: '@deepseek-ai/cordis', version: '4.0.3' }]), ['@deepseek-ai/cordis'])
})

test('supported CLI composes a host-disabled probe without claiming runtime readiness', { timeout: 30000 }, async () => {
  const { inspectDshContract } = await load()
  const report = await inspectDshContract()
  assert.equal(report.status, 'passed')
  assert.equal(report.gateA, 'not_completed')
  assert.equal(report.evidenceKind, 'offline-contract-and-cli-config')
  assert.ok(report.defaultConfiguration.hostExecution.includes('persistent-pwsh'))
  assert.deepEqual(report.probeConfiguration.hostExecution, [])
  assert.deepEqual(report.probeConfiguration.missingCore, [])
  assert.equal(report.appBooted, false)
  const body = JSON.stringify(report)
  assert.doesNotMatch(body, /apiKey|DEEPSEEK_API_KEY|DSH_HOME|[A-Z]:\\\\|Users\\\\/)
})
