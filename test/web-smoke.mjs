// Exercise the shipped Web carrier with a local model stub and an isolated Git workspace.
// Run after `npm run build`: node test/web-smoke.mjs
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const placeholderKey = 'iteroom-local-smoke-placeholder'
const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout.trim()
}

async function fixture(root) {
  const cwd = join(root, 'sample-repo')
  await mkdir(cwd)
  await git(cwd, 'init', '-q')
  await git(cwd, 'config', 'user.name', 'Iteroom Smoke')
  await git(cwd, 'config', 'user.email', 'smoke@example.invalid')
  await writeFile(join(cwd, 'README.md'), '# Sample project\n', 'utf8')
  await git(cwd, 'add', 'README.md')
  await git(cwd, 'commit', '-qm', 'Initial sample')
  await writeFile(join(cwd, 'README.md'), '# Sample project\nExisting local note.\n', 'utf8')
  return cwd
}

async function modelStub() {
  const requests = []
  let writeIssued = false
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/chat/completions') {
      response.writeHead(404).end()
      return
    }
    if (request.headers.authorization !== `Bearer ${placeholderKey}`) {
      response.writeHead(403).end('unexpected credential')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.ok(Array.isArray(body.messages), 'model request contains messages')
      requests.push(body)
    } catch {
      response.writeHead(400).end('invalid model request')
      return
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    if (!writeIssued && JSON.stringify(body.messages).includes('ITEROOM_SMOKE_WRITE')) {
      writeIssued = true
      const args = JSON.stringify({ file_path: 'smoke-result.txt', content: 'Iteroom smoke wrote this file.\n' })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', tool_calls: [{
        index: 0,
        id: 'call_iteroom_smoke_write',
        type: 'function',
        function: { name: 'write', arguments: args },
      }] }, finish_reason: null }] })}\n\n`)
      response.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    } else {
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":"已收到文字任务。"},"finish_reason":null}]}\n\n')
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  }
}

function startIteroom(cwd, home, baseURL) {
  const output = []
  const inherited = { ...process.env }
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY']) delete inherited[name]
  const child = spawn(process.execPath, [join(projectRoot, 'bin', 'iteroom.mjs'), cwd, '--no-open'], {
    cwd: projectRoot,
    env: {
      ...inherited,
      ITEROOM_DSH_HOME: home,
      ITEROOM_DATA_HOME: join(home, 'iteroom'),
      DEEPSEEK_BASE_URL: baseURL,
      DEEPSEEK_API_KEY: placeholderKey,
      DSH_TELEMETRY_DISABLED: '1',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let transcript = ''
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`Web startup timed out. ${transcript.replace(/token=[^\s)]+/g, 'token=[redacted]').slice(-3000)}`)), 90_000)
    const receive = (chunk) => {
      const line = chunk.toString('utf8')
      transcript = (transcript + line).slice(-12_000)
      output.push(line.replace(/token=[^\s)]+/g, 'token=[redacted]'))
      const match = transcript.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+)/)
      if (match) {
        clearTimeout(timer)
        resolveReady(match[1])
      }
    }
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.once('error', (error) => { clearTimeout(timer); rejectReady(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`Web exited before ready (${code}). ${output.join('').slice(-3000)}`))
    })
  })
  return { child, ready, output }
}

async function stopIteroom(runtime) {
  const { child } = runtime
  if (child.exitCode !== null || child.signalCode !== null) return
  const settled = new Promise((resolveExit) => child.once('exit', resolveExit))
  child.kill('SIGTERM')
  await Promise.race([settled, delay(6000)])
  if (child.exitCode === null && child.signalCode === null && process.platform === 'win32' && child.pid) {
    await execFileAsync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  }
}

async function authenticate(tokenUrl) {
  const response = await fetch(tokenUrl, { redirect: 'manual' })
  assert.ok(response.status >= 300 && response.status < 400, `token exchange: HTTP ${response.status}`)
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie, 'token exchange returns a signed browser cookie')
  return { origin: new URL(tokenUrl).origin, cookie }
}

async function rpc(browser, method, request) {
  const rpcId = randomUUID()
  const response = await fetch(`${browser.origin}/api/session/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: browser.cookie,
      origin: browser.origin,
    },
    body: JSON.stringify({ type: 'client-request', rpcId, method: `session/${method}`, payload: { args: { request } } }),
  })
  assert.equal(response.status, 200, `session/${method} transport`)
  const body = await response.json()
  assert.equal(body.rpcId, rpcId)
  assert.equal(body.result?.ok, true, `session/${method}: ${JSON.stringify(body.result?.error ?? {})}`)
  return body.result.value
}

