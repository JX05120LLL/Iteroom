import { git } from './git.js'
import { failure, controlledEnv } from './ocr-process.js'
import { modeArgs, validatePath } from './ocr-contract.js'
import { assertManaged, readRegular, side, text, sha256, blobOid } from './review-files.js'
import { assertPlainGit, rejectAttributePath } from './review-git-boundary.js'

const hash = value => /^[0-9a-f]{40}$/.test(value)
const regularMode = mode => ['100644', '100755'].includes(mode)
const DIFF = ['--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/']
function fields(raw) {
  if (!raw) return []
  const result = raw.split('\0')
  if (result.pop() !== '') throw failure('invalid_git_output')
  return result
}
async function tree(fixture, ref) {
  const rows = fields(await git(fixture, ['ls-tree', '-r', '-z', ref])), map = new Map()
  for (const row of rows) {
    const match = /^([0-9]{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(row)
    if (!match) throw failure('invalid_git_output')
    const [, mode, type, oid, path] = match
    validatePath(path)
    rejectAttributePath(path)
    if (!regularMode(mode) || type !== 'blob') throw failure('unsupported_git_mode')
    if (map.has(path)) throw failure('invalid_git_output')
    map.set(path, { mode, oid })
  }
  return map
}
async function resolveInput(fixture, input) {
  modeArgs(input)
  if ((await git(fixture, ['rev-parse', '--show-object-format'])).trim() !== 'sha1') throw failure('unsupported_git_format')
  if (input.mode === 'workspace') {
    const head = (await git(fixture, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowedExitCodes: [0, 1] })).trim()
    if (!head) return { resolvedBase: (await git(fixture, ['hash-object', '-t', 'tree', '--stdin'])).trim(),
      resolvedTarget: null, baseKind: 'unborn_empty_tree' }
    return { resolvedBase: head, resolvedTarget: null, baseKind: 'head' }
  }
  const target = input.mode === 'commit' ? input.commit : input.to
  if ((await git(fixture, ['rev-parse', '--verify', `${target}^{commit}`])).trim() !== target) throw failure('invalid_revision')
  if (input.mode === 'commit') {
    const parents = (await git(fixture, ['rev-list', '--parents', '-n', '1', target])).trim().split(' ').slice(1)
    const base = parents[0] ?? (await git(fixture, ['hash-object', '-t', 'tree', '--stdin'])).trim()
    return { resolvedBase: base, resolvedTarget: target, baseKind: parents.length ? 'first_parent' : 'empty_tree' }
  }
  if ((await git(fixture, ['rev-parse', '--verify', `${input.from}^{commit}`])).trim() !== input.from) throw failure('invalid_revision')
  let bases
  try { bases = (await git(fixture, ['merge-base', '--all', input.from, target])).trim().split('\n') }
  catch (error) { if (error.code === 'process_failed' && error.exitCode === 1) throw failure('unrelated_history'); throw error }
  if (bases.length !== 1 || !hash(bases[0])) throw failure('ambiguous_merge_base')
  return { resolvedBase: bases[0], resolvedTarget: target, mergeBase: bases[0], baseKind: 'merge_base' }
}
export async function captureWorkspaceState(fixture, limits = { maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, maxFiles: 100 }) {
  const staged = fields(await git(fixture, ['ls-files', '--stage', '-z'])), paths = new Set()
  for (const row of staged) {
    const match = /^([0-9]{6}) [0-9a-f]{40} ([0-3])\t([\s\S]+)$/.exec(row)
    if (!match) throw failure('invalid_git_output')
    if (match[2] !== '0') throw failure('unmerged_input')
    if (!regularMode(match[1])) throw failure('unsupported_git_mode')
    validatePath(match[3]); rejectAttributePath(match[3]); paths.add(match[3])
  }
  const loose = fields(await git(fixture, ['ls-files', '--others', '--exclude-standard', '-z']))
  for (const path of loose) { validatePath(path); rejectAttributePath(path); paths.add(path) }
  // Git also uses ignored ancestor attribute files; check every ancestor of
  // selected paths without traversing links or running a Git content filter.
  const attributePaths = new Set(['.gitattributes'])
  for (const path of paths) {
    const parents = path.split('/'); parents.pop()
    while (parents.length) { attributePaths.add([...parents, '.gitattributes'].join('/')); parents.pop() }
  }
  for (const path of attributePaths) {
    if (await readRegular(fixture.repository, path, limits.maxFileBytes) !== null) throw failure('unsupported_git_attributes')
  }
  if (paths.size > limits.maxFiles) throw failure('input_limit')
  const files = new Map(); let total = 0
  for (const path of [...paths].sort()) {
    const bytes = await readRegular(fixture.repository, path, limits.maxFileBytes)
    total += bytes?.length ?? 0
    if (total > limits.maxTotalBytes) throw failure('input_limit')
    files.set(path, bytes)
  }
  const status = await git(fixture, ['status', '--porcelain=v1', '-z'])
  return { files, loose, staged, fingerprint: sha256(JSON.stringify([status, staged, [...files].map(([path, bytes]) => [path, bytes && sha256(bytes)])])) }
}
function rawEntries(raw) {
  const rows = fields(raw), entries = []
  for (let i = 0; i < rows.length;) {
    const match = /^:([0-9]{6}) ([0-9]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDRT])\d*$/.exec(rows[i++])
    if (!match) throw failure('unsupported_diff')
    const [, oldMode, newMode, oldOid, newOid, statusCode] = match, path = rows[i++]
    validatePath(path)
    const newPath = statusCode === 'R' ? rows[i++] : path
    validatePath(newPath)
    if ((oldMode !== '000000' && !regularMode(oldMode)) || (newMode !== '000000' && !regularMode(newMode))) throw failure('unsupported_git_mode')
    if (statusCode === 'T') throw failure('unsupported_diff')
    entries.push({ status: ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed' })[statusCode],
      oldPath: statusCode === 'A' ? null : path, newPath: statusCode === 'D' ? null : newPath,
      oldMode, newMode, oldOid, newOid })
  }
  return entries
}

