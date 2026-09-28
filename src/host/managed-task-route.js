import { TaskEntryError } from './managed-task-store.js'
import { readManagedFile } from './managed-read-scope.js'
import { captureManagedSnapshot } from './managed-snapshot.js'
import { readManagedSnapshotFile } from './managed-snapshot.js'
import { ManagedTaskCoordinator } from './managed-task-coordinator.js'

const MAX_BODY_BYTES = 8192
const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers }) }

function sameOrigin(request) {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (!origin || !host) return false
  try { return new URL(origin).origin === origin && new URL(origin).host === host.toLowerCase() }
  catch { return false }
}

async function boundedJson(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new TaskEntryError('TASK_BODY_TOO_LARGE', 413)
  const reader = request.body?.getReader()
  if (!reader) throw new TaskEntryError('INVALID_TASK_INPUT', 400)
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new TaskEntryError('TASK_BODY_TOO_LARGE', 413)
    }
    chunks.push(value)
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
  catch { throw new TaskEntryError('INVALID_TASK_INPUT', 400) }
}

function safeResponse(error) {
  return error instanceof TaskEntryError
    ? json({ code: error.code }, error.status) : json({ code: 'TASK_ENTRY_UNAVAILABLE' }, 503)
}

/** The fixed carrier buffers GET bodies, so the bounded POST has a distinct streaming path. */
export function createManagedTaskRoutes(store, coordinator = new ManagedTaskCoordinator(store)) {
  return [{ path: '/api/iteroom/managed-tasks', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      try {
        await coordinator.initialize?.()
        const params = new URL(request.url).searchParams
        if ([...params.keys()].some(key => key !== 'taskId') || params.getAll('taskId').length > 1) {
          throw new TaskEntryError('INVALID_TASK_ID', 400)
        }
        const id = params.get('taskId')
        return id === null ? json({ tasks: await store.list() }) : json({ task: await store.get(id) })
      } catch (error) { return safeResponse(error) }
    } },
  { path: '/api/iteroom/managed-tasks/events', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      try {
        await coordinator.initialize?.()
        const params = new URL(request.url).searchParams
        if ([...params.keys()].sort().join(',') !== 'after,taskId'
          || params.getAll('taskId').length !== 1 || params.getAll('after').length !== 1
          || !/^(?:0|[1-9]\d{0,9})$/.test(params.get('after'))) {
          throw new TaskEntryError('INVALID_EVENT_CURSOR', 400)
        }
        return json(await store.eventsAfter(params.get('taskId'), Number(params.get('after'))))
      } catch (error) { return safeResponse(error) }
    } },
  { path: '/api/iteroom/managed-tasks/create', methods: ['POST'], requestBody: 'streaming',
    fetch: async request => {
      try {
        if (!sameOrigin(request)) throw new TaskEntryError('TASK_ORIGIN_DENIED', 403)
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
          throw new TaskEntryError('TASK_CONTENT_TYPE_UNSUPPORTED', 415)
        }
        if (new URL(request.url).search) throw new TaskEntryError('INVALID_TASK_INPUT', 400)
        const result = await store.create(await boundedJson(request))
        return json({ task: result.task }, result.created ? 201 : 200)
      } catch (error) { return safeResponse(error) }
    } },
  { path: '/api/iteroom/managed-tasks/read', methods: ['POST'], requestBody: 'streaming',
    fetch: async request => {
      try {
        if (!sameOrigin(request)) throw new TaskEntryError('TASK_ORIGIN_DENIED', 403)
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
          throw new TaskEntryError('TASK_CONTENT_TYPE_UNSUPPORTED', 415)
        }
        if (new URL(request.url).search) throw new TaskEntryError('INVALID_READ_INPUT', 400)
        return json(await readManagedFile(store, await boundedJson(request)))
      } catch (error) { return safeResponse(error) }
    } },
  { path: '/api/iteroom/managed-tasks/snapshot', methods: ['POST'], requestBody: 'streaming',
    fetch: async request => {
      try {
        if (!sameOrigin(request)) throw new TaskEntryError('TASK_ORIGIN_DENIED', 403)
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
          throw new TaskEntryError('TASK_CONTENT_TYPE_UNSUPPORTED', 415)
        }
        if (new URL(request.url).search) throw new TaskEntryError('INVALID_SNAPSHOT_INPUT', 400)
        const input = await boundedJson(request)
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).join(',') !== 'taskId') throw new TaskEntryError('INVALID_SNAPSHOT_INPUT', 400)
        return json({ snapshot: await captureManagedSnapshot(store, input.taskId) })
      } catch (error) { return safeResponse(error) }
    } },
  { path: '/api/iteroom/managed-tasks/source', methods: ['GET'], requestBody: 'buffered',
    fetch: async request => {
      try {
        const params = new URL(request.url).searchParams
        if ([...params.keys()].sort().join(',') !== 'path,taskId'
          || params.getAll('taskId').length !== 1 || params.getAll('path').length !== 1) {
          throw new TaskEntryError('INVALID_SNAPSHOT_INPUT', 400)
        }
        return json(await readManagedSnapshotFile(store, params.get('taskId'), params.get('path')))
      } catch (error) { return safeResponse(error) }
    } },
  ...[['start', (taskId, requestId) => coordinator.start(taskId, requestId)],
    ['cancel', (taskId, requestId) => coordinator.cancel(taskId, requestId)]].map(([action, execute]) => ({
    path: `/api/iteroom/managed-tasks/${action}`, methods: ['POST'], requestBody: 'streaming',
    fetch: async request => {
      try {
        if (!sameOrigin(request)) throw new TaskEntryError('TASK_ORIGIN_DENIED', 403)
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
          throw new TaskEntryError('TASK_CONTENT_TYPE_UNSUPPORTED', 415)
        }
        if (new URL(request.url).search) throw new TaskEntryError('INVALID_RUN_INPUT', 400)
        const input = await boundedJson(request)
        if (!input || typeof input !== 'object' || Array.isArray(input)
          || Object.keys(input).sort().join(',') !== 'requestId,taskId') {
          throw new TaskEntryError('INVALID_RUN_INPUT', 400)
        }
        return json({ task: await execute(input.taskId, input.requestId) }, action === 'start' ? 202 : 200)
      } catch (error) { return safeResponse(error) }
    },
  }))]
}
