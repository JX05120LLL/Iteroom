import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { definePatchScope, createPatchCandidate, validatePatchCandidate,
  planPatchApplication, planPatchRecovery } from '../src/host/managed-patch-contract.js'

const taskId = 'a1111111-1111-4111-8111-111111111111'
const sha = value => createHash('sha256').update(value).digest('hex')
const file = text => ({ kind: 'file', mode: '100644', sha256: sha(text), byteLength: Buffer.byteLength(text) })
const absent = () => ({ kind: 'absent' })
const entry = (path, text, writable = true) => ({ path, writable, before: text === null ? absent() : file(text) })
const side = (path, text) => ({ path, text })
const change = (kind, old, next) => ({ kind, old, new: next })
const observed = scope => scope.entries.map(({ path, before }) => ({ path, state: structuredClone(before) }))
const clone = value => structuredClone(value)
const update = (current, step) => current.map(item => item.path === step.path
  ? { path: item.path, state: clone(step.replacement) } : item)
const fixture = () => {
  const scope = definePatchScope(taskId, [entry('src/add.js', null), entry('src/mod.js', 'old\r\n'),
    entry('src/delete.js', 'delete me\n'), entry('src/old.js', 'rename me'), entry('src/new.js', null),
    entry('test/fixed.test.js', 'fixed test\n', false)])
  const artifact = createPatchCandidate(scope, [change('added', null, side('src/add.js', 'new\n')),
    change('modified', side('src/mod.js', 'old\r\n'), side('src/mod.js', 'changed\r\n')),
    change('deleted', side('src/delete.js', 'delete me\n'), null),
    change('renamed', side('src/old.js', 'rename me'), side('src/new.js', 'rename changed'))])
  return { scope, artifact }
}

test('v2 binds four patch kinds to an explicit file-or-absence scope without mutating input', () => {
  const { scope, artifact } = fixture()
  assert.equal(scope.version, 2)
  assert.equal(artifact.version, 2)
  assert.equal(artifact.snapshotId, scope.id)
  assert.deepEqual(artifact.changes.map(item => item.kind), ['added', 'modified', 'deleted', 'renamed'])
  assert.equal(artifact.sha256, sha(artifact.patch))
  assert.deepEqual(validatePatchCandidate(scope, JSON.parse(JSON.stringify(artifact))), artifact)
  const before = JSON.stringify(scope), inputs = observed(scope)
  const plan = planPatchApplication(scope, artifact, inputs)
  assert.deepEqual(plan.steps.map(item => item.action), ['create', 'replace', 'remove', 'create', 'remove'])
  assert.equal(plan.journal.completedSteps, 0)
  assert.equal(plan.journal.inFlightStep, null)
  assert.equal(JSON.stringify(scope), before)
  assert.deepEqual(inputs, observed(scope))
})

test('empty files remain present and empty add/delete and pure rename are valid changes', () => {
  const scope = definePatchScope(taskId, [entry('empty-add.js', null), entry('empty-delete.js', ''),
    entry('before.js', ''), entry('after.js', null)])
  const artifact = createPatchCandidate(scope, [change('added', null, side('empty-add.js', '')),
    change('deleted', side('empty-delete.js', ''), null), change('renamed', side('before.js', ''), side('after.js', ''))])
  assert.equal(artifact.changes[0].new.sha256, sha(''))
  assert.equal(scope.entries.find(item => item.path === 'empty-delete.js').before.kind, 'file')
  assert.equal(scope.entries.find(item => item.path === 'empty-add.js').before.kind, 'absent')
  assert.match(artifact.patch, /new file mode 100644/)
  assert.match(artifact.patch, /deleted file mode 100644/)
  assert.match(artifact.patch, /rename from before.js/)
  assert.throws(() => createPatchCandidate(scope, [change('added', null, side('empty-delete.js', ''))]), { code: 'PATCH_CANDIDATE_INVALID' })
  assert.throws(() => createPatchCandidate(scope, [change('modified', side('empty-delete.js', ''), side('empty-delete.js', ''))]), { code: 'PATCH_CANDIDATE_INVALID' })
})

