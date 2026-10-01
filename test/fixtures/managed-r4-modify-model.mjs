import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'iteroom-r4-modify-synthetic-model'
export const inject = ['llm', 'tools']
export function apply(ctx) {
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (provider !== 'iteroom-r2-mock' || model !== 'synthetic') throw new LlmError('Unsupported route', 'MOCK_ROUTE')
      return { provider, id: model, name: 'Synthetic R4 repair', inputModalities: ['text'], context: { contextWindow: 8192 }, defaultMaxTokens: 512 }
    }
    async *stream(options) {
      options.signal.throwIfAborted()
      if (JSON.stringify(options.tools.map(tool => tool.name).sort()) !== JSON.stringify(['iteroom_read_snapshot', 'iteroom_replace_file', 'iteroom_run_tests'])) throw new LlmError('Unexpected tools', 'MOCK_SCOPE')
      const results = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      if (results.some(result => result.isError)) throw new LlmError('Failed tool', 'MOCK_RESULT')
      const steps = [
        ['iteroom_read_snapshot', { path: 'src/divide.mjs', startLine: 1, endLine: 1 }],
        ['iteroom_read_snapshot', { path: 'src/divide.test.mjs', startLine: 1, endLine: 4 }],
        ['iteroom_replace_file', { path: 'src/divide.mjs', content: 'export const divide = value => value / 2\n' }],
        ['iteroom_run_tests', {}],
      ]
      if (results.length < steps.length) {
        const [name, value] = steps[results.length], id = ToolCallId(`r4-repair-${results.length}`), args = JSON.stringify(value)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const text = 'The selected sandbox test completed. The patch awaits user acceptance.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['iteroom-r2-mock'], new Adapter()))
}
