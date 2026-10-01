import { TaskEntryError } from './managed-task-store.js'
import { readReviewPreparation, readReviewDocument, writeReviewDocument } from './managed-review-snapshot.js'
import { buildReviewPlan } from './review/inference-plan.js'
import { parseReviewFindings, reviewOutcome } from './review/findings.js'
import { isDeepStrictEqual } from 'node:util'

export async function saveReviewPlan(store, taskId, plan) {
  const { id, ...value } = plan
  const saved = await writeReviewDocument(store, taskId, 'plan.json', value)
  if (saved.id !== id) throw new TaskEntryError('REVIEW_PLAN_INVALID', 409)
  return saved
}

export async function readReviewPlan(store, taskId) {
  const task = await store.get(taskId)
  if (!task.reviewPlanId) throw new TaskEntryError('REVIEW_PLAN_NOT_READY', 409)
  const preparation = await readReviewPreparation(store, taskId)
  const { value, id } = await readReviewDocument(store, taskId, 'plan.json')
  if (id !== task.reviewPlanId || id !== buildReviewPlan(preparation).id) {
    throw new TaskEntryError('REVIEW_PLAN_INVALID', 409)
  }
  return { ...value, id }
}

export async function saveReviewResult(store, taskId, report) {
  if (report.taskId !== taskId) throw new TaskEntryError('REVIEW_RESULT_INVALID', 409)
  return writeReviewDocument(store, taskId, 'result.json', report)
}

/** recoverReceipt only attaches a complete Host receipt after a process restart; it never invokes the engine. */
export async function readReviewResult(store, taskId, recoverReceipt = false) {
  const task = await store.get(taskId)
  if (!task.reviewReportId && !recoverReceipt) throw new TaskEntryError('REVIEW_RESULT_NOT_READY', 409)
  const { value, id } = await readReviewDocument(store, taskId, 'result.json')
  const plan = await readReviewPlan(store, taskId)
  if (!value || Object.keys(value).sort().join(',') !== 'coverage,findings,groups,noTestsExecuted,outcome,planId,preparationId,taskId,version') {
    throw new TaskEntryError('REVIEW_RESULT_INVALID', 409)
  }
  if (task.reviewReportId && (id !== task.reviewReportId || value.outcome !== task.reviewOutcome)
    || value.version !== 1 || value.taskId !== taskId || value.preparationId !== task.reviewSnapshotId
    || value.planId !== plan.id || !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(value.outcome)
    || value.noTestsExecuted !== true || !Array.isArray(value.coverage) || value.coverage.length !== plan.coverage.length
    || !Array.isArray(value.groups) || value.groups.length !== plan.groups.length
    || !Array.isArray(value.findings) || value.findings.length > 16) throw new TaskEntryError('REVIEW_RESULT_INVALID', 409)
  const invalid = () => { throw new TaskEntryError('REVIEW_RESULT_INVALID', 409) }
  for (const [index, group] of value.groups.entries()) {
    if (!group || Object.keys(group).sort().join(',') !== 'id,reason,status'
      || group.id !== plan.groups[index].id || !['completed', 'failed'].includes(group.status)
      || (group.status === 'completed' ? group.reason !== null
        : typeof group.reason !== 'string' || !/^(?:context_not_read|group_not_reported|[A-Z][A-Z0-9_]{1,79})$/.test(group.reason))) invalid()
  }
  const expectedCoverage = plan.coverage.map(item => item.groupId === null ? item : {
    ...item, status: value.groups.find(group => group.id === item.groupId).status,
    reason: value.groups.find(group => group.id === item.groupId).reason })
  if (!isDeepStrictEqual(expectedCoverage, value.coverage)
    || ['completed', 'partial', 'failed'].includes(value.outcome) && reviewOutcome(value.coverage) !== value.outcome
    || ['cancelled', 'interrupted'].includes(value.outcome) && (value.findings.length || value.groups.some(group => group.status !== 'failed'))) invalid()
  const preparation = await readReviewPreparation(store, taskId)
  const completed = value.groups.filter(group => group.status === 'completed').map(group => group.id)
  try {
    const raw = { groups: completed.map(groupId => ({ groupId, findings: value.findings.filter(item => item.groupId === groupId)
      .map(({ path, side, quote, message, severity }) => ({ path, side, quote, message, severity })) })) }
    const rebuilt = parseReviewFindings(preparation, plan, JSON.stringify(raw), completed)
    if (!isDeepStrictEqual(rebuilt.findings, value.findings)) invalid()
  } catch { invalid() }
  return { ...value, id }
}