async function tasks(browser, sessionId) {
  const url = `${browser.origin}/api/iteroom/tasks?sessionId=${encodeURIComponent(sessionId)}`
  const response = await fetch(url, { headers: { cookie: browser.cookie, origin: browser.origin } })
  assert.equal(response.status, 200, `Iteroom task route: HTTP ${response.status}`)
  const body = await response.json()
  assert.ok(Array.isArray(body.tasks), 'Iteroom route returns a task list')
  return body.tasks
}

async function waitForTask(browser, sessionId) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const current = await tasks(browser, sessionId)
    const task = current.find((entry) => entry.sessionId === sessionId)
    if (task && terminalStatuses.has(task.status)) return task
    await delay(400)
  }
  throw new Error('Iteroom task did not reach a terminal state within 45 seconds')
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-web-smoke-'))
  const cwd = await fixture(root)
  const home = join(root, 'harness')
  const stub = await modelStub()
  let runtime
  try {
    runtime = startIteroom(cwd, home, stub.baseURL)
    const browser = await authenticate(await runtime.ready)
    const unauthorized = await fetch(`${browser.origin}/api/iteroom/tasks?sessionId=missing`)
    assert.equal(unauthorized.status, 401, 'task route requires browser authentication')
    const crossOrigin = await fetch(`${browser.origin}/api/iteroom/tasks?sessionId=missing`, {
      headers: { cookie: browser.cookie, origin: 'http://foreign.example' },
    })
    assert.equal(crossOrigin.status, 403, 'task route refuses a foreign Origin')

    const projectUrl = `${browser.origin}/api/iteroom/project`
    const projectUnauthorized = await fetch(projectUrl)
    assert.equal(projectUnauthorized.status, 401, 'project route requires browser authentication')
    const projectCrossOrigin = await fetch(projectUrl, {
      headers: { cookie: browser.cookie, origin: 'http://foreign.example' },
    })
    assert.equal(projectCrossOrigin.status, 403, 'project route refuses a foreign Origin')
    const projectResponse = await fetch(projectUrl, {
      headers: { cookie: browser.cookie, origin: browser.origin },
    })
    assert.equal(projectResponse.status, 200, 'project route accepts the authenticated browser')
    assert.equal(projectResponse.headers.get('cache-control'), 'no-store', 'project path is not cached')
    assert.deepEqual(await projectResponse.json(), { cwd }, 'project route identifies the launch directory')

    const managedUrl = `${browser.origin}/api/iteroom/managed-tasks`
    const managedInput = { requestId: randomUUID(), kind: 'understand', objective: 'Explain the synthetic README', paths: ['README.md'] }
    assert.equal((await fetch(managedUrl)).status, 401, 'managed task list requires authentication')
    assert.equal((await fetch(managedUrl, { headers: { cookie: browser.cookie, origin: 'http://foreign.example' } })).status, 403,
      'managed task list refuses foreign Origin')
    const managedPost = (cookie, origin, payload = managedInput) => fetch(`${managedUrl}/create`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal((await managedPost('', browser.origin)).status, 401, 'managed task creation requires authentication')
    assert.equal((await managedPost(browser.cookie, 'http://foreign.example')).status, 403, 'managed task creation refuses foreign Origin')
    const oversized = await fetch(`${managedUrl}/create`, {
      method: 'POST',
      headers: { cookie: browser.cookie, origin: browser.origin, 'content-type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8193)); controller.close() } }),
      duplex: 'half',
    })
    assert.equal(oversized.status, 413, 'chunked body is bounded by the managed route')
    const beforeManaged = await readFile(join(cwd, 'README.md'), 'utf8')
    const modelRequestsBeforeManaged = stub.requests.length
    const managedCreated = await managedPost(browser.cookie, browser.origin)
    assert.equal(managedCreated.status, 201, `managed task is registered: ${await managedCreated.clone().text()}`)
    const managed = (await managedCreated.json()).task
    assert.equal(managed.status, 'queued')
    assert.equal(managed.engineStatus, 'not_started')
    assert.equal((await managedPost(browser.cookie, browser.origin)).status, 200, 'retry does not create a second task')
    assert.equal((await managedPost(browser.cookie, browser.origin, { ...managedInput, requestId: randomUUID() })).status, 409,
      'a second active task is refused')
    assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), beforeManaged, 'registration does not change the project')
    assert.equal(stub.requests.length, modelRequestsBeforeManaged, 'registration does not call the model')
    const managedRead = (cookie, origin, payload = { taskId: managed.id, path: 'README.md' }) => fetch(`${managedUrl}/read`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal((await managedRead('', browser.origin)).status, 401, 'managed read requires authentication')
    assert.equal((await managedRead(browser.cookie, 'http://foreign.example')).status, 403, 'managed read refuses foreign Origin')
    assert.equal((await managedRead(browser.cookie, browser.origin, { taskId: managed.id, path: '.git/config' })).status, 403,
      'managed read refuses an unselected sensitive path')
    const managedFileResponse = await managedRead(browser.cookie, browser.origin)
    assert.equal(managedFileResponse.status, 200, `managed file read: ${await managedFileResponse.clone().text()}`)
    assert.equal(managedFileResponse.headers.get('cache-control'), 'no-store')
    const managedFile = await managedFileResponse.json()
    assert.equal(managedFile.text, beforeManaged)
    assert.match(managedFile.sha256, /^[0-9a-f]{64}$/)
    assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), beforeManaged, 'managed read does not change the project')
    assert.equal(stub.requests.length, modelRequestsBeforeManaged, 'managed read does not call the model')
    const snapshotPost = (cookie, origin, payload = { taskId: managed.id }) => fetch(`${managedUrl}/snapshot`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })
    assert.equal((await snapshotPost('', browser.origin)).status, 401, 'snapshot capture requires authentication')
    assert.equal((await snapshotPost(browser.cookie, 'http://foreign.example')).status, 403, 'snapshot capture refuses foreign Origin')
    const snapshotResponse = await snapshotPost(browser.cookie, browser.origin)
    assert.equal(snapshotResponse.status, 200, `snapshot capture: ${await snapshotResponse.clone().text()}`)
    const snapshot = (await snapshotResponse.json()).snapshot
    assert.equal(snapshot.files[0].sha256, managedFile.sha256, 'snapshot fixes the selected observed bytes')
    const snapshotSourceUrl = `${managedUrl}/source?taskId=${encodeURIComponent(managed.id)}&path=README.md`
    assert.equal((await fetch(snapshotSourceUrl)).status, 401, 'snapshot source requires authentication')
    assert.equal((await fetch(snapshotSourceUrl, { headers: { cookie: browser.cookie, origin: 'http://foreign.example' } })).status, 403,
      'snapshot source refuses foreign Origin')
    const sourceResponse = await fetch(snapshotSourceUrl, { headers: { cookie: browser.cookie, origin: browser.origin } })
    assert.equal(sourceResponse.status, 200)
    assert.equal((await sourceResponse.json()).text, beforeManaged)
    const runPost = (action, cookie, origin) => fetch(`${managedUrl}/${action}`, {
      method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: managed.id, requestId: randomUUID() }),
    })
    assert.equal((await runPost('start', '', browser.origin)).status, 401, 'managed run requires authentication')
    assert.equal((await runPost('start', browser.cookie, 'http://foreign.example')).status, 403,
      'managed run refuses foreign Origin before any model action')
    assert.equal((await runPost('cancel', '', browser.origin)).status, 401, 'managed cancel requires authentication')
    assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), beforeManaged, 'snapshot capture does not change the project')
    assert.equal(stub.requests.length, modelRequestsBeforeManaged, 'snapshot capture does not call the model')

    const created = await rpc(browser, 'create', { cwd })
    assert.ok(typeof created.sessionId === 'string' && created.sessionId, 'session created in sample repository')
    assert.deepEqual(await tasks(browser, created.sessionId), [], 'new session has no task records')
    await rpc(browser, 'prompt', {
      sessionId: created.sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: '请用一句话确认收到这个文字任务，不要修改文件。' }],
    })
    const task = await waitForTask(browser, created.sessionId)
    assert.equal(task.status, 'completed', `text task status: ${task.status}; ${JSON.stringify(task.warnings ?? [])}`)
    assert.equal(task.cwd, cwd)
    assert.equal(task.prompt, '请用一句话确认收到这个文字任务，不要修改文件。')
    assert.deepEqual(task.changes, [], 'existing dirty file is not attributed to this text-only task')
    assert.ok(stub.requests.length >= 1, 'local model stub received a request')
    assert.equal(await git(cwd, 'status', '--porcelain'), 'M README.md', 'pre-existing workspace edit remains unchanged')

    const defaultSession = await rpc(browser, 'create', {})
    assert.ok(typeof defaultSession.sessionId === 'string' && defaultSession.sessionId,
      'session created without an explicit project path')
    await rpc(browser, 'prompt', {
      sessionId: defaultSession.sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: '请确认默认项目目录，不要修改文件。' }],
    })
    const defaultTask = await waitForTask(browser, defaultSession.sessionId)
    assert.equal(defaultTask.status, 'completed', 'default-workspace text task completes')
    assert.equal(defaultTask.cwd, cwd, 'new Session inherits the launcher project directory')

    const writeSession = await rpc(browser, 'create', { cwd })
    await rpc(browser, 'prompt', {
      sessionId: writeSession.sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'ITEROOM_SMOKE_WRITE: create smoke-result.txt with one line.' }],
    })
    const writeTask = await waitForTask(browser, writeSession.sessionId)
    assert.equal(writeTask.status, 'completed', `file task status: ${writeTask.status}; ${JSON.stringify(writeTask.warnings ?? [])}`)
    assert.equal(await readFile(join(cwd, 'smoke-result.txt'), 'utf8'), 'Iteroom smoke wrote this file.\n',
      'DSH write tool changed the isolated repository')
    assert.ok(stub.requests.some((request) => request.tools?.some((tool) => tool.function?.name === 'write')),
      'the model request exposed DSH write tool')
    const written = writeTask.changes.find((change) => change.path === 'smoke-result.txt')
    assert.ok(written, `Iteroom task records the actual file change: ${JSON.stringify(writeTask.changes)}`)
    assert.equal(written.status, 'added')
    assert.equal(written.priorChange, false)
    assert.match(written.diff, /\+Iteroom smoke wrote this file\./, 'task review includes a real line diff')
    assert.ok(!writeTask.changes.some((change) => change.path === 'README.md'),
      'the pre-existing dirty file is not attributed to the write task')

    await stopIteroom(runtime)
    runtime = startIteroom(cwd, home, stub.baseURL)
    const reopened = await authenticate(await runtime.ready)
    const recovered = await tasks(reopened, created.sessionId)
    assert.ok(recovered.some((entry) => entry.id === task.id && entry.status === 'completed'), 'task survives Web restart')
    const recoveredWrite = await tasks(reopened, writeSession.sessionId)
    assert.ok(recoveredWrite.some((entry) => entry.id === writeTask.id && entry.changes.some((change) => change.path === 'smoke-result.txt')),
      'the actual file diff survives Web restart')
    const managedRecovered = await fetch(`${reopened.origin}/api/iteroom/managed-tasks?taskId=${managed.id}`, {
      headers: { cookie: reopened.cookie, origin: reopened.origin },
    })
    assert.equal(managedRecovered.status, 200, 'managed task survives Web restart')
    const recoveredManagedTask = (await managedRecovered.json()).task
    assert.equal(recoveredManagedTask.id, managed.id)
    assert.equal(recoveredManagedTask.readObservations[0].sha256, managedFile.sha256, 'read hash survives Web restart')
    assert.equal(recoveredManagedTask.snapshotId, snapshot.id, 'fixed snapshot linkage survives Web restart')
    console.log('Web smoke passed: authenticated managed task entry/read/snapshot, no model request on managed routes, project/session routes, local model stub, actual Diff, restart recovery.')
  } finally {
    if (runtime) await stopIteroom(runtime)
    await stub.close()
    if (dirname(root) === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true })
    }
  }
}

main().catch((error) => {
  console.error(`Web smoke failed: ${error.stack ?? error}`)
  process.exitCode = 1
})
