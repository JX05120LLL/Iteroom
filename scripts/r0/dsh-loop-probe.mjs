import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDshContract } from './dsh-contract.mjs'
import { FIXTURE, PROVIDER, MODEL } from './fixtures/probe-plugin.mjs'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js')
const pluginPath = fileURLToPath(new URL('./fixtures/probe-plugin.mjs', import.meta.url))
export const DISABLED = ['sandbox', 'sandbox-policy', 'subprocess', 'pty', 'terminal-bash',
  'terminal-pwsh', 'jobs', 'persistent-bash', 'persistent-pwsh', 'llm-deepseek', 'llm-retry']

export function runtime(workspace, home, patch, { timeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw Error('Invalid probe timeout')
  const env = { DSH_HOME: home }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|temp|tmp)$/i.test(key)) env[key] = value
  }
  const child = spawn(process.execPath, [cli, '--profile', 'sdk-minimal', '--patch', patch], {
    cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const notifications = []
  const pending = new Map()
  const watchers = new Set()
  let id = 0, buffer = '', bytes = 0, diagnostics = '', fatal, ended = false
  const notify = () => { for (const watcher of watchers) watcher() }
  const fail = error => {
    fatal ??= error
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(fatal) }
    pending.clear()
    notify()
  }
  const exit = new Promise(resolveExit => {
    child.once('error', () => fail(new Error('Probe process could not start')))
    child.once('close', code => { ended = true; resolveExit(code); fail(new Error('Probe process closed')) })
  })
  child.stdin.on('error', () => fail(new Error('Probe input closed')))
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    // Kept in memory for local diagnosis, never included in the public report.
    diagnostics += chunk
    if (Buffer.byteLength(diagnostics) > 65536) { fail(new Error('Probe diagnostics exceeded limit')); child.kill() }
  })
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 1024 * 1024) { fail(new Error('Probe protocol exceeded limit')); child.kill(); return }
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      try {
        const frame = JSON.parse(line)
        if (frame.jsonrpc !== '2.0') throw new Error('Invalid probe frame')
        if (frame.id !== undefined) {
          const item = pending.get(frame.id)
          if (!item) throw new Error('Unexpected probe response')
          clearTimeout(item.timer)
          pending.delete(frame.id)
          if (frame.error) item.reject(new Error(`Probe RPC rejected: ${frame.error.code}`, { cause: frame.error }))
          else item.resolve(frame.result)
        } else if (typeof frame.method === 'string') {
          notifications.push(frame)
          if (notifications.length > 4096) throw new Error('Probe notification limit')
          notify()
        } else throw new Error('Invalid probe notification')
      } catch (error) { fail(error); child.kill(); break }
    }
  })
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    if (fatal) { reject(fatal); return }
    const key = ++id
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Probe RPC timeout: ${method}`)) }, timeoutMs)
    pending.set(key, { resolve: resolveRequest, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, ...(params === undefined ? {} : { params }) }) + '\n')
  })
  const wait = predicate => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish(new Error('Probe event timeout')), timeoutMs)
    const finish = error => { clearTimeout(timer); watchers.delete(check); error ? reject(error) : resolveWait() }
    const check = () => {
      if (predicate(notifications)) finish()
      else if (fatal) finish(fatal)
    }
    watchers.add(check)
    check()
  })
  const events = sessionId => notifications.filter(frame => frame.method === 'session.event' && frame.params.sessionId === sessionId).map(frame => frame.params.event)
  return {
    request, events,
    async prompt(sessionId, marker) {
      const before = events(sessionId).length
      const receipt = await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: marker }] })
      if (typeof receipt.messageId !== 'string') throw new Error('Probe prompt was not acknowledged')
      await wait(frames => {
        const own = frames.filter(frame => frame.params?.sessionId === sessionId)
        const latestStatus = own.filter(frame => frame.method === 'session.status').at(-1)
        return events(sessionId).slice(before).some(event => event.type === 'turn/end')
          && own.some(frame => frame.method === 'session.status' && frame.params.status === 'running')
          && latestStatus?.params.status === 'idle'
      })
      return events(sessionId).slice(before)
    },
    async stop() {
      if (!ended && !fatal) await request('shutdown')
      const timer = setTimeout(() => child.kill(), 3000)
      try { return await exit } finally { clearTimeout(timer) }
    },
    async dispose() {
      if (!ended) { child.stdin.end(); const timer = setTimeout(() => child.kill(), 2000); try { await exit } finally { clearTimeout(timer) } }
      for (const item of pending.values()) clearTimeout(item.timer)
    },
  }
}

function summarize(events) {
  const end = events.findLast(event => event.type === 'turn/end')
  const results = events.filter(event => event.type === 'tool/result')
  return { turnEnd: end?.data.reason.kind ?? 'missing',
    ...(end?.data.reason.error ? { errorCode: end.data.reason.error.code } : {}),
    ...(end?.data.reason.reason ? { cause: end.data.reason.reason.kind } : {}),
    toolResults: results.length,
    toolResultIsError: results.some(event => event.data.message.content.some(block => block.type === 'tool-result' && block.isError)),
    toolResultMatchesFixture: results.some(event => event.data.message.content.some(block => block.type === 'tool-result'
      && !block.isError && block.content.some(part => part.type === 'text' && part.text === FIXTURE))),
  }
}

export async function persistedSessions(root) {
  const sessions = new Map()
  async function visit(directory, depth = 0) {
    if (depth > 4) throw new Error('Unexpected probe persistence layout')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const text = await readFile(path, 'utf8')
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Probe session exceeds limit')
        const [header, ...events] = text.trim().split('\n').map(line => JSON.parse(line))
        if (header.type !== 'session' || sessions.has(header.id)) throw new Error('Invalid probe persisted session')
        sessions.set(header.id, events)
      }
    }
  }
  await visit(root)
  return sessions
}

export async function runDshLoopProbe() {
  const contract = await inspectDshContract()
  if (contract.status !== 'passed') throw new Error('Fixed DSH contract preflight failed')
  const parent = resolve(tmpdir())
  const scratch = await mkdtemp(join(parent, 'iteroom-r0-loop-'))
  let app
  try {
    const workspace = join(scratch, 'workspace'), home = join(scratch, 'home')
    await mkdir(join(workspace, 'src'), { recursive: true })
    await mkdir(home)
    const source = join(workspace, 'src/greet.ts'), metricsFile = join(home, 'probe-metrics.json')
    await writeFile(source, FIXTURE)
    const patch = join(scratch, 'probe.patch.yml')
    // JSON string literals are also valid YAML scalars; no shell interpolation.
    await writeFile(patch, DISABLED.map(key => `- id: ${key}\n  disabled: true`).join('\n')
      + '\n- id: tools\n  config:\n    mode: native\n'
      + `- insert:\n    - id: iter-room-probe\n      name: ${JSON.stringify(pluginPath)}\n      config:\n        metrics: ${JSON.stringify(metricsFile)}\n`)
    app = runtime(workspace, home, patch)
    const initialize = () => app.request('initialize', { cwd: workspace, provider: PROVIDER, model: MODEL, maxTokens: 128 })
    const hello = await initialize()
    if (hello?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected probe runtime identity')
    const loopEvents = await app.prompt('r0-loop', 'R0_LOOP')
    const deniedEvents = await app.prompt('r0-denied', 'R0_DENIED')
    const failureEvents = await app.prompt('r0-failure', 'R0_FAILURE')
    const cancelEvents = await app.prompt('r0-cancel', 'R0_CANCEL')
    const firstCode = await app.stop()
    const firstMetrics = JSON.parse(await readFile(metricsFile, 'utf8'))
    const before = await persistedSessions(join(home, 'sessions'))
    const prefix = before.get('r0-loop')
    if (!prefix) throw new Error('Probe session was not persisted')
    app = runtime(workspace, home, patch)
    await initialize()
    let sdkResumeRejected = false
    try {
      await app.request('session/prompt', { sessionId: 'r0-loop', contentBlocks: [{ type: 'text', text: 'R0_RESUME' }] })
    } catch (error) {
      if (error.cause?.code !== -32603 || !error.cause?.message?.includes('already exists')) throw error
      sdkResumeRejected = true
    }
    const secondCode = await app.stop()
    if (!sdkResumeRejected) throw new Error('SDK resume contract changed; review the probe')
    await writeFile(patch, (await readFile(patch, 'utf8')) + '        resume: true\n')
    app = runtime(workspace, home, patch)
    await initialize()
    const thirdCode = await app.stop()
    const secondMetrics = JSON.parse(await readFile(metricsFile, 'utf8'))
    const after = await persistedSessions(join(home, 'sessions'))
    const restartEvents = after.get('r0-loop')?.slice(prefix.length) ?? []
    const allContiguous = [...after.values()].every(events => events.every((event, index) => event.seq === index))
    const prefixPreserved = JSON.stringify(after.get('r0-loop')?.slice(0, prefix.length)) === JSON.stringify(prefix)
    const durableOutcomesMatch = [['r0-loop', 'completed'], ['r0-denied', 'completed'],
      ['r0-failure', 'error'], ['r0-cancel', 'aborted']].every(([sessionId, kind]) =>
      after.get(sessionId)?.findLast(event => event.type === 'turn/end')?.data.reason.kind === kind)
    const workspaceEntries = await readdir(workspace)
    const sourceEntries = await readdir(join(workspace, 'src'))
    const workspaceUnchanged = await readFile(source, 'utf8') === FIXTURE
      && JSON.stringify(workspaceEntries) === JSON.stringify(['src']) && JSON.stringify(sourceEntries) === JSON.stringify(['greet.ts'])
    const report = {
      schemaVersion: 1, generatedAt: new Date().toISOString(), evidenceKind: 'official-cli-runtime-with-mock-model',
      gateA: 'not_completed', appBooted: true, actualModel: false, actualSandbox: false,
      environment: { platform: process.platform, node: process.version }, inventory: contract.inventory,
      toolRoster: firstMetrics.toolRoster, workspaceUnchanged, processExitCodes: [firstCode, secondCode, thirdCode],
      loop: { ...firstMetrics.cases.R0_LOOP, ...summarize(loopEvents) },
      denied: { ...firstMetrics.cases.R0_DENIED, ...summarize(deniedEvents) },
      failure: { ...firstMetrics.cases.R0_FAILURE, ...summarize(failureEvents) },
      cancel: { ...firstMetrics.cases.R0_CANCEL, ...summarize(cancelEvents), sdkCancelAvailable: false },
      restart: { ...secondMetrics.cases.R0_RESUME, ...summarize(restartEvents), sdkResumeRejected, coreResumeAvailable: true },
      persistence: { sessions: after.size, contiguousSequences: allContiguous, prefixPreserved, durableOutcomesMatch },
      unverified: ['real-model-tool-loop', 'actual-sandbox', 'remote-execution-cancellation',
        'product-permission-approval', 'product-task-recovery', 'crash-or-unknown-side-effect-recovery', 'browser', 'release'],
    }
    const passed = report.loop.modelCalls === 2 && report.loop.toolExecutions === 1
      && report.loop.toolResults === 1 && report.loop.nextStepSawResult && report.loop.toolResultMatchesFixture && report.loop.turnEnd === 'completed'
      && report.denied.guardDenials === 1 && report.denied.toolExecutions === 0 && report.denied.toolResultIsError && report.denied.turnEnd === 'completed'
      && report.failure.turnEnd === 'error' && report.failure.errorCode === 'ITEROOM_MOCK_FAILURE'
      && report.failure.modelCalls === 1 && report.failure.toolExecutions === 0
      && report.cancel.turnEnd === 'aborted' && report.cancel.cause === 'user'
      && report.cancel.signalObserved && report.cancel.whenIdleResolved && report.cancel.toolExecutions === 0
      && report.restart.historySawFixture && report.restart.toolExecutions === 0 && report.restart.turnEnd === 'completed'
      && after.size === 4 && allContiguous && prefixPreserved && durableOutcomesMatch && workspaceUnchanged
      && firstCode === 0 && secondCode === 0 && thirdCode === 0 && JSON.stringify(report.toolRoster) === JSON.stringify(['iteroom_read_fixture'])
    return { ...report, status: passed ? 'passed' : 'failed' }
  } finally {
    await app?.dispose()
    if (dirname(resolve(scratch)) !== parent || !scratch.startsWith(join(parent, 'iteroom-r0-loop-'))) {
      throw new Error('Refusing cleanup outside owned probe directory')
    }
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runDshLoopProbe()
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch {
    process.stderr.write('R0 DSH runtime probe failed. Run the targeted test for diagnostics.\n')
    process.exitCode = 1
  }
}
