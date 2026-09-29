import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'iteroom-managed-modify-synthetic-model'
export const inject = ['llm', 'tools']

export function apply(ctx) {
  class SyntheticModifyAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (provider !== 'iteroom-r2-mock' || model !== 'synthetic') throw new LlmError('Unsupported route', 'MOCK_ROUTE')
      return { provider, id: model, name: 'Synthetic R2 model', inputModalities: ['text'],
        context: { contextWindow: 8192 }, defaultMaxTokens: 512 }
    }
    async *stream(options) {
      options.signal.throwIfAborted()
      if (JSON.stringify(options.messages).includes('Hold synthetic model')) {
        await new Promise((_resolve, reject) => {
          const timer = setInterval(() => {}, 1000)
          options.signal.addEventListener('abort', () => {
            clearInterval(timer)
            reject(new LlmError('Synthetic cancelled', 'MOCK_CANCELLED'))
          }, { once: true })
        })
      }
      const roster = options.tools.map(tool => tool.name).sort()
      if (JSON.stringify(roster) !== JSON.stringify(['iteroom_read_snapshot', 'iteroom_replace_file', 'iteroom_run_tests'])) {
        throw new LlmError('Unexpected capability', 'MOCK_TOOL_SCOPE')
      }
      const results = options.messages.flatMap(message => message.content)
        .filter(block => block.type === 'tool-result')
      const steps = [
        ['iteroom_read_snapshot', { path: 'greet.mjs', startLine: 1, endLine: 2 }],
        ['iteroom_read_snapshot', { path: 'greet.test.mjs', startLine: 1, endLine: 5 }],
        ['iteroom_replace_file', { path: 'greet.mjs', content: 'export const greet = () => "Hello"\n' }],
        ['iteroom_run_tests', {}],
      ]
      if (results.some(result => result.isError) || results.length > steps.length) {
        throw new LlmError('Unexpected tool result', 'MOCK_TOOL_RESULT')
      }
      if (results.length < steps.length) {
        const [name, value] = steps[results.length]
        const id = ToolCallId(`synthetic-r2-${results.length}`)
        const args = JSON.stringify(value)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const final = 'The sandbox test passed; the host project was not changed.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: final }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: final } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['iteroom-r2-mock'], new SyntheticModifyAdapter()))
}