test('scope identity covers permissions and canonical order, with detached results', () => {
  const entries = [entry('z.js', null), entry('a.js', 'a')]
  const first = definePatchScope(taskId, entries)
  const second = definePatchScope(taskId, [...entries].reverse())
  assert.equal(first.id, second.id)
  const reordered = entries.map(item => ({ before: Object.fromEntries(Object.entries(item.before).reverse()),
    writable: item.writable, path: item.path }))
  assert.equal(definePatchScope(taskId, reordered).id, first.id, 'JSON field order must not alter scope identity')
  assert.notEqual(definePatchScope(taskId, [entry('z.js', null), entry('a.js', 'a', false)]).id, first.id)
  entries[1].before.sha256 = sha('changed')
  assert.equal(first.entries[0].before.sha256, sha('a'))
  const corrupted = clone(first); corrupted.entries[0].writable = false
  assert.throws(() => createPatchCandidate(corrupted, [change('added', null, side('z.js', 'z'))]), { code: 'PATCH_SCOPE_INVALID' })
})

test('unsafe, colliding and mutable test paths cannot acquire write scope', () => {
  for (const path of ['../x.js', '/x.js', 'C:/x.js', 'src\\x.js', '.git/config', '.env',
    'src/secrets.json', 'src/NUL.js', 'src/a:b.js', 'src/a.js.', 'src/a\n.js', '空.js']) {
    assert.throws(() => definePatchScope(taskId, [entry(path, null)]), { code: 'PATCH_SCOPE_INVALID' }, path)
  }
  for (const paths of [['src/a.js', 'src/A.js'], ['src/a', 'src/a/b.js']]) {
    assert.throws(() => definePatchScope(taskId, paths.map(path => entry(path, null))), { code: 'PATCH_SCOPE_INVALID' })
  }
  for (const path of ['test/x.js', 'tests/x.js', '__tests__/x.js', 'src/x.test.js', 'src/x.spec.ts']) {
    assert.throws(() => definePatchScope(taskId, [entry(path, 'fixed')]), { code: 'PATCH_SCOPE_INVALID' })
    const scope = definePatchScope(taskId, [entry(path, 'fixed', false)])
    assert.throws(() => createPatchCandidate(scope, [change('deleted', side(path, 'fixed'), null)]), { code: 'PATCH_CANDIDATE_INVALID' })
  }
})

test('non-string JSON paths cannot escape scope validation through coercion', () => {
  for (const path of [null, 123, {}, { toString: null, valueOf: null }]) {
    assert.throws(() => definePatchScope(taskId, [entry(path, null)]), { code: 'PATCH_SCOPE_INVALID' })
  }
})

test('unexpected fields, modes, counts and invalid metadata fail closed', () => {
  const { scope, artifact } = fixture()
  for (const entries of [[], Array.from({ length: 17 }, (_, i) => entry(`x${i}.js`, null)),
    [{ ...entry('x.js', null), writable: 'yes' }], [entry('x.js', 'x'), { ...entry('y.js', null), extra: true }],
    [{ ...entry('x.js', 'x'), before: { ...file('x'), mode: '120000' } }],
    [{ ...entry('x.js', 'x'), before: { ...file('x'), byteLength: -1 } }]]) {
    assert.throws(() => definePatchScope(taskId, entries), { code: 'PATCH_SCOPE_INVALID' })
  }
  for (const mutate of [value => { value.version = 1 }, value => { value.taskId = 'wrong' },
    value => { value.snapshotId = sha('wrong') }, value => { value.extra = true },
    value => { value.changes[0].new.sha256 = sha('forged') }, value => { value.changes[0].new.byteLength++ },
    value => { value.changes[0].new.mode = '100755' }, value => { value.changes[0].new.extra = true },
    value => { value.patch += '+forged\n'; value.sha256 = sha(value.patch) }]) {
    const altered = clone(artifact); mutate(altered)
    assert.throws(() => validatePatchCandidate(scope, altered), { code: 'PATCH_CANDIDATE_INVALID' })
  }
  // JSON field order does not change the canonical artifact identity.
  assert.deepEqual(validatePatchCandidate(scope, Object.fromEntries(Object.entries(artifact).reverse())), artifact)
})

