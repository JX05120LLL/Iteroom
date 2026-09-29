import { defineTool } from '@deepseek-ai/dsh-tools'
import { Sandbox, createDefaultAdapterFactory } from '@alibaba-group/opensandbox'
import { ManagedTaskStore } from './managed-task-store.js'
import { readManagedSnapshotFile } from './managed-snapshot.js'
import { configureManagedModel, renderRange } from './managed-engine-plugin.js'
import { runManagedTest } from './managed-sandbox.js'

export const name = 'iteroom-managed-modify-engine'
export const inject = ['tools', 'llm']

function sandboxFactory() {
  const factory = createDefaultAdapterFactory()
  return { ...factory,
    createLifecycleStack: options => factory.createLifecycleStack(options),
    createEgressStack: options => factory.createEgressStack(options),
    createNetworkPolicyStack: options => factory.createNetworkPolicyStack(options),
    createExecdStack: options => factory.createExecdStack({ ...options,
      connectionConfig: { ...options.connectionConfig, sseFetch: globalThis.fetch } }),
  }
}

export async function apply(ctx, config) {
  if (!config || typeof config.dataHome !== 'string' || typeof config.projectRoot !== 'string'
    || typeof config.taskId !== 'string' || typeof config.sandboxId !== 'string') {
    throw Error('Managed modify configuration missing')
  }
  const store = new ManagedTaskStore(config.dataHome, config.projectRoot)
  const task = await store.get(config.taskId)
  if (task.kind !== 'modify' || task.sandboxId !== config.sandboxId || task.sandboxStatus !== 'allocated') {
    throw Error('Managed modify sandbox is not allocated')
  }
  const connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http',
    apiKey: process.env.ITEROOM_SANDBOX_API_KEY, useServerProxy: true, disableMetrics: true,
    requestTimeoutSeconds: 15 }
  if (!connectionConfig.apiKey) throw Error('Managed sandbox key missing')
  const sandbox = await Sandbox.connect({ sandboxId: task.sandboxId, connectionConfig,
    adapterFactory: sandboxFactory() })
  const info = await sandbox.getInfo()
  if (info.metadata?.['iteroom-task-id'] !== task.id || !await sandbox.isHealthy()) {
    await sandbox.close()
    throw Error('Managed sandbox ownership or health mismatch')
  }
  ctx.effect(() => () => sandbox.close())
  const selected = new Set(task.paths)
  const tests = task.paths.filter(path => /\.test\.[cm]?js$/.test(path))
  if (!tests.length) throw Error('At least one selected test file is required')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_read_snapshot',
    description: 'Read exact task-selected input with numbered lines and fixed snapshot hash.',
    parameters: { path: { type: 'string', required: true }, startLine: { type: 'number', required: true },
      endLine: { type: 'number', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!selected.has(args.path)) throw Error('READ_PATH_DENIED')
      const file = await readManagedSnapshotFile(store, task.id, args.path)
      exec.signal.throwIfAborted()
      return renderRange(file, args.startLine, args.endLine)
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_replace_file',
    description: 'Replace one selected non-test UTF-8 file in the isolated sandbox only. No host write.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!selected.has(args.path) || /\.test\.[cm]?js$/.test(args.path)
        || typeof args.content !== 'string' || Buffer.byteLength(args.content) > 262144
        || args.content.includes('\0') || !args.content.isWellFormed()) throw Error('WRITE_SCOPE_DENIED')
      await sandbox.files.writeFiles([{ path: `/workspace/${args.path}`, data: args.content, mode: 644 }])
      if (await sandbox.files.readFile(`/workspace/${args.path}`) !== args.content) throw Error('WRITE_CONFIRMATION_FAILED')
      exec.signal.throwIfAborted()
      return 'Sandbox file replacement confirmed. Run iteroom_run_tests; no host file was written.'
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_run_tests',
    description: 'Run node --test on the selected fixed test files in the isolated sandbox. Report actual exit code.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const result = await runManagedTest({ store, taskId: task.id, sandbox }, tests)
      return JSON.stringify({ executionId: result.id, status: result.status, exitCode: result.exitCode,
        output: result.output.slice(0, 8192) })
    },
  })))
  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name === 'iteroom_read_snapshot' && exec.arguments
      && Object.keys(exec.arguments).sort().join(',') === 'endLine,path,startLine'
      && selected.has(exec.arguments.path)) return
    if (exec.name === 'iteroom_replace_file' && exec.arguments
      && Object.keys(exec.arguments).sort().join(',') === 'content,path'
      && selected.has(exec.arguments.path) && !/\.test\.[cm]?js$/.test(exec.arguments.path)) return
    if (exec.name === 'iteroom_run_tests' && exec.arguments && Object.keys(exec.arguments).length === 0) return
    return 'Outside managed sandbox scope'
  }))
  const roster = ctx.tools.schemas().map(tool => tool.name).sort()
  if (JSON.stringify(roster) !== JSON.stringify(['iteroom_read_snapshot', 'iteroom_replace_file', 'iteroom_run_tests'])) {
    throw Error('Managed modify tool roster contains unexpected capability')
  }
  await configureManagedModel(ctx, config)
}
