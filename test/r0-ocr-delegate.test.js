import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBounded, controlledEnv } from '../scripts/r0/ocr-process.mjs'
import { parsePreview, parseRules, validatePath, modeArgs } from '../scripts/r0/ocr-contract.mjs'

const repository = join(tmpdir(), 'synthetic-ocr-repo')
const files = new Map([['src/a.ts', 'modified'], ['src/gone.ts', 'deleted'], ['test/a.test.ts', 'added']])
const context = { repository, mode: 'workspace', files }
function preview() {
  return { schema_version: '1', mode: 'workspace', repository, total_files: 3,
    reviewable_count: 1, excluded_count: 2, total_insertions: 2, total_deletions: 2,
    reviewable_files: [{ path: 'src/a.ts', status: 'modified', insertions: 1, deletions: 1 }],
    excluded_files: [{ path: 'src/gone.ts', status: 'deleted', insertions: 0, deletions: 1, exclude_reason: 'deleted' },
      { path: 'test/a.test.ts', status: 'added', insertions: 1, deletions: 0, exclude_reason: 'default_path' }] }
}
const parse = value => parsePreview(JSON.stringify(value), context)
test('accepts complete coverage including absent deleted files', () => {
  assert.equal(parse(preview()).excluded_files[0].exclude_reason, 'deleted')
})
test('rejects unsafe and Windows ambiguous paths', () => {
  for (const path of ['../x', '/x', 'C:/x', '\\\\host\\x', 'src\\x', 'src/../x', '.git/config',
    'src//x', '-flag', 'src/x\0.ts', 'src/CON.ts', 'src/x. ', 'src/X:stream', 'src/x?.ts', 'src/x".ts']) {
    assert.throws(() => validatePath(path), { code: 'invalid_path' })
  }
  assert.equal(validatePath('src/正常 文件.ts'), 'src/正常 文件.ts')
})
test('rejects malformed JSON, unknown or numeric schema', () => {
  assert.throws(() => parsePreview('{', context), { code: 'invalid_json' })
  for (const schema_version of [1, '2', null]) assert.throws(() => parse({ ...preview(), schema_version }), { code: 'invalid_schema' })
})
test('rejects wrong repository, mode and refs', () => {
  for (const delta of [{ repository: join(tmpdir(), 'other') }, { mode: 'commit' }, { commit: 'HEAD' }]) {
    assert.throws(() => parse({ ...preview(), ...delta }), { code: 'context_mismatch' })
  }
  assert.throws(() => parsePreview(JSON.stringify({ ...preview(), repository: 'synthetic-ocr-repo' }),
    { ...context, repository: join(process.cwd(), 'synthetic-ocr-repo') }), { code: 'context_mismatch' })
})
test('rejects missing, extra, duplicate and incorrect-status paths', () => {
  const mutations = [p => p.excluded_files.pop(), p => p.reviewable_files[0].path = 'src/unknown.ts',
    p => p.excluded_files[1].path = 'src/a.ts', p => p.reviewable_files[0].status = 'renamed']
  for (const mutate of mutations) { const p = preview(); mutate(p); assert.throws(() => parse(p)) }
})
test('rejects inconsistent counts, line totals, unknown reason and absent exclusion reason', () => {
  const mutations = [p => p.total_files++, p => p.total_insertions++, p => p.reviewable_count = -1,
    p => p.excluded_files[0].exclude_reason = 'invented', p => delete p.excluded_files[0].exclude_reason,
    p => p.reviewable_files[0].insertions = 0.5, p => p.reviewable_files[0].exclude_reason = 'default_path']
  for (const mutate of mutations) { const p = preview(); mutate(p); assert.throws(() => parse(p)) }
})
test('rules must locate every requested file exactly once with provenance and nonempty text', () => {
  const p = { schema_version: '1', groups: [{ group_id: 1, source: 'system', pattern: '**/*.ts',
    files: ['src/a.ts', 'test/a.test.ts'], rule: 'Synthetic rule.' }] }
  assert.equal(parseRules(JSON.stringify(p), ['src/a.ts', 'test/a.test.ts']).groups.length, 1)
  for (const mutate of [x => x.groups[0].files.pop(), x => x.groups[0].files.push('../x'),
    x => x.groups[0].files.push('src/a.ts'), x => x.groups[0].rule = '',
    x => x.groups[0].source = 'unknown', x => x.groups[0].group_id = 0]) {
    const x = structuredClone(p); mutate(x); assert.throws(() => parseRules(JSON.stringify(x), ['src/a.ts', 'test/a.test.ts']))
  }
})
test('only fixed hex commit/range inputs can become CLI argv', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40)
  assert.deepEqual(modeArgs({ mode: 'workspace' }), [])
  assert.deepEqual(modeArgs({ mode: 'commit', commit: a }), ['--commit', a])
  assert.deepEqual(modeArgs({ mode: 'range', from: a, to: b }), ['--from', a, '--to', b])
  for (const x of [{ mode: 'commit', commit: '--evil' }, { mode: 'range', from: a },
    { mode: 'workspace', commit: a }, { mode: 'unknown' }]) assert.throws(() => modeArgs(x))
})

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'iteroom-r0-ocr-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(dir, 'home'))
  return { cwd: dir, env: controlledEnv(join(dir, 'home')), timeoutMs: 5000, maxOutputBytes: 1024 }
}
test('controlled environment drops secrets, proxies and Git injection', () => {
  const env = controlledEnv(repository, { PATH: 'safe', SYSTEMROOT: 'system', API_KEY: 'secret',
    HTTPS_PROXY: 'secret', GIT_CONFIG_COUNT: '1', USERPROFILE: 'user', OCR_HOME: 'user' })
  assert.equal(env.PATH, 'safe'); assert.equal(env.USERPROFILE, repository)
  for (const key of ['API_KEY', 'HTTPS_PROXY', 'GIT_CONFIG_COUNT', 'OCR_HOME']) assert.equal(env[key], undefined)
})
test('process runner preserves literal arguments and does not use a shell', async t => {
  const opts = await scratch(t), literal = 'a b; $(echo private) & "quote"'
  const r = await runBounded(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], opts)
  assert.equal(r.stdout, literal); assert.equal(r.exitCode, 0)
})
test('nonzero exit and missing executable are typed failures without leaked stderr', async t => {
  const opts = await scratch(t)
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.stderr.write("secret");process.exit(7)'], opts),
    e => e.code === 'process_failed' && e.exitCode === 7 && !e.message.includes('secret'))
  await assert.rejects(runBounded(join(opts.cwd, 'missing.exe'), [], opts), { code: 'spawn_failed' })
})
test('timeout closes its own process tree before rejecting', async t => {
  const opts = await scratch(t)
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...opts, timeoutMs: 200 }), { code: 'timeout' })
})
test('combined stdout and stderr over limit fails instead of accepting truncated JSON', async t => {
  const opts = await scratch(t)
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.stdout.write("a".repeat(700));process.stderr.write("b".repeat(700));setInterval(()=>{},1000)'], opts), { code: 'output_limit' })
})
test('process runner rejects invalid budgets before spawn', async t => {
  const opts = await scratch(t)
  for (const delta of [{ timeoutMs: 0 }, { maxOutputBytes: -1 }, { timeoutMs: Infinity }]) {
    await assert.rejects(runBounded(process.execPath, ['-e', ''], { ...opts, ...delta }), { code: 'invalid_options' })
  }
  for (const command of ['', 'bad\0command']) await assert.rejects(runBounded(command, [], opts), { code: 'invalid_options' })
  await assert.rejects(runBounded(process.execPath, ['bad\0arg'], opts), { code: 'invalid_options' })
})

