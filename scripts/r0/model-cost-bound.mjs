import { failure } from './ocr-process.mjs'

// Official 2026-09-28 peak USD/M-token rates for deepseek-flash. The 20 CNY/USD
// and 2 tokens/UTF-8 byte + 8192 input-token overhead are deliberately high
// local planning factors, not a provider-side spending guarantee.
const PEAK_INPUT_USD_PER_MILLION = 0.30
const PEAK_OUTPUT_USD_PER_MILLION = 1.20
const PLANNING_CNY_PER_USD = 20
const INPUT_TOKENS_PER_REQUEST_BYTE = 2
const INPUT_OVERHEAD_TOKENS = 8192

export function estimateWorstCostCny({ maxRequests, maxOutputTokens, maxRequestBytes, capCny = Infinity }) {
  if (![maxRequests, maxOutputTokens, maxRequestBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || typeof capCny !== 'number' || Number.isNaN(capCny) || capCny <= 0) throw failure('invalid_model_cost_limits')
  const inputTokens = maxRequests * (maxRequestBytes * INPUT_TOKENS_PER_REQUEST_BYTE + INPUT_OVERHEAD_TOKENS)
  const outputTokens = maxRequests * maxOutputTokens
  const cny = (inputTokens * PEAK_INPUT_USD_PER_MILLION + outputTokens * PEAK_OUTPUT_USD_PER_MILLION)
    / 1_000_000 * PLANNING_CNY_PER_USD
  if (!Number.isFinite(cny) || cny > capCny) throw failure('model_cost_bound_exceeded')
  return cny
}

export function validateApprovedModelConfig(value) {
  const keys = ['provider', 'baseURL', 'model', 'apiKey', 'maxRequests', 'maxOutputTokens', 'maxCostCny']
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || value.provider !== 'deepseek-official' || value.baseURL !== 'https://api.deepseek.com'
    || value.model !== 'deepseek-flash' || typeof value.apiKey !== 'string'
    || !/^sk-[A-Za-z0-9_-]{6,}$/.test(value.apiKey) || value.maxRequests !== 6
    || value.maxOutputTokens !== 256 || value.maxCostCny !== 5) throw failure('model_config_scope_denied')
  estimateWorstCostCny({ maxRequests: 6, maxOutputTokens: 256, maxRequestBytes: 32768, capCny: value.maxCostCny })
  return value
}