test('sparse or decorated protocol arrays cannot create an empty or non-roundtrippable candidate', () => {
  const { scope, artifact } = fixture()
  assert.throws(() => createPatchCandidate(scope, new Array(1)), { code: 'PATCH_CANDIDATE_INVALID' })
  const changes = [change('added', null, side('src/add.js', 'new'))]; changes.extra = true
  assert.throws(() => createPatchCandidate(scope, changes), { code: 'PATCH_CANDIDATE_INVALID' })
  const entries = clone(scope.entries); entries.extra = true
  assert.throws(() => definePatchScope(taskId, entries), { code: 'PATCH_SCOPE_INVALID' })
  const candidate = clone(artifact); candidate.changes.extra = true
  assert.throws(() => validatePatchCandidate(scope, candidate), { code: 'PATCH_CANDIDATE_INVALID' })
  const inputs = observed(scope); inputs.extra = true
  assert.throws(() => planPatchApplication(scope, artifact, inputs), { code: 'PATCH_OBSERVATION_INVALID' })
})

test('empty side paths are rejected with a safe contract error', () => {
  const { scope } = fixture()
  assert.throws(() => createPatchCandidate(scope, [change('added', null, side('', 'new'))]), { code: 'PATCH_CANDIDATE_INVALID' })
})

test('unselected outputs, wrong old content, endpoint reuse and rename aliases are rejected', () => {
  const { scope } = fixture()
  for (const changes of [[], [change('added', null, side('elsewhere.js', 'x'))],
    [change('deleted', side('src/mod.js', 'not the input'), null)],
    [change('renamed', side('src/old.js', 'rename me'), side('src/OLD.js', 'x'))],
    [change('renamed', side('src/old.js', 'rename me'), side('src/mod.js', 'x'))],
    [change('renamed', side('src/old.js', 'rename me'), side('src/old.js', 'x'))],
    [change('deleted', side('src/old.js', 'rename me'), null), change('renamed', side('src/old.js', 'rename me'), side('src/new.js', 'x'))],
    [change('copy', side('src/old.js', 'rename me'), side('src/new.js', 'x'))]]) {
    assert.throws(() => createPatchCandidate(scope, changes), { code: 'PATCH_CANDIDATE_INVALID' })
  }
})

test('text and envelope limits refuse NUL, surrogate, file oversize and aggregate oversize', () => {
  const scope = definePatchScope(taskId, [entry('a.js', null), entry('b.js', null), entry('c.js', null),
    entry('d.js', null), entry('e.js', null)])
  for (const text of ['\0', '\ud800', 'x'.repeat(262145)]) {
    assert.throws(() => createPatchCandidate(scope, [change('added', null, side('a.js', text))]), { code: 'PATCH_CANDIDATE_INVALID' })
  }
  assert.throws(() => createPatchCandidate(scope, scope.entries.map(item => change('added', null, side(item.path, 'x'.repeat(262144))))),
    { code: 'PATCH_CANDIDATE_INVALID' })
})

test('exact file capacity is accepted but patch and escaped JSON capacity remain independent', () => {
  const scope = definePatchScope(taskId, ['a.js', 'b.js', 'c.js', 'd.js'].map(path => entry(path, null)))
  assert.equal(createPatchCandidate(scope, [change('added', null, side('a.js', 'x'.repeat(262144)))])
    .changes[0].new.byteLength, 262144)
  assert.throws(() => createPatchCandidate(scope, scope.entries.map(item => change('added', null, side(item.path, 'x'.repeat(262144))))),
    { code: 'PATCH_CANDIDATE_INVALID' }, 'headers also consume the patch budget')
  assert.throws(() => createPatchCandidate(scope, [change('added', null, side('a.js', '\u0001'.repeat(262144)))]),
    { code: 'PATCH_CANDIDATE_INVALID' }, 'JSON escaping consumes the envelope budget')
})

test('application requires all before states, including readonly inputs and absent targets', () => {
  const { scope, artifact } = fixture(), inputs = observed(scope)
  for (const altered of [inputs.slice(1), [...inputs, { path: 'extra.js', state: absent() }], [...inputs, inputs[0]],
    inputs.map(item => ({ ...item, state: { kind: 'unknown' } }))]) {
    assert.throws(() => planPatchApplication(scope, artifact, altered), { code: 'PATCH_OBSERVATION_INVALID' })
  }
  for (const path of ['src/add.js', 'src/mod.js', 'test/fixed.test.js']) {
    const altered = inputs.map(item => item.path === path ? { path, state: file('external') } : item)
    assert.throws(() => planPatchApplication(scope, artifact, altered), { code: 'PATCH_CONFLICT' })
  }
})

