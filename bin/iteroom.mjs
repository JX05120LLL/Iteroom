#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  return `Usage: iteroom [workspace] [--no-open]

Start the local Iteroom text workspace. The current directory is used when
workspace is omitted. The browser opens automatically unless --no-open is set.

Options:
  -h, --help       Show this help
  --no-open        Print the local URL without opening a browser

ITEROOM_DSH_HOME can override the local data directory for isolated runs.`
}

function parseArgs(args) {
  let workspace
  let noOpen = false
  let afterOptions = false
  for (const argument of args) {
    if (!afterOptions && (argument === '-h' || argument === '--help')) return { help: true }
    if (!afterOptions && argument === '--no-open') {
      noOpen = true
      continue
    }
    if (!afterOptions && argument === '--') {
      afterOptions = true
      continue
    }
    if (!afterOptions && argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
    if (workspace !== undefined) throw new Error('Specify at most one project directory')
    workspace = argument
  }
  return { workspace: resolve(workspace ?? process.cwd()), noOpen }
}

function defaultHarnessHome() {
  const home = homedir()
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    return join(localAppData && isAbsolute(localAppData) ? localAppData : join(home, 'AppData', 'Local'), 'Iteroom', 'harness')
  }
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'Iteroom', 'harness')
  const xdgDataHome = process.env.XDG_DATA_HOME
  return join(xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : join(home, '.local', 'share'), 'iteroom', 'harness')
}

async function harnessEntry() {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== '0.1.5-rc.3' || typeof manifest.bin?.dsh !== 'string') {
    throw new Error('The installed DeepSeek Harness version is incompatible with this Iteroom build')
  }
  return resolve(dirname(manifestPath), manifest.bin.dsh)
}

function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if ((major === 22 && minor >= 19) || major >= 24) return
  throw new Error(`Node.js 22.19+ or 24+ is required; found ${process.version}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  checkNodeVersion()
  const info = await stat(args.workspace).catch(() => undefined)
  if (!info?.isDirectory()) throw new Error(`Project directory does not exist: ${args.workspace}`)

  const dshHome = resolve(process.env.ITEROOM_DSH_HOME || defaultHarnessHome())
  const entry = await harnessEntry()
  const patch = join(packageRoot, 'iteroom.patch.yml')
  const command = [entry, '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0']
  if (args.noOpen) command.push('--no-open')

  console.log(`Iteroom workspace: ${args.workspace}`)
  const child = spawn(process.execPath, command, {
    cwd: args.workspace,
    env: { ...process.env, DSH_HOME: dshHome, ITEROOM_DATA_HOME: join(dshHome, 'iteroom') },
    stdio: 'inherit',
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', error => console.error(`Iteroom could not start DeepSeek Harness: ${error.message}`))
  child.on('close', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
  })
}

main().catch(error => {
  console.error(`Iteroom: ${error.message}`)
  process.exitCode = 1
})
