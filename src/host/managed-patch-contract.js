import { createHash } from 'node:crypto'
import { TaskEntryError, validateManagedTaskInput } from './managed-task-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX = /^[0-9a-f]{64}$/
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw new TaskEntryError(code, code === 'PATCH_SCOPE_INVALID' ? 400 : 409) }

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
  const names = Reflect.ownKeys(value)
  return names.every(name => typeof name === 'string') && names.sort().join(',') === expected
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
}

function denseArray(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1 || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let i = 0; i < value.length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, String(i))
    if (!item?.enumerable || !('value' in item)) return false
  }
  return true
}

function validState(state) {
  return keys(state, 'kind') && state.kind === 'absent'
    || keys(state, 'byteLength,kind,mode,sha256') && state.kind === 'file' && state.mode === '100644'
      && typeof state.sha256 === 'string' && HEX.test(state.sha256)
      && Number.isSafeInteger(state.byteLength) && state.byteLength >= 0 && state.byteLength <= 262144
}

const equal = (left, right) => left.kind === right.kind && (left.kind === 'absent'
  || left.sha256 === right.sha256 && left.byteLength === right.byteLength && left.mode === right.mode)
const absent = () => ({ kind: 'absent' })
const state = side => side ? { kind: 'file', mode: side.mode, sha256: side.sha256, byteLength: side.byteLength } : absent()

/** Pure metadata definition. The future Host must independently capture paths and approve writable scope. */
export function definePatchScope(taskId, entries) {
  if (typeof taskId !== 'string' || !UUID.test(taskId) || !denseArray(entries, 16)
    || entries.some(item => !keys(item, 'before,path,writable') || typeof item.path !== 'string' || typeof item.writable !== 'boolean'
      || !validState(item.before) || TEST_PATH.test(item.path) && item.writable)) fail('PATCH_SCOPE_INVALID')
  try {
    validateManagedTaskInput({ requestId: 'patch-scope', kind: 'modify', objective: 'Define patch scope', paths: entries.map(item => item.path) })
  } catch { fail('PATCH_SCOPE_INVALID') }
  const paths = entries.map(item => item.path.toLowerCase())
  if (paths.some((path, i) => paths.some((other, j) => i !== j && path.startsWith(other + '/')))) fail('PATCH_SCOPE_INVALID')
  const normalized = entries.map(item => ({ path: item.path, writable: item.writable, before: item.before.kind === 'absent'
    ? absent() : { kind: 'file', mode: item.before.mode, sha256: item.before.sha256, byteLength: item.before.byteLength } }))
  const result = { version: 2, taskId, entries: normalized.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }
  return { ...result, id: hash(JSON.stringify(result)) }
}

function checkedScope(scope) {
  if (!keys(scope, 'entries,id,taskId,version') || scope.version !== 2) fail('PATCH_SCOPE_INVALID')
  const canonical = definePatchScope(scope.taskId, scope.entries)
  if (scope.id !== canonical.id) fail('PATCH_SCOPE_INVALID')
  return canonical
}

function contentSide(value) {
  if (value === null) return null
  if (!keys(value, 'path,text') || typeof value.path !== 'string' || !value.path || typeof value.text !== 'string'
    || !value.text.isWellFormed() || value.text.includes('\0') || Buffer.byteLength(value.text) > 262144) fail('PATCH_CANDIDATE_INVALID')
  return { path: value.path, text: value.text, mode: '100644', sha256: hash(value.text), byteLength: Buffer.byteLength(value.text) }
}

function patchLines(text) {
  if (!text) return { lines: [], trailing: false }
  const lines = text.split('\n'), trailing = lines.at(-1) === ''
  if (trailing) lines.pop()
  return { lines, trailing }
}

function renderChange(change) {
  const { kind, old, new: next } = change
  const lines = [`diff --git a/${old?.path ?? next.path} b/${next?.path ?? old.path}`]
  if (kind === 'added') lines.push('new file mode 100644')
  if (kind === 'deleted') lines.push('deleted file mode 100644')
  if (kind === 'renamed') {
    if (old.sha256 === next.sha256) lines.push('similarity index 100%')
    lines.push(`rename from ${old.path}`, `rename to ${next.path}`)
  }
  if ((old?.text ?? '') !== (next?.text ?? '')) {
    const before = patchLines(old?.text ?? ''), after = patchLines(next?.text ?? '')
    const count = side => side.lines.length ? `1,${side.lines.length}` : '0,0'
    lines.push(old ? `--- a/${old.path}` : '--- /dev/null', next ? `+++ b/${next.path}` : '+++ /dev/null',
      `@@ -${count(before)} +${count(after)} @@`)
    for (const [prefix, side] of [['-', before], ['+', after]]) for (const [i, text] of side.lines.entries()) {
      lines.push(prefix + text)
      if (!side.trailing && i === side.lines.length - 1) lines.push('\\ No newline at end of file')
    }
  }
  return lines.join('\n') + '\n'
}

