import { readFile, lstat } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createModelRequestGuard } from '../model-request-guard.mjs'
import { openModelBudgetJournal } from '../model-budget-journal.mjs'
import { estimateWorstCostCny, validateApprovedModelConfig } from '../model-cost-bound.mjs'
import { executeSandboxAction, forwardAdapterFactory } from '../dsh-sandbox-tool.mjs'

export const name = 'iteroom-r0-live-model-probe'
export const inject = ['llm', 'tools', 'agents', 'sessionPersistence']
const FIXTURE = "export function greet(name: string) { return 'Hello, synthetic ' + name }\n"
const REQUEST_BYTES = 32768

export async function apply(ctx, config) {
  const home = process.env.DSH_HOME
  if (!home || resolve(config.privateConfig) !== resolve(home, 'sandbox-config.json')) throw Error('Unmanaged live probe config')
  const privateConfig = JSON.parse(await readFile(config.privateConfig, 'utf8'))
  if (!privateConfig.modelConfigPath || !privateConfig.budgetRoot || !privateConfig.root) throw Error('Incomplete live probe config')
  const modelFile = await lstat(privateConfig.modelConfigPath)
  if (!modelFile.isFile() || modelFile.isSymbolicLink() || modelFile.nlink !== 1 || modelFile.size > 4096) throw Error('Unsafe live model config')
  const approved = validateApprovedModelConfig(JSON.parse(await readFile(privateConfig.modelConfigPath, 'utf8')))
  const worstCostCny = estimateWorstCostCny({ maxRequests: approved.maxRequests,
    maxOutputTokens: approved.maxOutputTokens, maxRequestBytes: REQUEST_BYTES, capCny: approved.maxCostCny })
  const candidate = createModelRequestGuard({ baseURL: approved.baseURL, model: approved.model,
    maxRequests: approved.maxRequests, maxOutputTokens: approved.maxOutputTokens, maxRequestBytes: REQUEST_BYTES,
    commit: async () => {}, transport: async () => {}, authorized: false })
  const journal = await openModelBudgetJournal({ root: privateConfig.budgetRoot, identity: candidate.snapshot().identity })
  const metrics = { toolRoster: [], modelAttempts: journal.state.attempts, worstCostCny,
    readExecutions: 0, sandbox: { toolExecutions: 0, executions: [] } }
  const save = () => writeFileSync(join(home, 'live-metrics.json'), JSON.stringify(metrics))
  const nativeFetch = globalThis.fetch
  const guard = createModelRequestGuard({ baseURL: approved.baseURL, model: approved.model, authorized: true,
    maxRequests: approved.maxRequests, maxOutputTokens: approved.maxOutputTokens, maxRequestBytes: REQUEST_BYTES,
    state: journal.state, commit: async next => { await journal.commit(next); metrics.modelAttempts = next.attempts; save() },
    transport: nativeFetch })
  globalThis.fetch = (url, init) => {
    const address = typeof url === 'string' ? url : url?.url
    if (typeof address === 'string' && address.startsWith('http://127.0.0.1:3088/')) return nativeFetch(url, init)
    return guard(url, init)
  }
  ctx.effect(() => async () => { globalThis.fetch = nativeFetch; await journal.close() })

  const root = resolve(privateConfig.root)
  const sdk = await import(pathToFileURL(join(root, 'sdk/node_modules/@alibaba-group/opensandbox/dist/index.js')).href)
  const connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http',
    apiKey: (await readFile(join(root, 'r0-key'), 'utf8')).trim(), useServerProxy: true,
    disableMetrics: true, requestTimeoutSeconds: 15 }
  const sandbox = await sdk.Sandbox.connect({ sandboxId: privateConfig.sandboxId, connectionConfig,
    adapterFactory: forwardAdapterFactory(sdk.createDefaultAdapterFactory()) })
  if ((await sandbox.getInfo()).metadata?.['iteroom-r0-owner'] !== privateConfig.owner) throw Error('Sandbox ownership mismatch')
  ctx.effect(() => () => sandbox.close())

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_read_fixture', description: 'Read only the synthetic in-memory src/greet.ts fixture.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (args.path !== 'src/greet.ts') throw Error('Outside fixed fixture')
      metrics.readExecutions++; save(); return FIXTURE
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_sandbox_probe', description: 'Repair the fixed synthetic addition fixture in the owned sandbox, then run its test.',
    parameters: { action: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      return executeSandboxAction(sandbox, args, exec.signal, metrics.sandbox, save, () => {})
    },
  })))
  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name === 'iteroom_read_fixture' && Object.keys(exec.arguments ?? {}).length === 1
      && exec.arguments.path === 'src/greet.ts') return
    if (exec.name === 'iteroom_sandbox_probe' && Object.keys(exec.arguments ?? {}).length === 1
      && exec.arguments.action === 'repair' && config.resume !== true) return
    return 'Outside fixed live probe scope'
  }))

  const connection = resolveAdapterOptions({ baseURL: approved.baseURL, apiKeyEnv: 'ITEROOM_R0_ONLY',
    thinking: 'disabled', reasoningEffort: 'off', maxTokens: 128,
    models: [{ id: approved.model, contextWindow: 8192, maxTokens: 128 }],
    streamIdleTimeoutMs: 60000, retryPolicy: { mode: 'normal', maxRetries: 0 } })
  const adapter = new DeepSeekAdapter({ options: () => connection, resolveApiKey: async () => approved.apiKey,
    resolveUserId: () => 'iteroom-r0-synthetic-only', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
  ctx.effect(() => ctx.llm.registerAdapter([approved.provider], adapter))
  metrics.toolRoster = ctx.tools.schemas().map(tool => tool.name).sort()
  if (JSON.stringify(metrics.toolRoster) !== JSON.stringify(['iteroom_read_fixture', 'iteroom_sandbox_probe'])) throw Error('Unexpected live tool roster')
  save()
  if (config.resume === true) {
    const handle = await ctx.agents.resume({ resumeSessionId: 'r0-live-repair',
      agentOptions: { provider: approved.provider, model: approved.model, maxTokens: 128 } })
    ctx.effect(() => () => handle.dispose())
    await handle.agent.whenIdle()
    await ctx.sessionPersistence.flush()
  }
}
