import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'iteroom-review-synthetic-model'
export const inject = ['llm', 'tools']
export function apply(ctx) {
  const metrics = { calls: 0, roster: [], contexts: [], maxTokens: null }
  const save = () => writeFileSync(join(process.env.DSH_HOME, 'review-metrics.json'), JSON.stringify(metrics))
  class SyntheticAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      if (provider !== 'iteroom-r4-mock' || model !== 'synthetic') throw new LlmError('Unsupported synthetic route', 'MOCK_ROUTE')
      return { provider, id: model, name: 'Synthetic R4 model', inputModalities: ['text'],
        context: { contextWindow: 8192 }, defaultMaxTokens: 512 }
    }
    async *stream(options) {
      options.signal.throwIfAborted()
      metrics.calls++; metrics.maxTokens = options.maxTokens; metrics.roster = options.tools.map(tool => tool.name).sort()
      if (JSON.stringify(metrics.roster) !== JSON.stringify(['iteroom_review_context'])) throw new LlmError('Unexpected tools', 'MOCK_SCOPE')
      const results = options.messages.flatMap(message => message.content).filter(block => block.type === 'tool-result')
      if (!results.length) {
        save()
        const prompt = options.messages.flatMap(message => message.content).findLast(block => block.type === 'text')?.text
        const groups = JSON.parse(prompt.match(/fixed groups: (.+)\. Read all/)[1])
        for (const [index, group] of groups.entries()) {
          const id = ToolCallId(`synthetic-review-${group.groupId}`), args = JSON.stringify({ groupId: group.groupId })
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: 'iteroom_review_context', argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: 'iteroom_review_context', arguments: args } }
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return
      }
      const contexts = results.map(result => {
        if (result.isError) throw new LlmError('Context unavailable', 'MOCK_CONTEXT')
        return JSON.parse(result.content.find(part => part.type === 'text').text)
      })
      metrics.contexts = contexts; save()
      const text = JSON.stringify({ groups: contexts.map(group => ({ groupId: group.groupId,
        findings: group.files.filter(file => file.new?.text.includes('value / 0')).map(file => ({ path: file.path,
          side: 'new', quote: 'value / 0', severity: 'high', message: 'Synthetic candidate: division uses zero.' })) })) })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['iteroom-r4-mock'], new SyntheticAdapter()))
  save()
}
