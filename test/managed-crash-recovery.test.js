import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { ManagedTaskCoordinator } from '../src/host/managed-task-coordinator.js'

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

test('abrupt Host exit leaves no synthetic model child and restart never replays its task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-crash-'))
  let childPid
  const helper = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/managed-crash-probe.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, ITEROOM_CRASH_PROBE_ROOT: root, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  t.after(async () => {
    if (alive(helper.pid)) helper.kill()
    if (childPid && alive(childPid)) process.kill(childPid)
    await rm(root, { recursive: true, force: true })
  })
  let stdout = '', stderr = ''
  helper.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  helper.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const ready = await new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearInterval(poll); clearTimeout(timeout)
      error ? reject(error) : resolve(value)
    }
    const poll = setInterval(() => {
      const match = /READY:(\{[^\r\n]+\})/.exec(stdout)
      if (match) finish(null, JSON.parse(match[1]))
      else if (helper.exitCode !== null) finish(Error(`helper exited: ${stderr.slice(0, 500)}`))
    }, 25)
    const timeout = setTimeout(() => finish(Error(`synthetic helper timeout: ${stderr.slice(0, 500)}`)), 10000)
  })
  childPid = ready.childPid
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0 && alive(childPid))
  helper.kill()
  await new Promise(resolve => helper.once('close', resolve))
  for (let i = 0; i < 30 && alive(childPid); i++) await delay(100)
  assert.equal(alive(childPid), false, 'DSH child must exit when its Host dies')
  const project = join(root, 'project')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const coordinator = new ManagedTaskCoordinator(store, {
    run: async () => { throw Error('unexpected replay') }, modelKey: async () => 'synthetic',
  })
  await coordinator.initialize()
  assert.equal((await store.get(ready.taskId)).status, 'interrupted')
  await assert.rejects(coordinator.start(ready.taskId, 'start-crash-probe'), { code: 'RUN_ALREADY_STARTED' })
  assert.equal(await readFile(join(project, 'src', 'example.ts'), 'utf8'), 'export const answer = 42\n')
})
