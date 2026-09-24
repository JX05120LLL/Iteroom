import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = resolve(process.argv[2] ?? root)
const info = await stat(workspace).catch(() => undefined)
if (!info?.isDirectory()) throw new Error(`Project directory does not exist: ${workspace}`)

const entry = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const patch = join(root, 'iteroom.patch.yml')
const harnessHome = resolve(process.env.ITEROOM_DSH_HOME ?? join(tmpdir(), 'iteroom-ui-review-harness'))
const child = spawn(process.execPath, [entry, '--profile', 'web', '--patch', patch, '--no-open'], {
  cwd: workspace,
  env: { ...process.env, DSH_HOME: harnessHome },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === null ? 1 : 0)
})
