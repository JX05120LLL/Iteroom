// Actual Git export verification against disposable synthetic bytes; no product writer or model.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { definePatchScope, createPatchCandidate, validatePatchCandidate,
  planPatchApplication, planPatchRecovery } from '../../src/host/managed-patch-contract.js'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const name = process.argv[2] ?? 'patch-contract'
assert.match(name, /^[a-z0-9-]{1,80}$/)
const flags = process.argv.slice(3)
assert.ok(flags.length === 0 || flags.length === 1 && flags[0] === '--fail-initialization')
const injectFailure = flags.length === 1
const root = await mkdtemp(join(tmpdir(), 'iteroom-r5-patch-probe-')), project = join(root, 'project')
const sha = value => createHash('sha256').update(value).digest('hex'), exec = promisify(execFile)
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^GIT_/.test(key)) delete env[key]
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-config'), GIT_OPTIONAL_LOCKS: '0' })
const gitAt = async (cwd, ...args) => (await exec('git', ['-c', `core.hooksPath=${join(root, 'hooks')}`,
  '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
{ cwd, env, windowsHide: true, timeout: 15000, maxBuffer: 1048576 })).stdout.trim()
const git = (...args) => gitAt(project, ...args)
const report = { version: 1, generatedAt: new Date().toISOString(), platform: process.platform, node: process.version,
  parent: null, success: false, realModelRequests: 0,
  actualSandboxAllocations: 0, userSourceTransmitted: false, productV2Connected: false, actualFilesystemRecovery: false,
  r5Complete: false, v1Complete: false }
let phase = 'initialization', failed = false
try {
  if (injectFailure) throw Error('INJECTED_INITIALIZATION_FAILURE')
  await writeFile(env.GIT_CONFIG_GLOBAL, '')
  await mkdir(join(root, 'hooks')); await mkdir(project)
  report.parent = await gitAt(repository, 'rev-parse', 'HEAD')
  phase = 'fixture'
  await git('init', '-q'); await git('config', 'user.name', 'Synthetic'); await git('config', 'user.email', 'synthetic@example.invalid')
  await mkdir(join(project, 'src')); await mkdir(join(project, 'test'))
  const inputs = { 'src/modify.js': 'old\r\n', 'src/delete.js': 'remove\n', 'src/old.js': 'old rename',
    'empty-delete.js': '', 'empty-old.js': '', 'src/bom.js': '\ufeff中文\r\n', 'test/fixed.test.js': 'fixed test\n' }
  for (const [path, text] of Object.entries(inputs)) await writeFile(join(project, path), text)
  await git('add', '.'); await git('commit', '-qm', 'Synthetic initial')
  const before = { head: await git('rev-parse', 'HEAD'), index: sha(await readFile(join(project, '.git/index'))),
    sourceHashes: Object.fromEntries(Object.entries(inputs).map(([path, text]) => [path, sha(text)])) }
  const present = text => ({ kind: 'file', mode: '100644', sha256: sha(text), byteLength: Buffer.byteLength(text) })
  const absent = () => ({ kind: 'absent' }), side = (path, text) => ({ path, text })
  const scope = definePatchScope('b1111111-1111-4111-8111-111111111111', [
    ...Object.entries(inputs).map(([path, text]) => ({ path, writable: !path.startsWith('test/'), before: present(text) })),
    ...['src/add.js', 'src/new.js', 'empty-add.js', 'empty-new.js'].map(path => ({ path, writable: true, before: absent() }))])
  const artifact = createPatchCandidate(scope, [
    { kind: 'added', old: null, new: side('src/add.js', 'added\n') },
    { kind: 'modified', old: side('src/modify.js', inputs['src/modify.js']), new: side('src/modify.js', 'changed\r\n') },
    { kind: 'deleted', old: side('src/delete.js', inputs['src/delete.js']), new: null },
    { kind: 'renamed', old: side('src/old.js', inputs['src/old.js']), new: side('src/new.js', 'rename changed') },
    { kind: 'added', old: null, new: side('empty-add.js', '') },
    { kind: 'deleted', old: side('empty-delete.js', ''), new: null },
    { kind: 'renamed', old: side('empty-old.js', ''), new: side('empty-new.js', '') },
    { kind: 'modified', old: side('src/bom.js', inputs['src/bom.js']), new: side('src/bom.js', '\ufeff中文更新\r\n') }])
  assert.deepEqual(validatePatchCandidate(scope, JSON.parse(JSON.stringify(artifact))), artifact)
  phase = 'pure-recovery'
  const observations = scope.entries.map(item => ({ path: item.path, state: item.before }))
  const update = (all, step) => all.map(item => item.path === step.path ? { path: item.path, state: step.replacement } : item)
  const plan = planPatchApplication(scope, artifact, observations), end = plan.steps.reduce(update, observations)
  for (let count = 0; count <= plan.steps.length; count++) {
    const current = plan.steps.slice(0, count).reduce(update, observations), journal = { ...plan.journal, completedSteps: count }
    assert.deepEqual(planPatchRecovery(scope, artifact, current, journal, 'finish').steps.reduce(update, current), end)
    assert.deepEqual(planPatchRecovery(scope, artifact, current, journal, 'rollback').steps.reduce(update, current), observations)
  }
  phase = 'git-apply'
  const patch = join(root, 'synthetic.patch'); await writeFile(patch, artifact.patch)
  await git('apply', '--check', '--whitespace=nowarn', patch)
  assert.equal(await git('status', '--porcelain'), '')
  await git('apply', '--whitespace=nowarn', patch)
  for (const item of artifact.changes) {
    if (item.new) assert.equal(sha(await readFile(join(project, item.new.path))), item.new.sha256)
    if (item.old && (!item.new || item.old.path !== item.new.path)) await assert.rejects(readFile(join(project, item.old.path)), { code: 'ENOENT' })
  }
  assert.equal(sha(await readFile(join(project, 'test/fixed.test.js'))), before.sourceHashes['test/fixed.test.js'])
  phase = 'git-reverse'
  await git('apply', '--reverse', '--check', '--whitespace=nowarn', patch)
  await git('apply', '--reverse', '--whitespace=nowarn', patch)
  assert.equal(await git('status', '--porcelain'), '')
  for (const [path, digest] of Object.entries(before.sourceHashes)) assert.equal(sha(await readFile(join(project, path))), digest)
  assert.equal(await git('rev-parse', 'HEAD'), before.head)
  assert.equal(sha(await readFile(join(project, '.git/index'))), before.index)
  Object.assign(report, { success: true, gitVersion: await git('--version'), scopeId: scope.id, patchSha256: artifact.sha256,
    operations: Object.fromEntries(['added', 'modified', 'deleted', 'renamed'].map(kind => [kind, artifact.changes.filter(item => item.kind === kind).length])),
    pureRecoveryPrefixesChecked: plan.steps.length + 1, actualGitApplyCheck: true, actualGitApply: true,
    actualGitReverseCheck: true, actualGitReverse: true, syntheticSourceHashesRestored: before.sourceHashes,
    syntheticHeadIndexStatusPreserved: true, bomCrlfNoFinalNewlineAndEmptyFilesChecked: true })
} catch (error) {
  failed = true; report.failureStage = phase
  await writeFile(join(tmpdir(), `iteroom-r5-${name}-private.log`), error.stderr || error.stack || String(error), { mode: 0o600 })
} finally {
  try {
    const actual = await realpath(root), temporary = await realpath(tmpdir()), offset = relative(temporary, actual)
    assert.ok(offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) && basename(actual).startsWith('iteroom-r5-patch-probe-'))
    await rm(actual, { recursive: true, force: true }); report.temporaryDirectoryRemoved = true
  } catch { failed = true; report.success = false; report.temporaryDirectoryRemoved = false }
  report.expectedFailureCleanupPassed = injectFailure && report.failureStage === 'initialization' && report.temporaryDirectoryRemoved === true
  report.moduleHash = sha(await readFile(join(repository, 'src/host/managed-patch-contract.js')))
  report.probeHash = sha(await readFile(fileURLToPath(import.meta.url)))
  await writeFile(join(repository, `docs/r5/${name}-report.json`), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ success: report.success, failureStage: report.failureStage,
  operations: report.operations, pureRecoveryPrefixesChecked: report.pureRecoveryPrefixesChecked,
  actualGitApply: report.actualGitApply, actualGitReverse: report.actualGitReverse, temporaryDirectoryRemoved: report.temporaryDirectoryRemoved,
  expectedFailureCleanupPassed: report.expectedFailureCleanupPassed }))
if (failed && !report.expectedFailureCleanupPassed) throw Error('Synthetic patch contract evidence failed; inspect anonymous report')
