import { createHash } from 'node:crypto'
import { TaskEntryError } from './managed-task-store.js'
import { readManagedSnapshotFile } from './managed-snapshot.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = value => createHash('sha256').update(value).digest('hex')

export function shellLiteral(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0'))) {
    throw new TaskEntryError('SANDBOX_COMMAND_INVALID', 400)
  }
  return argv.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')
}

function sandboxOptions(image, taskId) {
  if (!/^node@sha256:[0-9a-f]{64}$/.test(image)) throw new TaskEntryError('SANDBOX_IMAGE_INVALID', 400)
  return { image, metadata: { 'iteroom-task-id': taskId }, platform: { os: 'linux', arch: 'amd64' },
    resource: { cpu: '1', memory: '512Mi' }, volumes: [], env: {},
    networkPolicy: { defaultAction: 'deny', egress: [] }, timeoutSeconds: 300,
    readyTimeoutSeconds: 60, healthCheckPollingInterval: 500 }
}

function captureFactory(sdk, record) {
  if (typeof sdk.createDefaultAdapterFactory !== 'function') return undefined
  const factory = sdk.createDefaultAdapterFactory()
  return {
    createEgressStack: options => factory.createEgressStack(options),
    createNetworkPolicyStack: options => factory.createNetworkPolicyStack(options),
    createExecdStack: options => factory.createExecdStack({ ...options,
      connectionConfig: { ...options.connectionConfig, sseFetch: globalThis.fetch } }),
    createLifecycleStack(options) {
      const stack = factory.createLifecycleStack(options)
      return { sandboxes: new Proxy(stack.sandboxes, { get(target, key) {
        if (key === 'createSandbox') return async (...args) => {
          const allocated = await target.createSandbox(...args)
          await record(allocated.id, allocated.metadata)
          return allocated
        }
        const value = target[key]
        return typeof value === 'function' ? value.bind(target) : value
      } }) }
    },
  }
}

/** Allocate, persist ownership, then import exactly the fixed R1 snapshot. */
export async function openManagedSandbox({ store, taskId, sdk, connectionConfig, image }) {
  const task = await store.get(taskId)
  if (task.kind !== 'modify' || task.status !== 'running' || !task.snapshotId) {
    throw new TaskEntryError('SANDBOX_TASK_INVALID', 409)
  }
  if (!sdk?.Sandbox?.create || !sdk?.SandboxManager?.create || !connectionConfig
    || connectionConfig.domain !== '127.0.0.1:3088' || connectionConfig.protocol && connectionConfig.protocol !== 'http') {
    throw new TaskEntryError('SANDBOX_CONFIG_INVALID', 400)
  }
  const options = sandboxOptions(image, taskId)
  const manager = sdk.SandboxManager.create({ connectionConfig })
  let sandbox, recorded = false
  const record = async (id, metadata) => {
    if (metadata && metadata['iteroom-task-id'] !== taskId) throw new TaskEntryError('SANDBOX_OWNER_MISMATCH', 503)
    await store.recordSandbox(taskId, id)
    recorded = true
  }
  try {
    const adapterFactory = captureFactory(sdk, record)
    sandbox = await sdk.Sandbox.create({ ...options, connectionConfig, ...(adapterFactory ? { adapterFactory } : {}) })
    if (!recorded) await record(sandbox.id)
    if (sandbox.isHealthy && !await sandbox.isHealthy()) throw new TaskEntryError('SANDBOX_NOT_HEALTHY', 503)
    await sandbox.files.createDirectories([{ path: '/workspace', mode: 755 },
      ...[...new Set(task.paths.flatMap(path => path.split('/').slice(0, -1).map((_, i) =>
        `/workspace/${path.split('/').slice(0, i + 1).join('/')}`)))].sort().map(path => ({ path, mode: 755 }))])
    const files = await Promise.all(task.paths.map(path => readManagedSnapshotFile(store, taskId, path)))
    await sandbox.files.writeFiles(files.map(file => ({ path: `/workspace/${file.path}`, data: file.text, mode: 644 })))
    for (const file of files) {
      if (await sandbox.files.readFile(`/workspace/${file.path}`) !== file.text) {
        throw new TaskEntryError('SANDBOX_IMPORT_MISMATCH', 503)
      }
    }
    return { store, taskId, sandbox, manager, files,
      async cleanup() {
        const current = await store.get(taskId)
        if (current.sandboxId !== sandbox.id) throw new TaskEntryError('SANDBOX_OWNER_MISMATCH', 503)
        let absent = false
        try {
          const info = await manager.getSandboxInfo(sandbox.id)
          if (info.metadata?.['iteroom-task-id'] !== taskId) throw new TaskEntryError('SANDBOX_OWNER_MISMATCH', 503)
          await store.markSandboxStopping(taskId)
          await manager.killSandbox(sandbox.id)
        } catch (error) { if (error.statusCode === 404) absent = true; else throw error }
        for (let attempt = 0; attempt < 40; attempt++) {
          try { await manager.getSandboxInfo(sandbox.id) }
          catch (error) { if (error.statusCode === 404) { absent = true; break } throw error }
          await sleep(100)
        }
        if (!absent) throw new TaskEntryError('SANDBOX_CLEANUP_UNCONFIRMED', 503)
        await store.markSandboxCleaned(taskId)
        await sandbox.close(); await manager.close()
      },
    }
  } catch (error) {
    if (recorded && sandbox) {
      try {
        const info = await manager.getSandboxInfo(sandbox.id)
        if (info.metadata?.['iteroom-task-id'] === taskId) await manager.killSandbox(sandbox.id)
      } catch { /* task remains with allocated sandbox for later reconciliation */ }
    }
    await sandbox?.close().catch(() => {})
    await manager.close().catch(() => {})
    throw error
  }
}