test('partial rename finishes or rolls back only the receipt-bound completed prefix', () => {
  const scope = definePatchScope(taskId, [entry('old.js', 'old'), entry('new.js', null)])
  const artifact = createPatchCandidate(scope, [change('renamed', side('old.js', 'old'), side('new.js', 'new'))])
  const plan = planPatchApplication(scope, artifact, observed(scope))
  const partial = update(observed(scope), plan.steps[0])
  const journal = { ...plan.journal, completedSteps: 1 }
  assert.throws(() => planPatchApplication(scope, artifact, partial), { code: 'PATCH_CONFLICT' })
  assert.throws(() => planPatchRecovery(scope, artifact, partial, plan.journal, 'finish'), { code: 'PATCH_CONFLICT' })
  const finish = planPatchRecovery(scope, artifact, partial, journal, 'finish')
  assert.deepEqual(finish.steps.map(item => [item.action, item.path]), [['remove', 'old.js']])
  const rollback = planPatchRecovery(scope, artifact, partial, journal, 'rollback')
  assert.deepEqual(rollback.steps.map(item => [item.action, item.path]), [['remove', 'new.js']])
  assert.equal(rollback.journal.direction, 'rollback')
  assert.equal(rollback.journal.forwardSteps, 1)
})

test('one recorded in-flight step may settle, with unknown or external effects blocked', () => {
  const { scope, artifact } = fixture(), plan = planPatchApplication(scope, artifact, observed(scope))
  const afterFirst = update(observed(scope), plan.steps[0])
  const writing = { ...plan.journal, inFlightStep: 0 }
  assert.equal(planPatchRecovery(scope, artifact, afterFirst, writing, 'finish').journal.completedSteps, 1)
  assert.equal(planPatchRecovery(scope, artifact, observed(scope), writing, 'finish').steps.length, plan.steps.length)
  const external = afterFirst.map(item => item.path === plan.steps[0].path ? { ...item, state: file('external') } : item)
  assert.throws(() => planPatchRecovery(scope, artifact, external, writing, 'rollback'), { code: 'PATCH_CONFLICT' })
  for (const altered of [{ ...writing, artifactId: sha('wrong') }, { ...writing, taskId: 'wrong' },
    { ...writing, completedSteps: 999 }, { ...writing, inFlightStep: 1 }, { ...writing, extra: true }]) {
    assert.throws(() => planPatchRecovery(scope, artifact, afterFirst, altered, 'finish'), { code: 'PATCH_RECOVERY_INVALID' })
  }
})

test('mixed completed operations roll back in reverse order and interrupted rollback only continues rollback', () => {
  const { scope, artifact } = fixture(), initial = observed(scope)
  const plan = planPatchApplication(scope, artifact, initial)
  const final = plan.steps.reduce(update, initial)
  const rollback = planPatchRecovery(scope, artifact, final, { ...plan.journal, completedSteps: plan.steps.length }, 'rollback')
  assert.deepEqual(rollback.steps.map(item => item.action), ['create', 'remove', 'create', 'replace', 'remove'])
  assert.deepEqual(rollback.steps.reduce(update, final), initial)
  const partial = update(final, rollback.steps[0])
  const resumed = planPatchRecovery(scope, artifact, partial, { ...rollback.journal, inFlightStep: 0 }, 'rollback')
  assert.equal(resumed.steps.length, rollback.steps.length - 1)
  assert.deepEqual(resumed.steps.reduce(update, partial), initial)
  assert.throws(() => planPatchRecovery(scope, artifact, partial, rollback.journal, 'finish'), { code: 'PATCH_RECOVERY_INVALID' })
})