/** Creates a canonical export; it never reads a live path, applies a patch or grants permissions. */
export function createPatchCandidate(scope, changes) {
  scope = checkedScope(scope)
  if (!denseArray(changes, scope.entries.length)) fail('PATCH_CANDIDATE_INVALID')
  const selected = new Map(scope.entries.map(item => [item.path, item])), used = new Set()
  let contentBytes = 0
  const normalized = changes.map(change => {
    if (!keys(change, 'kind,new,old') || !['added', 'modified', 'deleted', 'renamed'].includes(change.kind)) fail('PATCH_CANDIDATE_INVALID')
    const old = contentSide(change.old), next = contentSide(change.new)
    if (change.kind === 'added' ? old !== null || next === null
      : change.kind === 'deleted' ? old === null || next !== null
        : old === null || next === null) fail('PATCH_CANDIDATE_INVALID')
    if (change.kind === 'modified' && (old.path !== next.path || old.sha256 === next.sha256)
      || change.kind === 'renamed' && old.path.toLowerCase() === next.path.toLowerCase()) fail('PATCH_CANDIDATE_INVALID')
    for (const path of new Set([old?.path, next?.path].filter(Boolean))) {
      if (!selected.get(path)?.writable || used.has(path.toLowerCase())) fail('PATCH_CANDIDATE_INVALID')
      used.add(path.toLowerCase())
    }
    if (old && !equal(selected.get(old.path).before, state(old))) fail('PATCH_CANDIDATE_INVALID')
    if (next && change.kind !== 'modified' && selected.get(next.path).before.kind !== 'absent') fail('PATCH_CANDIDATE_INVALID')
    contentBytes += (old?.byteLength ?? 0) + (next?.byteLength ?? 0)
    return { kind: change.kind, old, new: next }
  })
  if (contentBytes > 1048576) fail('PATCH_CANDIDATE_INVALID')
  const patch = normalized.map(renderChange).join('')
  const artifact = { version: 2, taskId: scope.taskId, snapshotId: scope.id, changes: normalized, patch, sha256: hash(patch) }
  if (Buffer.byteLength(patch) > 1048576 || Buffer.byteLength(JSON.stringify(artifact)) > 2097152) fail('PATCH_CANDIDATE_INVALID')
  return artifact
}

/** Rebuild every byte and field; an attacker recomputing a patch hash still cannot substitute a diff. */
export function validatePatchCandidate(scope, candidate) {
  scope = checkedScope(scope)
  if (!keys(candidate, 'changes,patch,sha256,snapshotId,taskId,version') || candidate.version !== 2
    || candidate.taskId !== scope.taskId || candidate.snapshotId !== scope.id
    || !denseArray(candidate.changes, scope.entries.length)) fail('PATCH_CANDIDATE_INVALID')
  const changes = candidate.changes.map(change => {
    if (!keys(change, 'kind,new,old')) fail('PATCH_CANDIDATE_INVALID')
    const raw = side => {
      if (side === null) return null
      if (!keys(side, 'byteLength,mode,path,sha256,text')) fail('PATCH_CANDIDATE_INVALID')
      const rebuilt = contentSide({ path: side.path, text: side.text })
      if (side.mode !== rebuilt.mode || side.sha256 !== rebuilt.sha256 || side.byteLength !== rebuilt.byteLength) fail('PATCH_CANDIDATE_INVALID')
      return { path: rebuilt.path, text: rebuilt.text }
    }
    return { kind: change.kind, old: raw(change.old), new: raw(change.new) }
  })
  const rebuilt = createPatchCandidate(scope, changes)
  if (candidate.patch !== rebuilt.patch || candidate.sha256 !== rebuilt.sha256) fail('PATCH_CANDIDATE_INVALID')
  return rebuilt
}

