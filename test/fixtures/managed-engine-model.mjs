import { writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'iteroom-managed-engine-synthetic-model'
export const inject = ['llm', 'tools']

export function apply(ctx) {
  const metrics = { calls: 0, sawFixedBytes: false, roster: [], maxTokens: null }
  const save = () => writeFileSync(join(process.env.DSH_HOME, 'managed-engine-metrics.json'), JSON.stringify(metrics))
  const progress = text => {
    if (process.env.ITEROOM_PROGRESS_FD === '3') writeSync(3, JSON.stringify({ type: 'text', text }) + '\n')
  }
  class SyntheticAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (provider !== 'iteroom-r1-mock' || model !== 'synthetic') throw new LlmError('Unsupported route', 'MOCK_ROUTE')
      return { provider, id: model, name: 'Synthetic R1 model', inputModalities: ['text'],
        context: { contextWindow: 8192 }, defaultMaxTokens: 128 }
    }
    async *stream(options) {
      options.signal.throwIfAborted()
      metrics.calls++
      metrics.maxTokens = options.maxTokens
      metrics.roster = options.tools.map(tool => tool.name).sort()
      if (JSON.stringify(metrics.roster) !== JSON.stringify(['iteroom_read_snapshot'])) {
        throw new LlmError('Unexpected capability', 'MOCK_TOOL_SCOPE')
      }
      if (JSON.stringify(options.messages).includes('Hold synthetic model')) {
        progress('Synthetic model is waiting. ')
        await new Promise((_resolve, reject) => {
          const timer = setInterval(() => {}, 1000)
          options.signal.addEventListener('abort', () => {
            clearInterval(timer)
            reject(new LlmError('Synthetic cancelled', 'MOCK_CANCELLED'))
          }, { once: true })
        })
      }
      const result = options.messages.flatMap(message => message.content)
        .filter(block => block.type === 'tool-result').at(-1)
      if (!result) {
        save()
        progress('Reading fixed input. ')
        const id = ToolCallId('synthetic-r1-read')
        // A model may request past EOF and the per-read output cap.
        const args = JSON.stringify({ path: 'src/example.ts', startLine: 1, endLine: 200 })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'iteroom_read_snapshot', argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'iteroom_read_snapshot', arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      metrics.sawFixedBytes = !result.isError && result.content.some(part => part.type === 'text'
        && part.text.includes('1: export const answer = 42')
        && !part.text.includes('1: export const answer = 99') && part.text.includes('src/example.ts'))
      save()
      const range = result.content.find(part => part.type === 'text')?.text.match(/\nLines: (\d+-\d+)\n/)?.[1]
      const answer = metrics.sawFixedBytes ? `The fixed file defines answer=42 (src/example.ts:${range}).` : 'No verified source.'
      progress(answer)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['iteroom-r1-mock'], new SyntheticAdapter()))
  save()
}
