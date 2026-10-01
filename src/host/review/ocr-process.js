import { spawn, execFile } from 'node:child_process'
import { isAbsolute, join } from 'node:path'

export function failure(code, exitCode) {
  return Object.assign(new Error(`OCR probe: ${code}`), { code, ...(exitCode === undefined ? {} : { exitCode }) })
}

export function controlledEnv(home, source = process.env) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value
  }
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty-gitconfig'),
    GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', NO_COLOR: '1' }
}

// R0-only process boundary; no shell, model configuration or user config inheritance.
export async function runBounded(command, args, { cwd, env, timeoutMs = 10000, maxOutputBytes = 1024 * 1024,
  encoding = 'utf8', allowedExitCodes = [0] } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.includes('\0')
    || !Array.isArray(args) || args.some(x => typeof x !== 'string' || x.includes('\0'))
    || typeof cwd !== 'string' || !isAbsolute(cwd) || !env
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024
    || !['utf8', 'buffer'].includes(encoding) || !Array.isArray(allowedExitCodes) || !allowedExitCodes.length
    || allowedExitCodes.some(code => !Number.isInteger(code) || code < 0 || code > 255)) {
    throw failure('invalid_options')
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stopReason, stopTree, bytes = 0
    const stdout = [], stderr = []
    const unconfirmedStop = () => {
      child.kill('SIGKILL')
      // A surviving descendant may keep inherited pipes open. Bound the wait,
      // but report termination_unconfirmed rather than claiming tree shutdown.
      child.stdout.destroy(); child.stderr.destroy()
    }
    const stop = reason => {
      if (stopReason) return
      stopReason = reason
      if (!child.pid) return
      if (process.platform === 'win32') {
        const systemRoot = Object.entries(env).find(([key]) => /^systemroot$/i.test(key))?.[1]
        if (!systemRoot) { stopTree = Promise.resolve(false); unconfirmedStop(); return }
        stopTree = new Promise(done => execFile(join(systemRoot, 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, maxBuffer: 8192, env },
          error => { if (error) unconfirmedStop(); done(!error) }))
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); stopTree = Promise.resolve(true) }
        catch { stopTree = Promise.resolve(false); unconfirmedStop() }
      }
    }
    const timer = setTimeout(() => stop('timeout'), timeoutMs)
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        bytes += chunk.length
        if (bytes > maxOutputBytes) stop('output_limit')
        else if (!stopReason) chunks.push(chunk)
      })
    }
    child.on('error', () => { stopReason ??= 'spawn_failed' })
    child.on('close', async code => {
      clearTimeout(timer)
      if (stopTree && !await stopTree) return reject(failure('termination_unconfirmed'))
      if (stopReason) return reject(failure(stopReason))
      if (!allowedExitCodes.includes(code)) return reject(failure('process_failed', code))
      const output = Buffer.concat(stdout)
      resolve({ stdout: encoding === 'buffer' ? output : output.toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code })
    })
  })
}