function observationsFor(scope, observations) {
  if (!denseArray(observations, scope.entries.length) || observations.length !== scope.entries.length) fail('PATCH_OBSERVATION_INVALID')
  const selected = new Set(scope.entries.map(item => item.path)), result = new Map()
  for (const item of observations) {
    if (!keys(item, 'path,state') || !selected.has(item.path) || result.has(item.path) || !validState(item.state)) fail('PATCH_OBSERVATION_INVALID')
    result.set(item.path, item.state)
  }
  return result
}

function step(path, before, after) {
  return { action: !before ? 'create' : !after ? 'remove' : 'replace', path,
    expected: state(before), replacement: state(after), beforeText: before?.text ?? null, afterText: after?.text ?? null }
}

function program(artifact) {
  return artifact.changes.flatMap(change => change.kind === 'renamed'
    ? [step(change.new.path, null, change.new), step(change.old.path, change.old, null)]
    : [step(change.old?.path ?? change.new.path, change.old, change.new)])
}

function inverse(item) {
  return { action: item.action === 'create' ? 'remove' : item.action === 'remove' ? 'create' : 'replace',
    path: item.path, expected: item.replacement, replacement: item.expected, beforeText: item.afterText, afterText: item.beforeText }
}

const initialState = scope => new Map(scope.entries.map(item => [item.path, item.before]))
const matches = (current, expected) => [...expected].every(([path, value]) => equal(current.get(path), value))
const advance = (states, steps, count) => { for (const item of steps.slice(0, count)) states.set(item.path, item.replacement); return states }
const identity = artifact => ({ version: 2, taskId: artifact.taskId, snapshotId: artifact.snapshotId, artifactId: hash(JSON.stringify(artifact)) })

/** Advisory plan only. The caller must later implement safe I/O, durable receipts and stopped-writer checks. */
export function planPatchApplication(scope, candidate, observations) {
  scope = checkedScope(scope)
  const artifact = validatePatchCandidate(scope, candidate), current = observationsFor(scope, observations)
  if (!matches(current, initialState(scope))) fail('PATCH_CONFLICT')
  const steps = program(artifact)
  return { steps, journal: { ...identity(artifact), direction: 'forward', forwardSteps: steps.length, completedSteps: 0, inFlightStep: null } }
}

export function planPatchRecovery(scope, candidate, observations, journal, mode) {
  scope = checkedScope(scope)
  const artifact = validatePatchCandidate(scope, candidate), current = observationsFor(scope, observations), binding = identity(artifact)
  const forward = program(artifact)
  if (!keys(journal, 'artifactId,completedSteps,direction,forwardSteps,inFlightStep,snapshotId,taskId,version')
    || Object.entries(binding).some(([key, value]) => journal[key] !== value)
    || !['forward', 'rollback'].includes(journal.direction) || !['finish', 'rollback'].includes(mode)
    || journal.direction === 'rollback' && mode !== 'rollback'
    || !Number.isSafeInteger(journal.forwardSteps) || journal.forwardSteps < 0 || journal.forwardSteps > forward.length
    || journal.direction === 'forward' && journal.forwardSteps !== forward.length) fail('PATCH_RECOVERY_INVALID')
  const steps = journal.direction === 'forward' ? forward : forward.slice(0, journal.forwardSteps).reverse().map(inverse)
  if (!Number.isSafeInteger(journal.completedSteps) || journal.completedSteps < 0 || journal.completedSteps > steps.length
    || journal.inFlightStep !== null && (journal.inFlightStep !== journal.completedSteps || journal.completedSteps >= steps.length)) fail('PATCH_RECOVERY_INVALID')
  const expected = initialState(scope)
  if (journal.direction === 'rollback') advance(expected, forward, journal.forwardSteps)
  advance(expected, steps, journal.completedSteps)
  let completed = journal.completedSteps
  if (!matches(current, expected)) {
    if (journal.inFlightStep === null) fail('PATCH_CONFLICT')
    const writing = steps[completed]
    expected.set(writing.path, writing.replacement)
    if (!matches(current, expected)) fail('PATCH_CONFLICT')
    completed++
  }
  if (mode === 'rollback' && journal.direction === 'forward') {
    return { steps: forward.slice(0, completed).reverse().map(inverse), journal: { ...binding,
      direction: 'rollback', forwardSteps: completed, completedSteps: 0, inFlightStep: null } }
  }
  return { steps: steps.slice(completed), journal: { ...journal, completedSteps: completed, inFlightStep: null } }
}