test('every recorded interruption prefix can finish or roll back without crediting unrecorded work', () => {
  const { scope, artifact } = fixture(), initial = observed(scope)
  const plan = planPatchApplication(scope, artifact, initial)
  for (let count = 0; count <= plan.steps.length; count++) {
    const current = plan.steps.slice(0, count).reduce(update, initial)
    const journal = { ...plan.journal, completedSteps: count }
    const finish = planPatchRecovery(scope, artifact, current, journal, 'finish')
    assert.deepEqual(finish.steps.reduce(update, current), plan.steps.reduce(update, initial))
    const rollback = planPatchRecovery(scope, artifact, current, journal, 'rollback')
    assert.deepEqual(rollback.steps.reduce(update, current), initial)
    for (let undone = 0; undone <= rollback.steps.length; undone++) {
      const interrupted = rollback.steps.slice(0, undone).reduce(update, current)
      const resumed = planPatchRecovery(scope, artifact, interrupted, { ...rollback.journal, completedSteps: undone }, 'rollback')
      assert.deepEqual(resumed.steps.reduce(update, interrupted), initial)
    }
    if (count) assert.throws(() => planPatchRecovery(scope, artifact, current,
      { ...plan.journal, completedSteps: count - 1 }, 'finish'), { code: 'PATCH_CONFLICT' })
  }
})

test('actual Git accepts mixed, empty and rename exports in a disposable synthetic repository', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r5-patch-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), 'iteroom-r5-patch-')))
    await rm(root, { recursive: true, force: true })
  })
  const project = join(root, 'project'); await mkdir(project)
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^GIT_/.test(name)) delete env[name]
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-config'), GIT_OPTIONAL_LOCKS: '0' })
  await writeFile(env.GIT_CONFIG_GLOBAL, ''); await mkdir(join(root, 'hooks'))
  const git = async (...args) => (await promisify(execFile)('git', ['-c', `core.hooksPath=${join(root, 'hooks')}`,
    '-c', 'commit.gpgsign=false', ...args], { cwd: project, env, windowsHide: true })).stdout.trim()
  await git('init', '-q'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid')
  await git('config', 'core.autocrlf', 'false')
  await mkdir(join(project, 'src')); await mkdir(join(project, 'test'))
  const { scope, artifact } = fixture()
  const contents = { 'src/mod.js': 'old\r\n', 'src/delete.js': 'delete me\n', 'src/old.js': 'rename me', 'test/fixed.test.js': 'fixed test\n',
    'empty-delete.js': '', 'empty-old.js': '', 'src/bom.js': '\ufeff中文\r\n' }
  for (const [path, text] of Object.entries(contents)) await writeFile(join(project, path), text)
  await git('add', '.'); await git('commit', '-qm', 'Synthetic initial')
  const beforeHead = await git('rev-parse', 'HEAD'), beforeIndex = sha(await readFile(join(project, '.git/index')))
  const extraScope = definePatchScope(taskId, [entry('empty-add.js', null), entry('empty-delete.js', ''),
    entry('empty-old.js', ''), entry('empty-new.js', null), entry('src/bom.js', '\ufeff中文\r\n')])
  const extra = createPatchCandidate(extraScope, [change('added', null, side('empty-add.js', '')),
    change('deleted', side('empty-delete.js', ''), null), change('renamed', side('empty-old.js', ''), side('empty-new.js', '')),
    change('modified', side('src/bom.js', '\ufeff中文\r\n'), side('src/bom.js', '\ufeff中文更新\r\n'))])
  const patch = join(root, 'synthetic.patch'); await writeFile(patch, artifact.patch + extra.patch)
  await git('apply', '--check', '--whitespace=nowarn', patch)
  assert.equal(await git('status', '--porcelain'), '')
  await git('apply', '--whitespace=nowarn', patch)
  for (const change of [...artifact.changes, ...extra.changes]) {
    if (change.new) assert.equal(await readFile(join(project, change.new.path), 'utf8'), change.new.text)
    if (change.old && (!change.new || change.new.path !== change.old.path)) {
      await assert.rejects(readFile(join(project, change.old.path)), { code: 'ENOENT' })
    }
  }
  assert.equal(await readFile(join(project, 'test/fixed.test.js'), 'utf8'), 'fixed test\n')
  await git('apply', '--reverse', '--whitespace=nowarn', patch)
  assert.equal(await git('status', '--porcelain'), '')
  for (const [path, text] of Object.entries(contents)) assert.equal(await readFile(join(project, path), 'utf8'), text)
  assert.equal(await git('rev-parse', 'HEAD'), beforeHead)
  assert.equal(sha(await readFile(join(project, '.git/index'))), beforeIndex)
  assert.deepEqual((await readdir(join(project, 'src'))).sort(), ['bom.js', 'delete.js', 'mod.js', 'old.js'])
})
