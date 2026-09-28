import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LlmAdapter, LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { validatePocRoot } from '../sandbox-preflight.mjs'
import { validateAction, executeSandboxAction, forwardAdapterFactory } from '../dsh-sandbox-tool.mjs'

export const PROVIDER = 'iteroom-r0-sandbox-mock'
export const MODEL = 'synthetic-only'
export const name = 'iteroom-r0-sandbox-probe'
export const inject = ['llm', 'tools', 'agents', 'agentLoop', 'sessionPersistence']
export async function apply(ctx, config) {
  const home = process.env.DSH_HOME
  if (!home || resolve(config.privateConfig) !== resolve(home, 'sandbox-config.json')) throw Error('Unmanaged private probe config')
  const privateConfig = JSON.parse(readFileSync(config.privateConfig, 'utf8'))
  const root = await validatePocRoot(privateConfig.root)
  const sdk = await import(pathToFileURL(join(root, 'sdk/node_modules/@alibaba-group/opensandbox/dist/index.js')).href)
  const connectionConfig = { domain: '127.0.0.1:3088', protocol: 'http', apiKey: readFileSync(join(root, 'r0-key'), 'utf8').trim(),
    useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 15 }
  const factory = sdk.createDefaultAdapterFactory()
  const adapterFactory = forwardAdapterFactory(factory)
  const sandbox = await sdk.Sandbox.connect({ sandboxId: privateConfig.sandboxId, connectionConfig, adapterFactory })
  if ((await sandbox.getInfo()).metadata?.['iteroom-r0-owner'] !== privateConfig.owner) throw Error('Sandbox ownership mismatch')
  ctx.effect(() => () => sandbox.close())
  const metrics = { toolRoster: [], cases: {} }, metricsFile = join(home, 'sandbox-metrics.json')
  const save = () => writeFileSync(metricsFile, JSON.stringify(metrics))
  let active = 'R0_REPAIR'
  const current = () => metrics.cases[active] ??= { modelCalls: 0, toolExecutions: 0, guardDenials: 0 }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_sandbox_probe', description: 'Perform a fixed synthetic repair, failure or cancellable wait in the owned sandbox.',
    parameters: { action: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const state = current()
      return executeSandboxAction(sandbox, args, exec.signal, state, save, () => {
        const agent = ctx.agents.get('r0-sandbox-cancel')
        if (!agent) throw Error('Cancel agent missing')
        agent.cancel({ kind: 'user' })
        agent.whenIdle().then(() => { state.whenIdleResolved = true; save() })
      })
    },
  })))
  ctx.effect(() => ctx.tools.guard(exec => {
    try { if (exec.name !== 'iteroom_sandbox_probe') throw Error('Unexpected tool'); validateAction(exec.arguments) }
    catch { current().guardDenials++; save(); return 'Outside fixed sandbox probe scope' }
  }))
  class SyntheticSandboxAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (provider !== PROVIDER || model !== MODEL) throw new LlmError('Wrong synthetic route', 'ITEROOM_MOCK_ROUTE')
      return { provider, id: model, name: 'Synthetic sandbox probe', inputModalities: ['text'], context: { contextWindow: 8192 }, defaultMaxTokens: 128 }
    }
    async *stream(options) {
      options.signal.throwIfAborted()
      let lastInput = -1
      for (let i = 0; i < options.messages.length; i++) {
        const marker = options.messages[i].content.find(block => block.type === 'text' && /^R0_[A-Z]+$/.test(block.text))
        if (marker) { active = marker.text; lastInput = i }
      }
      if (!['R0_REPAIR', 'R0_FAIL', 'R0_DENIED', 'R0_CANCEL', 'R0_RESUME'].includes(active) || lastInput < 0) throw new LlmError('Unknown synthetic input', 'ITEROOM_MOCK_INPUT')
      const state = current(); state.modelCalls++
      metrics.toolRoster = options.tools.map(tool => tool.name).sort()
      if (JSON.stringify(metrics.toolRoster) !== JSON.stringify(['iteroom_sandbox_probe'])) throw new LlmError('Unexpected tools', 'ITEROOM_MOCK_SCOPE')
      const results = options.messages.slice(lastInput + 1).flatMap(message => message.content).filter(block => block.type === 'tool-result')
      if (active === 'R0_RESUME') {
        state.historySawTool = options.messages.slice(0, lastInput).some(message => message.content.some(block => block.type === 'tool-result'))
      } else if (!results.length) {
        const id = ToolCallId(`synthetic-${active}`)
        const args = JSON.stringify(active === 'R0_DENIED' ? { action: 'repair', path: '../outside' }
          : { action: { R0_REPAIR: 'repair', R0_FAIL: 'fail', R0_CANCEL: 'wait' }[active] })
        save()
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'iteroom_sandbox_probe', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'iteroom_sandbox_probe', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      if (active === 'R0_REPAIR') state.nextStepSawResult = results.some(block => !block.isError && block.content.some(part => {
        if (part.type !== 'text') return false
        try { const result = JSON.parse(part.text); return result.exitCode === 0 && /synthetic addition/.test(result.output) } catch { return false }
      }))
      if (active === 'R0_FAIL') state.nextStepSawError = results.some(block => block.isError)
      save()
      const text = 'Synthetic follow-up; execution evidence is tracked separately.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new SyntheticSandboxAdapter()))
  metrics.toolRoster = ctx.tools.schemas().map(tool => tool.name).sort(); save()
  if (config.resume === true) {
    for (const resumeSessionId of ['r0-sandbox-repair', 'r0-sandbox-cancel']) {
      const handle = await ctx.agents.resume({ resumeSessionId, agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 128 } })
      ctx.effect(() => () => handle.dispose())
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R0_RESUME' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    }
    await ctx.sessionPersistence.flush()
  }
}
