import { isAbsolute, relative, sep } from 'node:path'
import { TaskStore, defaultTaskDataHome } from './host/task-store.js'
import { ManagedTaskStore } from './host/managed-task-store.js'
import { createManagedTaskRoutes } from './host/managed-task-route.js'
import { ManagedTaskCoordinator } from './host/managed-task-coordinator.js'
import { ManagedModifyCoordinator } from './host/managed-modify-coordinator.js'
import { loadManagedModelKey } from './host/managed-model-key.js'

export const inject = ['connection', 'sessionController']

const noCache = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: noCache })
}

function safeSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
}

function insideWorkspace(workspace, path) {
  if (!isAbsolute(workspace) || !isAbsolute(path)) return false
  const child = relative(workspace, path)
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/** Product task evidence beside DSH Sessions; DSH still owns execution and history. */
export function apply(ctx) {
  const store = new TaskStore(defaultTaskDataHome())
  const managedTasks = new ManagedTaskStore(defaultTaskDataHome(), process.cwd())
  const managedCoordinator = new ManagedTaskCoordinator(managedTasks, {
    modelKey: () => loadManagedModelKey(process.cwd()),
    engineLimits: {
      maxRequests: Number(process.env.ITEROOM_MANAGED_MAX_REQUESTS ?? 3),
      maxOutputTokens: Number(process.env.ITEROOM_MANAGED_MAX_OUTPUT_TOKENS ?? 256),
    },
  })
  const modifyCoordinator = new ManagedModifyCoordinator(managedTasks, {
    modelKey: () => loadManagedModelKey(process.cwd()),
  })
  ctx.effect(() => () => managedCoordinator.dispose(), 'iteroom: stop managed read-only engine')
  ctx.effect(() => () => modifyCoordinator.dispose(), 'iteroom: stop managed sandbox engine')

  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision

    const sessionId = agent.session.id
    const cwd = agent.session.header.cwd
    if (typeof cwd === 'string' && insideWorkspace(cwd, store.dataHome)) {
      ctx.logger.warn('iteroom: refusing to store task evidence inside the workspace %s', cwd)
      return decision
    }
    try { await store.prepare({ sessionId, turn, cwd, signal }) }
    catch (error) { ctx.logger.warn('iteroom: could not capture task evidence: %o', error) }
    return decision
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') {
      void store.finish({ sessionId: session.id, turn: event.data.turn, cwd: session.header.cwd })
        .catch(error => ctx.logger.warn('iteroom: could not finalize task evidence: %o', error))
    }
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/iteroom/project',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json({ cwd: process.cwd() }),
  }), 'iteroom: authenticated launch project route')

  for (const route of createManagedTaskRoutes(managedTasks, managedCoordinator, modifyCoordinator)) {
    ctx.effect(() => ctx.connection.fetch.register(route), 'iteroom: authenticated managed task entry')
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/iteroom/tasks',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async request => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      if (!safeSessionId(sessionId)) return json({ error: 'Invalid sessionId' }, 400)
      try {
        const inspection = await ctx.sessionController.inspect(sessionId, request.signal)
        return json({ tasks: await store.tasksForInspection(inspection) })
      } catch (error) {
        if (error?.code === 'SESSION_NOT_FOUND' || error?.code === 'session/not-found'
          || error?.constructor?.name === 'ApiSessionNotFound') {
          return json({ error: 'Session not found' }, 404)
        }
        ctx.logger.warn('iteroom: task review failed: %o', error)
        return json({ error: 'Task review unavailable' }, 503)
      }
    },
  }), 'iteroom: authenticated task review route')
}
