import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runDshSandboxProbe, summarizeObservedUsage } from '../scripts/r0/dsh-sandbox-probe.mjs'

test('live Gate A probe requires explicit authorization before preflight or credentials', async () => {
  const report = await runDshSandboxProbe(undefined, { authorized: false, realModel: true })
  assert.equal(report.status, 'unavailable')
  assert.equal(report.errorCode, 'model_not_authorized')
  assert.equal(report.actualModel, false)
  assert.equal(report.actualSandbox, false)
})

test('live usage evidence requires every reserved request to have valid provider token counts', () => {
  const events = [{ type: 'assistant/message', data: { usage: { inputTokens: 10, cacheReadTokens: 3, outputTokens: 5 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 2 } } }]
  assert.deepEqual(summarizeObservedUsage(events, 2), { successfulSteps: 2, inputTokens: 17,
    cacheReadTokens: 3, outputTokens: 7 })
  assert.throws(() => summarizeObservedUsage(events, 3), { code: 'model_usage_incomplete' })
  assert.throws(() => summarizeObservedUsage([{ type: 'assistant/message', data: { usage: { inputTokens: NaN, outputTokens: 2 } } }], 1), { code: 'model_usage_incomplete' })
})
