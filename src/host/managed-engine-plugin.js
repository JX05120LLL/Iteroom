import { defineTool } from '@deepseek-ai/dsh-tools'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { writeSync } from 'node:fs'
import { ManagedTaskStore } from './managed-task-store.js'
import { readManagedSnapshotFile } from './managed-snapshot.js'
import { createManagedModelGuard } from './managed-model-guard.js'

export const name = 'iteroom-managed-read-engine'
export const inject = ['tools', 'llm']

function publishText(text) {
  if (process.env.ITEROOM_PROGRESS_FD !== '3' || typeof text !== 'string' || !text) return
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 512, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
    writeSync(3, JSON.stringify({ type: 'text', text: text.slice(start, end) }) + '\n')
    start = end
  }
}

export class ManagedDeepSeekAdapter extends DeepSeekAdapter {
  stream(options) { return this.relay(super.stream(options)) }

  async prepareCall(...args) {
    const call = await super.prepareCall(...args)
    return { ...call, stream: options => this.relay(call.stream(options)) }
  }

  async *relay(stream) {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') publishText(chunk.text)
      yield chunk
    }
  }
}

export function renderRange(file, startLine, endLine) {
  const lines = file.text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)
    || startLine < 1 || endLine < startLine
    || startLine > lines.length) throw Error(`READ_LINE_RANGE_INVALID: file has ${lines.length} lines`)
  const actualEnd = Math.min(endLine, lines.length, startLine + 119)
  const body = lines.slice(startLine - 1, actualEnd).map((line, i) => `${startLine + i}: ${line}`).join('\n')
  if (Buffer.byteLength(body, 'utf8') > 16 * 1024) throw Error('READ_RANGE_TOO_LARGE')
  return `Source: ${file.path}\nSnapshot: ${file.snapshotId}\nSHA-256: ${file.sha256}\nLines: ${startLine}-${actualEnd}\n${body}`
}

export async function apply(ctx, config) {
  if (!config || typeof config.dataHome !== 'string' || typeof config.projectRoot !== 'string'
    || typeof config.taskId !== 'string') throw Error('Managed engine configuration missing')
  const store = new ManagedTaskStore(config.dataHome, config.projectRoot)
  const task = await store.get(config.taskId)
  if (!task.snapshotId) throw Error('Managed snapshot is not ready')
  const selected = new Set(task.paths)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_read_snapshot',
    description: 'Read a numbered line range of an exact task-selected file from the fixed Iteroom snapshot. End past EOF or 120 lines is clipped to the actual returned range. Read-only; returns source path and snapshot hash for citations.',
    parameters: { path: { type: 'string', required: true },
      startLine: { type: 'number', required: true }, endLine: { type: 'number', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!selected.has(args.path)) throw Error('READ_PATH_DENIED')
      const file = await readManagedSnapshotFile(store, task.id, args.path)
      exec.signal.throwIfAborted()
      return renderRange(file, args.startLine, args.endLine)
    },
  })))
  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name !== 'iteroom_read_snapshot' || !exec.arguments
      || Object.keys(exec.arguments).sort().join(',') !== 'endLine,path,startLine'
      || !selected.has(exec.arguments.path)) return 'Outside managed read-only scope'
  }))
  const roster = ctx.tools.schemas().map(tool => tool.name).sort()
  if (JSON.stringify(roster) !== JSON.stringify(['iteroom_read_snapshot'])) {
    throw Error('Managed engine tool roster contains unexpected capability')
  }
  await configureManagedModel(ctx, config)
}

export async function configureManagedModel(ctx, config) {
  if (config.synthetic !== true) {
    const nativeFetch = globalThis.fetch
    const maxRequests = Number(process.env.ITEROOM_MODEL_MAX_REQUESTS)
    const maxOutputTokens = Number(process.env.ITEROOM_MODEL_MAX_OUTPUT_TOKENS)
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 4) {
      throw Error('Managed model request limit is invalid')
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 512) {
      throw Error('Managed model output limit is invalid')
    }
    const guard = await createManagedModelGuard({ home: process.env.DSH_HOME, transport: nativeFetch,
      maxRequests, maxOutputTokens, maxRequestBytes: 32768,
      toolProfile: config.review === true ? 'review' : config.modify === true ? 'modify' : 'read' })
    globalThis.fetch = guard
    ctx.effect(() => () => { globalThis.fetch = nativeFetch })
    const options = resolveAdapterOptions({ baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
      thinking: 'disabled', reasoningEffort: 'off', maxTokens: maxOutputTokens,
      models: [{ id: 'deepseek-flash', contextWindow: 8192, maxTokens: maxOutputTokens }],
      streamIdleTimeoutMs: 60000, retryPolicy: { mode: 'normal', maxRetries: 0 } })
    const adapter = new ManagedDeepSeekAdapter({ options: () => options,
      resolveApiKey: async () => process.env.DEEPSEEK_API_KEY,
      resolveUserId: () => 'iteroom-managed-local',
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
    ctx.effect(() => ctx.llm.registerAdapter(['deepseek'], adapter))
  }
}