export async function runManagedTest(session, paths) {
  const task = await session.store.get(session.taskId)
  if (task.status !== 'running' || task.sandboxStatus !== 'allocated'
    || !Array.isArray(paths) || !paths.length || paths.length > 16
    || paths.some(path => !task.paths.includes(path) || !/\.test\.[cm]?js$/.test(path))) {
    throw new TaskEntryError('SANDBOX_TEST_SCOPE_DENIED', 403)
  }
  const command = shellLiteral(['node', '--test', ...paths])
  if (Buffer.byteLength(command) > 4096) throw new TaskEntryError('SANDBOX_TEST_SCOPE_DENIED', 403)
  let executionId, output = '', started
  const append = chunk => {
    output += chunk.text
    if (Buffer.byteLength(output) > 65536) throw new TaskEntryError('SANDBOX_OUTPUT_LIMIT', 503)
  }
  try {
    const result = await session.sandbox.commands.run(command, { workingDirectory: '/workspace', timeoutSeconds: 30 },
      { onInit: init => { executionId = init.id; started = session.store.recordExecutionStart(session.taskId,
        { id: init.id, kind: 'test', command, cwd: '/workspace' }) },
      onStdout: append, onStderr: append, skipAccumulation: true })
    await started
    if (!result.id || result.id !== executionId) throw new TaskEntryError('SANDBOX_EXECUTION_ID_MISMATCH', 503)
    const stopping = (await session.store.get(session.taskId)).sandboxStatus !== 'allocated'
    const status = stopping ? 'interrupted' : result.error ? 'failed' : result.exitCode === 0 ? 'completed' : 'failed'
    const exitCode = stopping ? null : result.error && result.exitCode === 0 ? 1 : result.exitCode ?? 1
    await session.store.finishExecution(session.taskId, executionId, { status,
      exitCode, outputSha256: digest(output), outputBytes: Buffer.byteLength(output),
      outputExcerpt: Buffer.from(output).subarray(0, 8192).toString('utf8') })
    return { id: executionId, status, exitCode, output }
  } catch (error) {
    if (started) await started
    if (executionId) {
      let stopped = false
      try {
        const status = await session.sandbox.commands.getCommandStatus(executionId)
        if (status.running) await session.sandbox.commands.interrupt(executionId)
        stopped = (await session.sandbox.commands.getCommandStatus(executionId)).running === false
      } catch { /* unknown remote state; never replay */ }
      try {
        await session.store.finishExecution(session.taskId, executionId, { status: stopped ? 'interrupted' : 'unknown',
          exitCode: null, outputSha256: digest(output), outputBytes: Math.min(Buffer.byteLength(output), 65536),
          outputExcerpt: Buffer.from(output).subarray(0, 8192).toString('utf8') })
      } catch (recordError) {
        const current = (await session.store.get(session.taskId)).executions?.find(item => item.id === executionId)
        if (recordError.code !== 'EXECUTION_STATE_CONFLICT' || current?.status !== 'interrupted'
          || (await session.store.get(session.taskId)).sandboxStatus !== 'cleaned') throw recordError
      }
    }
    throw new TaskEntryError('SANDBOX_EXECUTION_UNKNOWN', 503)
  }
}

