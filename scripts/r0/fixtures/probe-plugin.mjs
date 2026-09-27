import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LlmAdapter, LlmError, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

// This is probe data, not a filesystem-backed product tool.
export const FIXTURE = "export function greet(name: string) { return 'Hello, synthetic ' + name }\n"
export const PROVIDER = 'iteroom-r0-mock'
export const MODEL = 'synthetic-only'
export const name = 'iteroom-r0-probe'
export const inject = ['llm', 'tools', 'agents', 'agentLoop', 'sessionPersistence']

export async function apply(ctx, config) {
  const home = process.env.DSH_HOME
  if (!home || resolve(config.metrics) !== resolve(home, 'probe-metrics.json')) {
    throw new Error('Probe metrics must remain inside the owned DSH_HOME')
  }
  const metrics = { toolRoster: [], cases: {} }
  const save = () => writeFileSync(config.metrics, JSON.stringify(metrics))
  let active = 'R0_LOOP'
  const current = () => metrics.cases[active] ??= { modelCalls: 0, toolExecutions: 0, guardDenials: 0 }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'iteroom_read_fixture',
    description: 'Read the synthetic in-memory src/greet.ts fixture; no host file access.',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (args.path !== 'src/greet.ts') throw new Error('Outside synthetic probe scope')
      current().toolExecutions++
      save()
      return FIXTURE
    },
  })))
  ctx.effect(() => ctx.tools.guard(exec => {
    if (exec.name !== 'iteroom_read_fixture' || exec.arguments?.path !== 'src/greet.ts') {
      current().guardDenials++
      save()
      return 'Outside synthetic probe scope'
    }
  }))

  class SyntheticAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (provider !== PROVIDER || model !== MODEL) throw new LlmError('Unsupported probe route', 'ITEROOM_MOCK_ROUTE')
      return { provider, id: model, name: 'Synthetic probe', inputModalities: ['text'],
        context: { contextWindow: 8192 }, defaultMaxTokens: 128 }
    }
    async *stream(options) {
      options.signal.throwIfAborted()
      const messages = options.messages
      let lastInput = -1
      for (let i = 0; i < messages.length; i++) {
        const marker = messages[i].content.find(block => block.type === 'text' && /^R0_[A-Z]+$/.test(block.text))
        if (marker) { active = marker.text; lastInput = i }
      }
      if (lastInput < 0 || !['R0_LOOP', 'R0_DENIED', 'R0_FAILURE', 'R0_CANCEL', 'R0_RESUME'].includes(active)) {
        throw new LlmError('Unknown synthetic input', 'ITEROOM_MOCK_INPUT')
      }
      const state = current()
      state.modelCalls++
      metrics.toolRoster = options.tools.map(tool => tool.name).sort()
      if (JSON.stringify(metrics.toolRoster) !== JSON.stringify(['iteroom_read_fixture'])) {
        throw new LlmError('Unexpected probe capability', 'ITEROOM_MOCK_SCOPE')
      }
      save()
      if (active === 'R0_FAILURE') throw new LlmError('Synthetic model failure', 'ITEROOM_MOCK_FAILURE')
      if (active === 'R0_CANCEL') {
        const agent = ctx.agents.get('r0-cancel')
        if (!agent) throw new Error('Synthetic cancellation agent missing')
        await new Promise((resolveAbort, reject) => {
          const onAbort = () => { state.signalObserved = true; save(); resolveAbort() }
          options.signal.addEventListener('abort', onAbort, { once: true })
          setImmediate(() => {
            try {
              agent.cancel({ kind: 'user' })
              // Observe idle outside the stream: waiting inside would deadlock the turn.
              agent.whenIdle().then(() => { state.whenIdleResolved = true; save() }, reject)
            } catch (error) {
              options.signal.removeEventListener('abort', onAbort)
              reject(error)
            }
          })
        })
        options.signal.throwIfAborted()
      }
      if (active === 'R0_RESUME') {
        state.historySawFixture = messages.slice(0, lastInput).some(message => message.content.some(block =>
          block.type === 'tool-result' && block.content.some(part => part.type === 'text' && part.text === FIXTURE)))
        save()
      }
      const results = messages.slice(lastInput + 1).flatMap(message => message.content).filter(block => block.type === 'tool-result')
      if ((active === 'R0_LOOP' || active === 'R0_DENIED') && results.length === 0) {
        const id = ToolCallId(`synthetic-${active}`)
        const args = JSON.stringify({ path: active === 'R0_DENIED' ? '../outside.ts' : 'src/greet.ts' })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'iteroom_read_fixture', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'iteroom_read_fixture', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (active === 'R0_LOOP') {
        state.nextStepSawResult = results.some(block => !block.isError && block.content.some(part => part.type === 'text' && part.text === FIXTURE))
        save()
      }
      const text = active === 'R0_DENIED' ? 'Synthetic read denied. No verification command was run.'
        : 'Synthetic probe response. No verification command was run.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], new SyntheticAdapter()))
  metrics.toolRoster = ctx.tools.schemas().map(tool => tool.name).sort()
  save()
  if (config.resume === true) {
    const handle = await ctx.agents.resume({ resumeSessionId: 'r0-loop',
      agentOptions: { provider: PROVIDER, model: MODEL, maxTokens: 128 } })
    ctx.effect(() => () => handle.dispose())
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'R0_RESUME' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await ctx.sessionPersistence.flush()
  }
}
