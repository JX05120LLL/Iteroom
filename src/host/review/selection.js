import { modeArgs } from './ocr-contract.js'
import { failure } from './ocr-process.js'

export function reviewSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('invalid_mode')
  const keys = { workspace: 'mode', commit: 'commit,mode', range: 'from,mode,to' }
  if (Object.keys(value).sort().join(',') !== keys[value.mode]) throw failure('invalid_mode')
  modeArgs(value)
  return value.mode === 'workspace' ? { mode: value.mode }
    : value.mode === 'commit' ? { mode: value.mode, commit: value.commit }
      : { mode: value.mode, from: value.from, to: value.to }
}