function patchLines(text) {
  if (!text) return { lines: [], trailing: false }
  const parts = text.split('\n')
  const trailing = parts.at(-1) === ''
  if (trailing) parts.pop()
  return { lines: parts, trailing }
}

/** Export a valid whole-file unified patch without reading the mutable host project. */
export async function exportManagedPatch(session) {
  const changes = [], parts = []
  const selected = new Set(session.files.map(file => `/workspace/${file.path}`))
  const listed = await session.sandbox.files.listDirectory({ path: '/workspace', depth: 16 })
  if (!Array.isArray(listed) || listed.length > 128) throw new TaskEntryError('SANDBOX_FILE_INVENTORY_INVALID', 503)
  const observed = new Set()
  for (const entry of listed) {
    if (entry?.type === 'directory') continue
    if (entry?.type !== 'file' || !selected.has(entry.path) || observed.has(entry.path)) {
      throw new TaskEntryError('SANDBOX_FILE_SCOPE_CHANGED', 409)
    }
    observed.add(entry.path)
  }
  if (observed.size !== selected.size) throw new TaskEntryError('SANDBOX_FILE_SCOPE_CHANGED', 409)
  for (const file of session.files) {
    const text = await session.sandbox.files.readFile(`/workspace/${file.path}`)
    if (typeof text !== 'string' || Buffer.byteLength(text) > 262144 || text.includes('\0')
      || !text.isWellFormed()) {
      throw new TaskEntryError('SANDBOX_OUTPUT_INVALID', 503)
    }
    if (text === file.text) continue
    if (/\.test\.[cm]?js$/.test(file.path)) throw new TaskEntryError('SANDBOX_TEST_FILE_CHANGED', 409)
    const before = patchLines(file.text), after = patchLines(text)
    const count = lines => lines.length === 0 ? '0,0' : `1,${lines.length}`
    const hunk = [`diff --git a/${file.path} b/${file.path}`, `--- a/${file.path}`, `+++ b/${file.path}`,
      `@@ -${count(before.lines)} +${count(after.lines)} @@`,
      ...before.lines.flatMap((line, i) => [`-${line}`, ...(!before.trailing && i === before.lines.length - 1 ? ['\\ No newline at end of file'] : [])]),
      ...after.lines.flatMap((line, i) => [`+${line}`, ...(!after.trailing && i === after.lines.length - 1 ? ['\\ No newline at end of file'] : [])])]
    parts.push(hunk.join('\n') + '\n')
    changes.push({ path: file.path, kind: 'modified', beforeSha256: file.sha256, afterSha256: digest(text),
      beforeBytes: file.byteLength, afterBytes: Buffer.byteLength(text) })
  }
  const patch = parts.join('')
  if (!changes.length || Buffer.byteLength(patch) > 1024 * 1024) throw new TaskEntryError('SANDBOX_PATCH_INVALID', 409)
  return { version: 1, taskId: session.taskId, snapshotId: (await session.store.get(session.taskId)).snapshotId,
    changes, patch, sha256: digest(patch) }
}
