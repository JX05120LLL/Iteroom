import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { validatePocRoot } from './sandbox-preflight.mjs'
import { controlledEnv, failure, runBounded } from './ocr-process.mjs'

const delay = ms => new Promise(done => setTimeout(done, ms))
export function assertOwnedService(process, { pid, root, started }) {
  const created = Date.parse(process?.CreationDate)
  if (process?.ProcessId !== pid || !Number.isFinite(created) || created < started || created > started + 30000
    || !process.CommandLine?.includes('opensandbox_server.cli')
    || !process.CommandLine.replaceAll('/', '\\').includes(join(root, 'r0.toml').replaceAll('/', '\\'))) {
    throw failure('service_ownership_mismatch')
  }
}
async function portAvailable() {
  const socket = createServer()
  await new Promise((done, reject) => {
    socket.once('error', () => reject(failure('service_port_in_use')))
    socket.listen({ host: '127.0.0.1', port: 3088, exclusive: true }, done)
  })
  await new Promise(done => socket.close(done))
}
export async function createOwnedService(value) {
  const root = await validatePocRoot(value)
  const env = { ...controlledEnv(join(root, 'home')), DOCKER_HOST: 'npipe:////./pipe/dockerDesktopLinuxEngine',
    OTEL_SDK_DISABLED: 'true', OPENSANDBOX_DISABLE_METRICS: '1', PYTHONUTF8: '1' }
  let child, started, spawnError
  const logHash = createHash('sha256'); let logBytes = 0, starts = 0
  const controller = {
    get running() { return !!child && child.exitCode === null && child.signalCode === null && !spawnError },
    async start() {
      if (controller.running) throw failure('owned_service_already_running')
      await portAvailable()
      const key = (await readFile(join(root, 'r0-key'), 'utf8')).trim()
      started = Date.now(); spawnError = undefined; starts++
      child = spawn(join(root, 'venv/Scripts/python.exe'), ['-c', 'from opensandbox_server.cli import main; main()',
        '--config', join(root, 'r0.toml')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      child.on('error', error => { spawnError = error })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logBytes += data.length; logHash.update(data) })
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!controller.running) throw failure('owned_service_start_failed')
        try {
          const response = await fetch('http://127.0.0.1:3088/health', { headers: { 'OPEN-SANDBOX-API-KEY': key }, signal: AbortSignal.timeout(500) })
          if (response.ok && (await response.json()).status === 'healthy') return
        } catch (error) { if (!['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error }
        await delay(250)
      }
      throw failure('owned_service_not_ready')
    },
    async stop() {
      if (!controller.running) { await portAvailable(); return }
      const pid = child.pid
      const cmd = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`
      const result = await runBounded('powershell.exe', ['-NoProfile', '-Command', cmd], { cwd: root, env, timeoutMs: 5000 })
      assertOwnedService(JSON.parse(result.stdout), { pid, root, started })
      await runBounded('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { cwd: root, env, timeoutMs: 10000 })
      for (let attempt = 0; controller.running && attempt < 20; attempt++) await delay(50)
      await portAvailable()
    },
    summary() { return { starts, logBytes, logSha256: logHash.copy().digest('hex'), running: controller.running } },
  }
  return controller
}
