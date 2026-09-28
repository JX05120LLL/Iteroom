import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, access, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFixture, git } from '../scripts/r0/ocr-fixture.mjs'
import { captureReviewInput } from '../scripts/r0/review-input.mjs'
import { controlledEnv } from '../scripts/r0/ocr-process.mjs'
async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), 'iteroom-r0-fixed-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  return { ...await createFixture(scratch), scratch }
}
async function copy(t, f, input) {
  const module = await import('../scripts/r0/fixed-review-copy.mjs')
  assert.equal(typeof module.createFixedReviewCopy, 'function', 'fixed-copy constructor is required')
  const result = await module.createFixedReviewCopy(f, input)
  t.after(() => result.dispose())
  return result
}
test('workspace copy survives source edits and removal with identical contents and complete diffs', async t => {
  const f = await fixture(t), fixed = await copy(t, f, { mode: 'workspace' })
  assert.notEqual(fixed.fixture.repository, f.repository)
  await writeFile(join(f.repository, 'src/greet.ts'), 'later source change\n')
  await rm(f.scratch, { recursive: true })
  const captured = await captureReviewInput(fixed.fixture, { mode: 'workspace' })
  assert.equal(captured.inputSha256, fixed.record.inputSha256)
  assert.equal(captured.entries.length, 7)
  assert.equal(captured.entries.find(x => x.new?.path === 'src/greet.ts').new.content, 'export const greeting = "new"\n')
  assert.equal(captured.entries.find(x => x.status === 'renamed').old.path, 'src/original.ts')
  assert.match(captured.entries.find(x => x.new?.path === 'src/untracked.ts').diff, /\+export const loose = true/)
  await assert.rejects(access(join(fixed.fixture.repository, '.git/objects/info/alternates')), { code: 'ENOENT' })
})
test('selected historical revisions including dangling commits keep original object identities', async t => {
  const f = await fixture(t)
  await git(f, ['add', '--all']); await git(f, ['commit', '--quiet', '-m', 'synthetic selected target'])
  const target = (await git(f, ['rev-parse', 'HEAD'])).trim()
  const tree = (await git(f, ['rev-parse', `${target}^{tree}`])).trim()
  const dangling = (await git(f, ['commit-tree', tree, '-p', target, '-m', 'synthetic unreferenced commit'])).trim()
  for (const input of [{ mode: 'commit', commit: target }, { mode: 'commit', commit: f.base },
    { mode: 'commit', commit: dangling }, { mode: 'range', from: f.base, to: target }]) {
    const fixed = await copy(t, f, input)
    await writeFile(join(f.repository, 'src/greet.ts'), 'unrelated dirty content\n')
    assert.equal((await captureReviewInput(fixed.fixture, input)).inputSha256, fixed.record.inputSha256)
    assert.equal(fixed.record.resolvedTarget, input.commit ?? input.to)
  }
})
test('copy preserves BOM CRLF binary bytes and executable Git index mode without checkout', async t => {
  const f = await fixture(t), bom = '\uFEFFexport const bom = true\r\n', binary = Buffer.from([0, 255, 128, 13, 10])
  await writeFile(join(f.repository, 'src/bom.ts'), bom)
  await writeFile(join(f.repository, 'src/binary.ts'), binary)
  await git(f, ['add', '--all']); await git(f, ['update-index', '--chmod=+x', 'src/bom.ts'])
  const fixed = await copy(t, f, { mode: 'workspace' })
  assert.deepEqual(await readFile(join(fixed.fixture.repository, 'src/binary.ts')), binary)
  assert.equal(await readFile(join(fixed.fixture.repository, 'src/bom.ts'), 'utf8'), bom)
  assert.match(await git(fixed.fixture, ['ls-files', '--stage', 'src/bom.ts']), /^100755 /)
  assert.equal(fixed.record.entries.find(x => x.new?.path === 'src/bom.ts').new.mode, '100755')
})
test('changed fixed copy is detected rather than silently generating a different report', async t => {
  const f = await fixture(t), fixed = await copy(t, f, { mode: 'workspace' })
  await writeFile(join(fixed.fixture.repository, 'src/greet.ts'), 'copy tampered\n')
  await assert.rejects(fixed.verify(), { code: 'input_changed' })
})
test('unborn workspace uses the empty tree and copy preserves staged plus untracked additions', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'iteroom-r0-unborn-test-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const repository = join(scratch, 'repository'), home = join(scratch, 'home')
  await mkdir(repository); await mkdir(join(home, 'hooks'), { recursive: true })
  const f = { repository, home, options: { cwd: repository, env: controlledEnv(home) } }
  await git(f, ['init', '--quiet']); await writeFile(join(repository, 'new.ts'), 'export const fresh = true\n')
  await git(f, ['add', 'new.ts']); await writeFile(join(repository, 'loose.ts'), 'export const loose = true\n')
  const fixed = await copy(t, f, { mode: 'workspace' })
  assert.equal(fixed.record.baseKind, 'unborn_empty_tree')
  assert.equal(fixed.record.entries.length, 2)
  assert.ok(fixed.record.entries.every(x => x.old === null && x.status === 'added'))
  await rm(scratch, { recursive: true }); await fixed.verify()
  await writeFile(join(fixed.fixture.repository, 'new.ts'), 'unstaged change\n')
  await assert.rejects(captureReviewInput(fixed.fixture, { mode: 'workspace' }), { code: 'unborn_unstaged_input' })
})
test('working and historical attributes fail before any filter or text conversion', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, '.gitattributes'), '*.ts text eol=lf\n')
  await assert.rejects(captureReviewInput(f, { mode: 'workspace' }), { code: 'unsupported_git_attributes' })
  await git(f, ['add', '--all']); await git(f, ['commit', '--quiet', '-m', 'synthetic attributes'])
  const target = (await git(f, ['rev-parse', 'HEAD'])).trim()
  await rm(join(f.repository, '.gitattributes'))
  await assert.rejects(captureReviewInput(f, { mode: 'commit', commit: target }), { code: 'unsupported_git_attributes' })
})
test('repository filter configuration is refused without executing its synthetic sentinel command', async t => {
  const f = await fixture(t), sentinel = join(f.scratch, 'filter-ran')
  await git(f, ['config', 'filter.synthetic.clean', `node -e "require('fs').writeFileSync('filter-ran','yes')"`])
  await writeFile(join(f.repository, '.gitattributes'), '*.ts filter=synthetic\n')
  await assert.rejects(captureReviewInput(f, { mode: 'workspace' }), { code: 'unsupported_git_config' })
  await assert.rejects(access(sentinel), { code: 'ENOENT' })
  await assert.rejects(access(join(f.repository, 'filter-ran')), { code: 'ENOENT' })
})
test('info attributes and alternate object stores are refused before Git reads external resources', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, '.git/info/attributes'), '*.ts text\n')
  await assert.rejects(captureReviewInput(f, { mode: 'workspace' }), { code: 'unsupported_git_attributes' })
  await rm(join(f.repository, '.git/info/attributes'))
  await writeFile(join(f.repository, '.git/objects/info/alternates'), join(f.scratch, 'outside-objects'))
  await assert.rejects(captureReviewInput(f, { mode: 'workspace' }), { code: 'external_git_storage' })
})
test('ignored nested attributes are refused even though Git excludes them from the loose file list', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repository, '.gitignore'), '.gitattributes\n')
  await writeFile(join(f.repository, 'src/.gitattributes'), '*.ts text eol=lf\n')
  await assert.rejects(captureReviewInput(f, { mode: 'workspace' }), { code: 'unsupported_git_attributes' })
})
test('linked object storage is rejected without following the external directory', async t => {
  const f = await fixture(t), external = join(f.scratch, 'external-objects')
  await mkdir(external)
  await rm(join(f.repository, '.git/objects/pack'), { recursive: true })
  await symlink(external, join(f.repository, '.git/objects/pack'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(captureReviewInput(f, { mode: 'workspace' }), { code: 'external_git_storage' })
})
test('actual OCR reads fixed copies and confirms unsupported unborn worktrees without a model', {
  skip: !process.env.ITEROOM_OCR_BIN && 'Actual OCR binary required; no mock substitute.',
}, async () => {
  const { inspectFixedReviewInputs } = await import('../scripts/r0/ocr-fixed-input.mjs')
  const report = await inspectFixedReviewInputs(process.env.ITEROOM_OCR_BIN)
  assert.equal(report.status, 'passed'); assert.equal(report.actualCli, true)
  assert.equal(report.gateB, 'passed')
  assert.ok(report.scenarios.every(x => x.sourceChangedAfterCopy && x.copyVerifiedAfterDelegate && x.coverageMatches))
  for (const name of ['workspace', 'commit', 'range', 'root-commit', 'empty-workspace', 'byte-and-mode']) {
    assert.ok(report.scenarios.some(x => x.name === name), name)
  }
  assert.equal(report.unborn.supported, true)
  assert.equal(report.unborn.actualCliExitCode, 0)
  assert.equal(report.unborn.input.baseKind, 'unborn_empty_tree')
  assert.ok(!/AppData|Users[\\/]|export const|GIT binary patch|later source change/.test(JSON.stringify(report)))
  assert.equal(report.modelCalled, false); assert.equal(report.syntheticRepositoriesRemoved, true)
})
