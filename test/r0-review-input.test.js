import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture, git } from '../scripts/r0/ocr-fixture.mjs'
import { runBounded } from '../scripts/r0/ocr-process.mjs'
const sha = x => createHash('sha256').update(x).digest('hex')
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'iteroom-r0-input-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  return { ...await createFixture(scratch), scratch }
}
async function capture(f, input, limits) {
  const { captureReviewInput } = await import('../scripts/r0/review-input.mjs')
  return captureReviewInput(f, input, limits)
}
async function commit(f) {
  await git(f, ['add', '--all']); await git(f, ['commit', '--quiet', '-m', 'synthetic input changes'])
  return (await git(f, ['rev-parse', 'HEAD'])).trim()
}
test('byte output and accepted diff exit preserve binary data without changing defaults', async t => {
  const f = await fixture(t), args = ['-e', 'process.stdout.write(Buffer.from([0,255,128]));process.exit(1)']
  const result = await runBounded(process.execPath, args, { ...f.options, encoding: 'buffer', allowedExitCodes: [0, 1] })
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 128])); assert.equal(result.exitCode, 1)
  await assert.rejects(runBounded(process.execPath, args, f.options), { code: 'process_failed' })
})
test('workspace captures deleted old content, rename sides, additions and full untracked diff', async t => {
  const f = await fixture(t), record = await capture(f, { mode: 'workspace' })
  assert.equal(record.entries.length, 7)
  const find = path => record.entries.find(x => (x.new?.path ?? x.old?.path) === path)
  assert.equal(find('src/gone.ts').old.content, 'export const obsolete = true\n')
  assert.equal(find('src/gone.ts').new, null)
  assert.match(find('src/gone.ts').diff, /-export const obsolete/)
  assert.equal(find('src/renamed.ts').old.path, 'src/original.ts')
  assert.equal(find('src/renamed.ts').old.contentSha256, find('src/renamed.ts').new.contentSha256)
  assert.match(find('src/renamed.ts').diff, /rename from src\/original.ts/)
  assert.equal(find('src/added.ts').old, null)
  assert.match(find('src/untracked.ts').diff, /\+export const loose = true/)
  assert.ok(record.entries.every(x => x.diffSha256 === sha(x.diff)))
  assert.equal(record.resolvedBase.length, 40); assert.equal(record.resolvedTarget, null)
  assert.equal(record.outcome, 'changes')
  await writeFile(join(f.repository, 'src/greet.ts'), 'later external edit\n')
  assert.equal(find('src/greet.ts').new.content, 'export const greeting = "new"\n')
})
test('historical commit reads Git blobs despite unrelated dirty current files', async t => {
  const f = await fixture(t), target = await commit(f), base = (await git(f, ['rev-parse', `${target}^`])).trim()
  await writeFile(join(f.repository, 'src/greet.ts'), 'outside the selected revision\n')
  const record = await capture(f, { mode: 'commit', commit: target })
  assert.equal(record.resolvedBase, base); assert.equal(record.resolvedTarget, target)
  assert.equal(record.entries.find(x => x.new?.path === 'src/greet.ts').new.content, 'export const greeting = "new"\n')
})
test('root commit compares with empty tree instead of guessing a parent', async t => {
  const f = await fixture(t), record = await capture(f, { mode: 'commit', commit: f.base })
  assert.equal(record.baseKind, 'empty_tree')
  assert.ok(record.entries.every(x => x.old === null && x.status === 'added'))
  assert.equal(record.entries.length, 5)
})
async function divergence(f) {
  const target = await commit(f)
  await git(f, ['checkout', '--quiet', '-b', 'synthetic-source', f.base])
  await writeFile(join(f.repository, 'src/source-only.ts'), 'export const fromOnly = true\n')
  const from = await commit(f)
  return { from, target }
}
test('divergent range uses unique merge-base and excludes source-only differences', async t => {
  const f = await fixture(t), { from, target } = await divergence(f)
  const record = await capture(f, { mode: 'range', from, to: target })
  assert.equal(record.mergeBase, f.base); assert.equal(record.resolvedBase, f.base)
  assert.equal(record.resolvedTarget, target); assert.equal(record.entries.length, 7)
  assert.ok(!record.entries.some(x => x.old?.path === 'src/source-only.ts'))
  assert.match(await git(f, ['diff', '--name-only', from, target]), /source-only/)
})
test('merge commit compares only with its first parent', async t => {
  const f = await fixture(t), { from, target } = await divergence(f)
  await git(f, ['checkout', '--quiet', '--detach', target])
  await git(f, ['merge', '--quiet', '--no-ff', '-m', 'synthetic merge', from])
  const merged = (await git(f, ['rev-parse', 'HEAD'])).trim()
  const record = await capture(f, { mode: 'commit', commit: merged })
  assert.equal(record.resolvedBase, target); assert.equal(record.baseKind, 'first_parent')
  assert.equal(record.entries.length, 1); assert.equal(record.entries[0].new.path, 'src/source-only.ts')
})
test('multiple best merge-bases are refused instead of selecting one arbitrarily', async t => {
  const f = await fixture(t), tree = (await git(f, ['rev-parse', `${f.base}^{tree}`])).trim()
  const create = async (message, parents) => (await git(f, ['commit-tree', tree, ...parents.flatMap(p => ['-p', p]), '-m', message])).trim()
  const left = await create('synthetic left', [f.base]), right = await create('synthetic right', [f.base])
  const topLeft = await create('synthetic top left', [left, right]), topRight = await create('synthetic top right', [right, left])
  assert.equal((await git(f, ['merge-base', '--all', topLeft, topRight])).trim().split('\n').length, 2)
  await assert.rejects(capture(f, { mode: 'range', from: topLeft, to: topRight }), { code: 'ambiguous_merge_base' })
})
test('unrelated histories fail explicitly instead of appearing as empty changes', async t => {
  const f = await fixture(t), tree = (await git(f, ['rev-parse', `${f.base}^{tree}`])).trim()
  const unrelated = (await git(f, ['commit-tree', tree, '-m', 'synthetic unrelated root'])).trim()
  await assert.rejects(capture(f, { mode: 'range', from: f.base, to: unrelated }), { code: 'unrelated_history' })
})
test('empty worktree and empty commit are no_changes with no invented diff', async t => {
  const f = await fixture(t); await commit(f)
  const workspace = await capture(f, { mode: 'workspace' })
  assert.equal(workspace.outcome, 'no_changes'); assert.deepEqual(workspace.entries, [])
  await git(f, ['commit', '--quiet', '--allow-empty', '-m', 'synthetic empty'])
  const commitRecord = await capture(f, { mode: 'commit', commit: (await git(f, ['rev-parse', 'HEAD'])).trim() })
  assert.equal(commitRecord.outcome, 'no_changes'); assert.deepEqual(commitRecord.entries, [])
})
test('binary bytes keep exact hash and never become decoded review text', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 128, 13, 10, 0])
  await writeFile(join(f.repository, 'src/binary.ts'), bytes)
  const record = await capture(f, { mode: 'workspace' })
  const entry = record.entries.find(x => x.new?.path === 'src/binary.ts')
  assert.equal(entry.kind, 'binary'); assert.equal(entry.new.content, null)
  assert.equal(entry.new.contentSha256, sha(bytes)); assert.equal(entry.new.bytes, bytes.length)
  assert.match(entry.diff, /GIT binary patch/)
})
test('unicode and pathspec metacharacters locate only the literal file', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'src/中文 [1].ts'), 'export const unicode = "你好"\n')
  const record = await capture(f, { mode: 'workspace' })
  const entry = record.entries.find(x => x.new?.path === 'src/中文 [1].ts')
  assert.equal(entry.new.content, 'export const unicode = "你好"\n')
  assert.match(entry.diff, /你好/)
})
test('UTF8 BOM is preserved in captured text instead of silently stripped', async t => {
  const f = await fixture(t), content = '\uFEFFexport const bom = true\r\n'
  await writeFile(join(f.repository, 'src/bom.ts'), content)
  const entry = (await capture(f, { mode: 'workspace' })).entries.find(x => x.new?.path === 'src/bom.ts')
  assert.equal(entry.new.content, content)
  assert.equal(entry.new.contentSha256, sha(Buffer.from(content)))
})
test('invalid UTF8 without a binary marker is rejected instead of replacement decoded', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'src/invalid-encoding.ts'), Buffer.from([255, 128]))
  await assert.rejects(capture(f, { mode: 'workspace' }), { code: 'unsupported_encoding' })
})
test('persistent concurrent source edits invalidate a workspace capture', async t => {
  const f = await fixture(t)
  let serial = 0, writeError, pending = Promise.resolve()
  const timer = setInterval(() => {
    const content = `external edit ${serial++}\n`
    pending = pending.then(() => writeFile(join(f.repository, 'src/greet.ts'), content)).catch(error => { writeError ??= error })
  }, 50)
  try { await assert.rejects(capture(f, { mode: 'workspace' }), { code: 'input_changed' }) }
  finally { clearInterval(timer); await pending }
  assert.equal(writeError, undefined)
})
test('staged symlink is rejected by Git mode without dereferencing its target', async t => {
  const f = await fixture(t), targetText = join(f.scratch, 'outside.txt')
  await writeFile(targetText, 'synthetic pointer only')
  const oid = (await git(f, ['hash-object', '-w', '--', targetText])).trim()
  await git(f, ['update-index', '--add', '--cacheinfo', '120000', oid, 'src/link.ts'])
  await assert.rejects(capture(f, { mode: 'workspace' }), { code: 'unsupported_git_mode' })
})
test('directory link traversal is rejected before reading external content', async t => {
  const f = await fixture(t), linked = join(f.repository, 'linked'), external = join(f.scratch, 'external')
  await mkdir(linked); await writeFile(join(linked, 'a.ts'), 'initial\n'); await commit(f)
  await mkdir(external); await writeFile(join(external, 'a.ts'), 'external sentinel\n')
  await rm(linked, { recursive: true }); await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(capture(f, { mode: 'workspace' }), { code: 'unsafe_file' })
})
test('oversized or invalid budgets fail explicitly rather than dropping files', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, 'src/large.ts'), 'a'.repeat(300000))
  await assert.rejects(capture(f, { mode: 'workspace' }), { code: 'input_limit' })
  await assert.rejects(capture(f, { mode: 'workspace' }, { maxFileBytes: 0 }), { code: 'invalid_options' })
})
test('R0 capture refuses actual project paths before any source access', async t => {
  const f = await fixture(t)
  await assert.rejects(capture({ ...f, repository: process.cwd() }, { mode: 'workspace' }), { code: 'unmanaged_repository' })
  await assert.rejects(capture(f, { mode: 'commit', commit: '--injected' }), { code: 'invalid_mode' })
})
test('a managed directory cannot redirect Git metadata outside its own repository', async t => {
  const f = await fixture(t), other = await fixture(t)
  await rename(join(f.repository, '.git'), join(f.repository, '.git-backup'))
  await writeFile(join(f.repository, '.git'), `gitdir: ${join(other.repository, '.git')}\n`)
  await assert.rejects(capture(f, { mode: 'workspace' }), { code: 'unmanaged_repository' })
})
test('real fixed OCR matches normalized complex inputs and honest coverage', {
  skip: !process.env.ITEROOM_OCR_BIN && 'Actual OCR binary required; no mock substitute.',
}, async () => {
  const { inspectReviewInputs } = await import('../scripts/r0/ocr-review-input.mjs')
  const report = await inspectReviewInputs(process.env.ITEROOM_OCR_BIN)
  assert.equal(report.status, 'passed')
  assert.equal(report.actualCli, true)
  assert.ok(report.scenarios.every(x => x.coverageMatches && x.inputUnchanged))
  for (const name of ['workspace', 'commit', 'divergent-range', 'root-commit', 'merge-commit', 'empty-workspace', 'empty-commit', 'binary-and-unicode']) {
    assert.ok(report.scenarios.some(x => x.name === name), name)
  }
  assert.ok(report.boundaries.every(x => x.rejectedBeforeDelegate))
  const serialized = JSON.stringify(report)
  assert.ok(!/AppData|Users[\\/]|export const|GIT binary patch|external sentinel/.test(serialized))
  assert.equal(report.gateB, 'not_completed')
})
