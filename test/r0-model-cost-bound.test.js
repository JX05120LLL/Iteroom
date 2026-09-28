import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateApprovedModelConfig, estimateWorstCostCny } from '../scripts/r0/model-cost-bound.mjs'

const approved = () => ({ provider: 'deepseek-official', baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash', apiKey: 'sk-synthetic-placeholder', maxRequests: 6,
  maxOutputTokens: 256, maxCostCny: 5 })

test('approved R0 model config and conservative six-request envelope stay below five yuan', () => {
  const config = validateApprovedModelConfig(approved())
  assert.equal(config.maxCostCny, 5)
  const bound = estimateWorstCostCny({ maxRequests: 6, maxOutputTokens: 256, maxRequestBytes: 32768 })
  assert.ok(bound > 2 && bound < 5)
})

test('changed endpoint, model, counts, key or missing approved yuan cap fail before transport', () => {
  for (const change of [{ baseURL: 'https://elsewhere.invalid' }, { model: 'deepseek-v4-pro' },
    { maxRequests: 7 }, { maxOutputTokens: 257 }, { apiKey: '' }, { maxCostCny: null },
    { maxCostCny: 1 }, { extra: 'unexpected' }]) {
    assert.throws(() => validateApprovedModelConfig({ ...approved(), ...change }), { code: 'model_config_scope_denied' })
  }
})

test('a larger request envelope cannot be fitted under the approved five yuan cap', () => {
  const bound = estimateWorstCostCny({ maxRequests: 6, maxOutputTokens: 256, maxRequestBytes: 65536 })
  assert.ok(bound > 5)
  assert.throws(() => estimateWorstCostCny({ maxRequests: 6, maxOutputTokens: 256, maxRequestBytes: 65536, capCny: 5 }), { code: 'model_cost_bound_exceeded' })
})

test('an unknown numeric cap is refused rather than disabling the cost gate', () => {
  assert.throws(() => estimateWorstCostCny({ maxRequests: 6, maxOutputTokens: 256,
    maxRequestBytes: 32768, capCny: NaN }), { code: 'invalid_model_cost_limits' })
})
