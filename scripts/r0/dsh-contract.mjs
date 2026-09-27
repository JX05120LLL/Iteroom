import { execFile } from 'node:child_process'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const exec = promisify(execFile)
const dshManifestPath = require.resolve('@deepseek-ai/dsh/package.json')
const dshRoot = dirname(dshManifestPath)
// Use the CLI's existing parser, not an additional product dependency.
const yaml = require(require.resolve('js-yaml', { paths: [dshRoot] }))
const expressionSchema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar', construct: () => Object.freeze({ expressionNotEvaluated: true }),
  }),
])

const CORE = [
  '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-session-projection',
]
const LOOP_SERVICES = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt', 'sessionProjections']
const HOST_IDS = ['sandbox', 'sandbox-policy', 'subprocess', 'pty', 'terminal-bash',
  'terminal-pwsh', 'jobs', 'persistent-bash', 'persistent-pwsh']
const HOST_PROVIDERS = new Set([
  '@deepseek-ai/dsh-sandbox-local', '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-subprocess-local', '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-terminal', '@deepseek-ai/dsh-terminal-bash',
])
// Fixed-profile roster: an unfamiliar plugin needs review, not an inferred exemption.
const NON_EXECUTION_ROWS = new Set([...CORE,
  '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions', '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek', '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/cordis-plugin-timer', '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-llm-retry', '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-session/invariant', '@deepseek-ai/dsh-agent/invariant',
  '@deepseek-ai/dsh-scope/invariant', '@deepseek-ai/dsh-agent-loop/invariant',
])

export function parseConfigDump(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) {
    throw new Error('Configuration input is invalid or exceeds 1 MiB')
  }
  const rows = yaml.load(text, { schema: expressionSchema })
  if (!Array.isArray(rows) || !rows.length) throw new Error('Configuration must be a nonempty array')
  const ids = new Set()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || typeof row.id !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(row.id)) {
      throw new Error('Invalid configuration row id')
    }
    if (ids.has(row.id)) throw new Error('Duplicate configuration id')
    ids.add(row.id)
    if (typeof row.name !== 'string' || !/^@deepseek-ai\/[a-zA-Z0-9._/-]+$/.test(row.name)) {
      throw new Error('Invalid configuration row name')
    }
    if (row.disabled !== undefined && typeof row.disabled !== 'boolean'
      && row.disabled?.expressionNotEvaluated !== true) throw new Error('Invalid disabled value')
  }
  return rows
}

export function assessConfiguration(rows) {
  const enabled = rows.filter(row => row.disabled !== true)
  const certain = rows.filter(row => row.disabled === undefined || row.disabled === false)
  return {
    rowCount: rows.length,
    missingCore: CORE.filter(name => !certain.some(row => row.name === name)),
    // Unknown expressions are conservatively treated as potentially enabled.
    hostExecution: enabled.filter(row => HOST_PROVIDERS.has(row.name)
      || row.name.startsWith('@deepseek-ai/dsh-tool-')
      || !NON_EXECUTION_ROWS.has(row.name)).map(row => row.id),
  }
}

export function checkVersions(inventory) {
  return inventory.filter(item => item.version !== (item.name === '@deepseek-ai/cordis'
    ? '4.0.2' : '0.1.5-rc.3')).map(item => item.name)
}

async function manifest(name) {
  const value = JSON.parse(await readFile(require.resolve(name + '/package.json'), 'utf8'))
  if (value.name !== name || typeof value.version !== 'string') throw new Error('Invalid package manifest')
  return { name: value.name, version: value.version }
}

async function inspectProfile() {
  const parent = resolve(tmpdir())
  const scratch = await mkdtemp(join(parent, 'iteroom-r0-dsh-'))
  try {
    const workspace = join(scratch, 'workspace')
    await mkdir(workspace)
    const overlay = join(scratch, 'probe.patch.yml')
    await writeFile(overlay, HOST_IDS.map(id => `- id: ${id}\n  disabled: true`).join('\n') + '\n')
    const env = { DSH_HOME: join(scratch, 'home') }
    // No provider credentials, user DSH config, proxy or prompt overrides.
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value
    }
    const options = { cwd: workspace, env, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }
    const cli = join(dshRoot, 'lib/bin.js')
    const baseline = await exec(process.execPath, [cli, '--profile', 'sdk-minimal', '--dump-default-config'], options)
    const patched = await exec(process.execPath, [cli, '--profile', 'sdk-minimal', '--patch', overlay, '--dump-config'], options)
    if (baseline.stderr.trim() || patched.stderr.trim()) throw new Error('CLI composition produced diagnostics')
    return {
      defaultConfiguration: assessConfiguration(parseConfigDump(baseline.stdout)),
      probeConfiguration: assessConfiguration(parseConfigDump(patched.stdout)),
    }
  } finally {
    // Only remove this tool's freshly created, verified sibling below tmpdir.
    if (dirname(resolve(scratch)) !== parent || !scratch.startsWith(join(parent, 'iteroom-r0-dsh-'))) {
      throw new Error('Refusing cleanup outside the owned temporary directory')
    }
    await rm(scratch, { recursive: true, force: true })
  }
}

export async function inspectDshContract() {
  const inventory = await Promise.all(['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/dsh-sdk-minimal', ...CORE].map(manifest))
  const versionMismatches = checkVersions(inventory)
  const base = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    evidenceKind: 'offline-contract-and-cli-config', gateA: 'not_completed', appBooted: false,
    environment: { platform: process.platform, node: process.version }, inventory, versionMismatches,
  }
  if (versionMismatches.length) return { ...base, status: 'failed', publicContracts: false, configurationInspected: false }
  // Inspect the public exports; no Context, Agent, Session or application is started.
  const loop = await import('@deepseek-ai/dsh-agent-loop')
  const tools = await import('@deepseek-ai/dsh-tools')
  const cordis = await import('@deepseek-ai/cordis')
  const services = loop.default?.inject
  const publicContracts = typeof cordis.Context === 'function'
    && typeof tools.defineTool === 'function' && typeof tools.default?.prototype.register === 'function'
    && Array.isArray(services) && services.length === LOOP_SERVICES.length
    && LOOP_SERVICES.every(name => services.includes(name))
  const composition = await inspectProfile()
  const passed = versionMismatches.length === 0 && publicContracts
    && composition.defaultConfiguration.missingCore.length === 0
    && composition.probeConfiguration.missingCore.length === 0
    && composition.probeConfiguration.hostExecution.length === 0
  return {
    ...base, status: passed ? 'passed' : 'failed', configurationInspected: true, publicContracts,
    loopServices: Array.isArray(services) ? services.filter(value => LOOP_SERVICES.includes(value)) : [],
    ...composition,
    unverified: ['application-startup', 'model-tool-loop', 'permission-enforcement',
      'cancellation-quiescence', 'session-restart-recovery', 'actual-sandbox'],
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectDshContract()
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch {
    // Never publish captured CLI config/stderr, paths or unknown error text.
    process.stderr.write('R0 DSH contract check failed. Run the targeted tests for diagnostics.\n')
    process.exitCode = 1
  }
}
