import { sha256 } from './review-files.js'
import { TaskEntryError } from '../managed-task-store.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected
const invalid = () => { throw new TaskEntryError('REVIEW_OUTPUT_INVALID', 409) }

function locate(text, quote) {
  const first = text.indexOf(quote)
  if (first < 0) return { location: 'not_found', startLine: null, endLine: null }
  if (text.indexOf(quote, first + 1) >= 0) return { location: 'ambiguous', startLine: null, endLine: null }
  const startLine = text.slice(0, first).split('\n').length
  const endLine = text.slice(0, first + quote.length - (quote.endsWith('\n') ? 1 : 0)).split('\n').length
  return { location: 'located', startLine, endLine }
}

export function reviewOutcome(coverage) {
  const selected = coverage.filter(item => item.status !== 'excluded')
  if (selected.every(item => item.status === 'completed')) return 'completed'
  return selected.some(item => item.status === 'completed') ? 'partial' : 'failed'
}

/** Model findings are candidates. Only Host matching against the fixed side may produce line numbers. */
export function parseReviewFindings(preparation, plan, text, readGroupIds) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536
    || plan.preparationId !== preparation.id || !Array.isArray(readGroupIds)) invalid()
  let value
  try { value = JSON.parse(text) } catch { invalid() }
  if (!keys(value, 'groups') || !Array.isArray(value.groups) || value.groups.length > plan.groups.length) invalid()
  const expected = new Map(plan.groups.map(group => [group.id, group])), reports = new Map()
  for (const group of value.groups) {
    if (!keys(group, 'findings,groupId') || !Number.isSafeInteger(group.groupId) || !expected.has(group.groupId)
      || reports.has(group.groupId) || !Array.isArray(group.findings) || group.findings.length > 8) invalid()
    reports.set(group.groupId, group)
    for (const finding of group.findings) {
      if (!keys(finding, 'message,path,quote,severity,side') || !expected.get(group.groupId).paths.includes(finding.path)
        || !['old', 'new'].includes(finding.side) || typeof finding.quote !== 'string' || !finding.quote.trim()
        || finding.quote.length > 256 || typeof finding.message !== 'string' || !finding.message.trim()
        || finding.message.length > 500 || !['low', 'medium', 'high', 'critical'].includes(finding.severity)) invalid()
    }
  }
  const entries = new Map(preparation.input.entries.map(entry => [entry.new?.path ?? entry.old.path, entry]))
  const read = new Set(readGroupIds), findings = [], seen = new Set(), groups = []
  for (const group of plan.groups) {
    const reason = !read.has(group.id) ? 'context_not_read' : !reports.has(group.id) ? 'group_not_reported' : null
    groups.push({ id: group.id, status: reason ? 'failed' : 'completed', reason })
    if (reason) continue
    for (const finding of reports.get(group.id).findings) {
      const side = entries.get(finding.path)?.[finding.side]
      if (!side || typeof side.content !== 'string') invalid()
      const id = sha256(JSON.stringify([preparation.id, finding.path, finding.side, finding.quote, finding.message, finding.severity]))
      if (seen.has(id)) continue
      seen.add(id)
      findings.push({ ...finding, id, groupId: group.id, preparationId: preparation.id, sourcePath: side.path,
        sourceSha256: side.contentSha256, evidenceStatus: 'model_candidate', ...locate(side.content, finding.quote) })
    }
  }
  const byId = new Map(groups.map(group => [group.id, group]))
  const coverage = plan.coverage.map(item => item.groupId === null ? item : {
    ...item, status: byId.get(item.groupId).status, reason: byId.get(item.groupId).reason })
  return { version: 1, taskId: preparation.taskId, preparationId: preparation.id, planId: plan.id,
    outcome: reviewOutcome(coverage), coverage, groups, findings, noTestsExecuted: true }
}

export function failedReviewReport(preparation, plan, code, outcome = 'failed') {
  return { version: 1, taskId: preparation.taskId, preparationId: preparation.id, planId: plan.id,
    outcome, coverage: plan.coverage.map(item => item.groupId === null ? item : { ...item, status: 'failed', reason: code }),
    groups: plan.groups.map(group => ({ id: group.id, status: 'failed', reason: code })), findings: [], noTestsExecuted: true }
}