// R0 capture only: immutable returned strings, not a product workspace/atomic snapshot API.
export async function captureReviewInput(fixture, input, overrides = {}) {
  const limits = { maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, maxFiles: 100, ...overrides }
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)
    || limits.maxFileBytes > 1024 * 1024 || limits.maxTotalBytes > 16 * 1024 * 1024 || limits.maxFiles > 1000) throw failure('invalid_options')
  await assertManaged(fixture)
  fixture = { ...fixture, options: { cwd: fixture.repository, env: controlledEnv(fixture.home),
    timeoutMs: 10000, maxOutputBytes: 1024 * 1024 } }
  await assertPlainGit(fixture)
  const resolved = await resolveInput(fixture, input), baseTree = await tree(fixture, resolved.resolvedBase)
  const targetTree = resolved.resolvedTarget && await tree(fixture, resolved.resolvedTarget)
  const before = input.mode === 'workspace' && await captureWorkspaceState(fixture, limits)
  if (before && resolved.baseKind === 'unborn_empty_tree') {
    for (const row of before.staged) {
      const [, oid, path] = /^[0-9]{6} ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(row)
      const bytes = before.files.get(path)
      if (!bytes || blobOid(bytes) !== oid) throw failure('unborn_unstaged_input')
    }
  }
  const refs = [resolved.resolvedBase, ...(resolved.resolvedTarget ? [resolved.resolvedTarget] : [])]
  const raw = await git(fixture, ['diff', ...DIFF, '--raw', '--no-abbrev', '-z', ...refs, '--'])
  const changes = rawEntries(raw)
  if (before) for (const path of before.loose) changes.push({ status: 'added', oldPath: null, newPath: path, newMode: '100644', untracked: true })
  if (changes.length > limits.maxFiles) throw failure('input_limit')
  let total = 0, diffBytes = 0; const entries = [], seen = new Set()
  const blob = async (path, info) => {
    if (!info || !hash(info.oid)) throw failure('unlocatable_path')
    const bytes = await git(fixture, ['cat-file', 'blob', info.oid], { encoding: 'buffer', maxOutputBytes: limits.maxFileBytes })
    return side(path, info.mode, bytes, info.oid)
  }
  for (const change of changes) {
    const path = change.newPath ?? change.oldPath
    if (seen.has(path)) throw failure('invalid_git_output'); seen.add(path)
    const old = change.oldPath ? await blob(change.oldPath, baseTree.get(change.oldPath)) : null
    let next = null
    if (change.newPath) {
      if (targetTree) next = await blob(change.newPath, targetTree.get(change.newPath))
      else {
        const bytes = before.files.get(change.newPath)
        if (!bytes) throw failure('unlocatable_path')
        next = side(change.newPath, change.newMode, bytes)
      }
    }
    total += (old?.bytes ?? 0) + (next?.bytes ?? 0)
    if (total > limits.maxTotalBytes) throw failure('input_limit')
    const paths = [...new Set([change.oldPath, change.newPath].filter(Boolean))]
    const bytes = await git(fixture, change.untracked
      ? ['diff', ...DIFF, '--no-index', '--binary', '--full-index', '--', '/dev/null', path]
      : ['diff', ...DIFF, '--binary', '--full-index', ...refs, '--', ...paths],
    { encoding: 'buffer', ...(change.untracked ? { allowedExitCodes: [0, 1] } : {}) })
    diffBytes += bytes.length
    if (diffBytes > limits.maxTotalBytes) throw failure('input_limit')
    const diff = text(bytes)
    if (!diff.trim()) throw failure('unlocatable_path')
    entries.push(Object.freeze({ status: change.status, kind: old?.binary || next?.binary ? 'binary' : 'text',
      old, new: next, diff, diffSha256: sha256(bytes) }))
  }
  if (before) {
    const after = await captureWorkspaceState(fixture, limits)
    if (after.fingerprint !== before.fingerprint
      || (await git(fixture, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowedExitCodes: [0, 1] })).trim()
        !== (resolved.baseKind === 'unborn_empty_tree' ? '' : resolved.resolvedBase)) throw failure('input_changed')
  }
  const record = { schemaVersion: 1, mode: input.mode, selection: Object.freeze({ ...input }), ...resolved,
    outcome: entries.length ? 'changes' : 'no_changes', entries: Object.freeze(entries) }
  return Object.freeze({ ...record, inputSha256: sha256(JSON.stringify(record)) })
}

export function summarizeInput(record) {
  return { schemaVersion: record.schemaVersion, mode: record.mode, outcome: record.outcome, baseKind: record.baseKind,
    inputSha256: record.inputSha256, basePresent: !!record.resolvedBase, targetPresent: !!record.resolvedTarget,
    mergeBasePresent: !!record.mergeBase, entries: record.entries.map(entry => ({ status: entry.status, kind: entry.kind,
      old: entry.old && { path: entry.old.path, mode: entry.old.mode, bytes: entry.old.bytes, contentSha256: entry.old.contentSha256 },
      new: entry.new && { path: entry.new.path, mode: entry.new.mode, bytes: entry.new.bytes, contentSha256: entry.new.contentSha256 },
      diffSha256: entry.diffSha256, diffBytes: Buffer.byteLength(entry.diff) })) }
}