test('timeout stops a real descendant that inherited the output pipes', async t => {
  const opts = await scratch(t), pidFile = join(opts.cwd, 'descendant-pid')
  const code = 'const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");'
    + 'const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore",1,2]});'
    + 'writeFileSync(process.argv[1],String(child.pid));setInterval(()=>{},1000)'
  await assert.rejects(runBounded(process.execPath, ['-e', code, pidFile], { ...opts, timeoutMs: 800 }), { code: 'timeout' })
  const pid = Number(await readFile(pidFile, 'utf8'))
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('absent or modified pinned binary cannot become a successful CLI check', async t => {
  const opts = await scratch(t)
  const { inspectOcrDelegate } = await import('../scripts/r0/ocr-delegate.mjs')
  const absent = await inspectOcrDelegate(join(opts.cwd, 'absent.exe'))
  assert.equal(absent.status, 'unavailable')
  assert.equal(absent.modes.length, 0)
  await writeFile(join(opts.cwd, 'fake.exe'), 'not a verified executable')
  const wrong = await inspectOcrDelegate(join(opts.cwd, 'fake.exe'))
  assert.equal(wrong.status, process.platform === 'win32' && process.arch === 'x64' ? 'failed' : 'unavailable')
  assert.equal(wrong.modes.length, 0)
})

test('synthetic Git fixture has complete independent added/deleted/renamed/test coverage', async t => {
  const opts = await scratch(t)
  const { createFixture, gitChanges } = await import('../scripts/r0/ocr-fixture.mjs')
  const fixture = await createFixture(opts.cwd)
  const changes = await gitChanges(fixture, { mode: 'workspace' })
  assert.equal(changes.files.get('src/added.ts'), 'added')
  assert.equal(changes.files.get('src/untracked.ts'), 'added')
  assert.equal(changes.files.get('src/gone.ts'), 'deleted')
  assert.equal(changes.files.get('src/renamed.ts'), 'renamed')
  assert.equal(changes.renameSources['src/renamed.ts'], 'src/original.ts')
  assert.equal(changes.files.get('test/greet.test.ts'), 'modified')
  assert.equal(changes.files.size, 7)
  assert.match(await readFile(join(fixture.repository, 'src/greet.ts'), 'utf8'), /new/)
})

test('pinned real OCR Delegate covers three modes and reports actual errors', {
  skip: !process.env.ITEROOM_OCR_BIN && 'Set ITEROOM_OCR_BIN to the verified official v1.12.9 Windows x64 executable; mocks cannot complete Gate B.',
}, async () => {
  const { inspectOcrDelegate } = await import('../scripts/r0/ocr-delegate.mjs')
  const report = await inspectOcrDelegate(process.env.ITEROOM_OCR_BIN)
  assert.equal(report.status, 'passed')
  assert.equal(report.evidenceKind, 'actual-cli-synthetic-git')
  assert.equal(report.modes.length, 3)
  assert.ok(report.modes.every(x => x.default.totalFiles === 7 && x.testsIncluded && x.rulesComplete))
  assert.ok(report.negativeCases.every(x => x.rejected))
  assert.equal(report.gateB, 'not_completed')
})
