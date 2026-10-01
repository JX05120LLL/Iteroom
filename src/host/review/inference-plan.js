import { sha256 } from './review-files.js'
import { TaskEntryError } from '../managed-task-store.js'

export const REVIEW_BUDGETS = Object.freeze({ maxGroups: 2, maxGroupBytes: 8192, maxContextBytes: 16384,
  maxRequests: 4, maxOutputTokens: 512 })
const wireBytes = context => Buffer.byteLength(JSON.stringify(JSON.stringify(context)))

/** Deterministic whole-file packing. Unscheduled files remain visible; nothing is silently clipped. */
export function buildReviewPlan(preparation) {
  const entries = new Map(preparation.input.entries.map(entry => [entry.new?.path ?? entry.old.path, entry]))
  const coverage = preparation.coverage.map(item => ({ path: item.path,
    status: item.status === 'excluded' ? 'excluded' : 'pending',
    reason: item.status === 'excluded' ? item.ocrExcludeReason : 'context_budget', groupId: null }))
  const byPath = new Map(coverage.map(item => [item.path, item])), groups = []
  let total = 0
  for (const rule of preparation.groups) {
    let context = null
    const start = () => ({ preparationId: preparation.id, groupId: groups.length + 1, ocrGroupId: rule.groupId,
      rule: { source: rule.source, pattern: rule.pattern, sha256: rule.sha256, text: rule.rule }, files: [] })
    const flush = () => {
      if (!context?.files.length) return
      const bytes = wireBytes(context), text = JSON.stringify(context)
      const paths = context.files.map(file => file.path)
      groups.push({ id: context.groupId, ocrGroupId: rule.groupId, paths, context: text,
        contextSha256: sha256(text), wireBytes: bytes })
      total += bytes
      for (const path of paths) Object.assign(byPath.get(path), { reason: null, groupId: context.groupId })
      context = null
    }
    for (const path of rule.files) {
      const entry = entries.get(path), item = byPath.get(path)
      if (!entry || !item || item.status === 'excluded') continue
      if (entry.diff === null || [entry.old, entry.new].filter(Boolean).some(side => typeof side.content !== 'string')) {
        throw new TaskEntryError('REVIEW_CONTEXT_INVALID', 409)
      }
      const file = { path, status: entry.status,
        old: entry.old && { path: entry.old.path, sha256: entry.old.contentSha256, text: entry.old.content },
        new: entry.new && { path: entry.new.path, sha256: entry.new.contentSha256, text: entry.new.content }, diff: entry.diff }
      if (groups.length >= REVIEW_BUDGETS.maxGroups) { item.reason = 'group_budget'; continue }
      context ??= start()
      let next = { ...context, files: [...context.files, file] }
      if (wireBytes(next) > REVIEW_BUDGETS.maxGroupBytes && context.files.length) {
        flush()
        if (groups.length >= REVIEW_BUDGETS.maxGroups) { item.reason = 'group_budget'; continue }
        context = start(); next = { ...context, files: [file] }
      }
      const bytes = wireBytes(next)
      if (bytes > REVIEW_BUDGETS.maxGroupBytes || total + bytes > REVIEW_BUDGETS.maxContextBytes) continue
      context = next
    }
    flush()
  }
  const value = { version: 1, taskId: preparation.taskId, preparationId: preparation.id,
    budgets: REVIEW_BUDGETS, groups, coverage }
  return { ...value, id: sha256(JSON.stringify(value)) }
}
