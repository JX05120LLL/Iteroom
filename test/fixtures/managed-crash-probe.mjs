import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ManagedTaskStore } from '../../src/host/managed-task-store.js'
import { captureManagedSnapshot } from '../../src/host/managed-snapshot.js'
import { runManagedUnderstand } from '../../src/host/managed-engine-runner.js'

const root = process.env.ITEROOM_CRASH_PROBE_ROOT
if (!root) throw Error('synthetic probe root required')
const project = join(root, 'project')
await mkdir(join(project, 'src'), { recursive: true })
await writeFile(join(project, 'src', 'example.ts'), 'export const answer = 42\n')
const store = new ManagedTaskStore(join(root, 'data'), project)
const task = (await store.create({ requestId: 'crash-probe', kind: 'understand',
  objective: 'Hold synthetic model', paths: ['src/example.ts'] })).task
await captureManagedSnapshot(store, task.id)
await store.claimRun(task.id, 'start-crash-probe')
const mockAdapterPath = fileURLToPath(new URL('./managed-engine-model.mjs', import.meta.url))
let childPid
await runManagedUnderstand({ store, taskId: task.id, provider: 'iteroom-r1-mock',
  model: 'synthetic', mockAdapterPath, timeoutMs: 20000,
  onProcess: pid => { childPid = pid },
  onText: text => {
    if (text.includes('Synthetic model is waiting.')) {
      process.stdout.write(`READY:${JSON.stringify({ taskId: task.id, childPid })}\n`)
    }
  },
})
