import { resolve, isAbsolute } from 'node:path'
import { failure } from './ocr-process.mjs'

const STATUSES = new Set(['added', 'modified', 'deleted', 'renamed', 'binary'])
const REASONS = new Set(['user_exclude', 'unsupported_ext', 'default_path', 'secret_exclude',
  'provider_directory', 'deleted', 'binary', 'too_large'])
const integer = x => Number.isSafeInteger(x) && x >= 0
const object = x => x && typeof x === 'object' && !Array.isArray(x)
export function validatePath(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || /^[-/]/.test(path)
    || /[\\:"<>|?*\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'
      || part.toLowerCase() === '.git' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw failure('invalid_path')
  return path
}
export function modeArgs(input) {
  const { mode, commit, from, to } = input
  const hash = x => typeof x === 'string' && /^[0-9a-f]{40}$/.test(x)
  if (mode === 'workspace' && !commit && !from && !to) return []
  if (mode === 'commit' && hash(commit) && !from && !to) return ['--commit', commit]
  if (mode === 'range' && hash(from) && hash(to) && !commit) return ['--from', from, '--to', to]
  throw failure('invalid_mode')
}
function document(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw failure('output_limit')
  let value
  try { value = JSON.parse(text) } catch { throw failure('invalid_json') }
  if (!object(value) || value.schema_version !== '1') throw failure('invalid_schema')
  return value
}
export function parsePreview(text, context) {
  const p = document(text)
  modeArgs(context)
  if (typeof p.repository !== 'string' || !isAbsolute(p.repository) || resolve(p.repository) !== resolve(context.repository)
    || p.mode !== context.mode || ['from', 'to', 'commit'].some(key => (p[key] ?? '') !== (context[key] ?? ''))
    || (context.mode === 'range' ? p.merge_base !== context.mergeBase : !!p.merge_base)) throw failure('context_mismatch')
  const keys = ['total_files', 'reviewable_count', 'excluded_count', 'total_insertions', 'total_deletions']
  if (!keys.every(key => integer(p[key])) || !Array.isArray(p.reviewable_files) || !Array.isArray(p.excluded_files)) throw failure('invalid_schema')
  const seen = new Set()
  let insertions = 0, deletions = 0
  for (const [entries, excluded] of [[p.reviewable_files, false], [p.excluded_files, true]]) {
    for (const entry of entries) {
      if (!object(entry)) throw failure('invalid_schema')
      validatePath(entry.path)
      if (seen.has(entry.path) || !context.files.has(entry.path) || context.files.get(entry.path) !== entry.status) throw failure('coverage_mismatch')
      if (!STATUSES.has(entry.status) || !integer(entry.insertions) || !integer(entry.deletions)
        || (excluded ? !REASONS.has(entry.exclude_reason) : entry.exclude_reason !== undefined)) throw failure('invalid_schema')
      seen.add(entry.path); insertions += entry.insertions; deletions += entry.deletions
    }
  }
  if (seen.size !== context.files.size || p.total_files !== seen.size
    || p.reviewable_count !== p.reviewable_files.length || p.excluded_count !== p.excluded_files.length
    || p.total_insertions !== insertions || p.total_deletions !== deletions) throw failure('coverage_mismatch')
  return p
}
export function parseRules(text, expectedPaths) {
  const p = document(text), expected = new Set(expectedPaths), seen = new Set(), ids = new Set()
  for (const path of expected) validatePath(path)
  if (!expected.size || expected.size !== expectedPaths.length || !Array.isArray(p.groups)) throw failure('invalid_schema')
  for (const group of p.groups) {
    if (!object(group) || !Number.isSafeInteger(group.group_id) || group.group_id < 1 || ids.has(group.group_id)
      || !['custom', 'project', 'global', 'system'].includes(group.source)
      || typeof group.pattern !== 'string' || !group.pattern.trim()
      || typeof group.rule !== 'string' || !group.rule.trim() || !Array.isArray(group.files) || !group.files.length) throw failure('invalid_schema')
    ids.add(group.group_id)
    for (const path of group.files) {
      validatePath(path)
      if (!expected.has(path) || seen.has(path)) throw failure('coverage_mismatch')
      seen.add(path)
    }
  }
  if (seen.size !== expected.size) throw failure('coverage_mismatch')
  return p
}
