import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OCR_PIN, verifyExecutable } from './ocr-delegate.mjs'
import { createFixture, git } from './ocr-fixture.mjs'
import { createFixedReviewCopy } from './fixed-review-copy.mjs'
import { captureReviewInput, summarizeInput } from './review-input.mjs'
import { modeArgs, parsePreview, parseRules } from './ocr-contract.mjs'
import { controlledEnv, runBounded, failure } from './ocr-process.mjs'
import { sha256 } from './review-files.mjs'

function requireFact(value) { if (!value) throw failure('probe_assertion') }
export async function inspectFixedReviewInputs(executable) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), pin: OCR_PIN,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    evidenceKind: 'actual-cli-independent-git-copies', actualCli: false,
    modelCalled: false, sandboxDeployed: false, userSourceRead: false, gateB: 'not_completed',
    scenarios: [], boundaries: [], unverified: ['atomic-capture-of-adversarial-user-repository',
      'product-review-integration-and-findings', 'real-model', 'actual-sandbox', 'other-platforms-and-distribution'] }
  try { await verifyExecutable(executable) } catch (error) {
    return { ...report, status: ['cli_unavailable', 'platform_unverified'].includes(error.code) ? 'unavailable' : 'failed', errorCode: error.code }
  }
  const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, 'iteroom-r0-fixed-probe-'))
  let cliCalls = 0
  try {
    const f = await createFixture(scratch)
    const invoke = async (fixture, args) => {
      cliCalls++
      const result = await runBounded(executable, args, fixture.options)
      if (result.stderr.trim()) throw failure('cli_diagnostics')
      return result.stdout
    }
    requireFact((await invoke(f, ['--version'])).split('\n')[0].trim() === 'open-code-review v1.12.9 (bccbc15f) windows/amd64')
    report.actualCli = true
    const check = async (name, input) => {
      const fixed = await createFixedReviewCopy(f, input)
      const original = await readFile(join(f.repository, 'src/greet.ts'))
      try {
        await writeFile(join(f.repository, 'src/greet.ts'), 'later source change after fixed capture\n')
        const fixture = fixed.fixture, record = fixed.record
        const rulePath = join(fixture.home, 'include-tests.json')
        await writeFile(rulePath, JSON.stringify({ include: ['test/**/*.ts'] }))
        const files = new Map(record.entries.map(entry => [entry.new?.path ?? entry.old.path,
          entry.kind === 'binary' ? 'binary' : entry.status]))
        const context = { ...input, repository: fixture.repository, files, mergeBase: record.mergeBase }
        const args = ['--repo', fixture.repository, '--format', 'json', '--max-git-procs', '2', ...modeArgs(input)]
        await fixed.verify()
        const preview = parsePreview(await invoke(fixture, ['delegate', 'preview', ...args]), context)
        const includeArgs = [...args, '--rule', rulePath]
        const included = parsePreview(await invoke(fixture, ['delegate', 'preview', ...includeArgs]), context)
        const excluded = new Map(included.excluded_files.map(x => [x.path, x.exclude_reason]))
        const selected = included.reviewable_files.map(x => x.path)
        const coverage = record.entries.map(entry => {
          const path = entry.new?.path ?? entry.old.path, reason = excluded.get(path)
          if (entry.status === 'deleted' && entry.kind === 'text' && reason === 'deleted') {
            selected.push(path)
            return { path, side: 'old', source: 'iteroom-deletion-context', status: 'pending_inference', ocrExcludeReason: reason }
          }
          return { path, side: entry.new ? 'new' : 'old', source: 'ocr-delegate',
            status: reason ? 'excluded' : 'pending_inference', ...(reason ? { ocrExcludeReason: reason } : {}) }
        })
        const rules = selected.length ? parseRules(await invoke(fixture, ['delegate', 'rule', ...includeArgs, '--', ...selected]), selected) : null
        for (const entry of record.entries) {
          const path = entry.new?.path ?? entry.old.path
          if (/\.test\.ts$/.test(path)) requireFact(included.reviewable_files.some(x => x.path === path))
          if (entry.kind === 'binary') requireFact(excluded.get(path) === 'binary')
        }
        await fixed.verify()
        report.scenarios.push({ name, sourceChangedAfterCopy: true, copyVerifiedAfterDelegate: true,
          coverageMatches: true, input: summarizeInput(record),
          ocr: { schemaVersion: preview.schema_version, defaultReviewable: preview.reviewable_count,
            defaultExcluded: preview.excluded_count, withTestsReviewable: included.reviewable_count,
            withTestsExcluded: included.excluded_count }, coverage,
          rulesSkippedForEmptyInput: !selected.length,
          rules: rules?.groups.map(g => ({ groupId: g.group_id, source: g.source, pattern: g.pattern,
            files: g.files, ruleSha256: sha256(g.rule) })) ?? [] })
      } finally { await writeFile(join(f.repository, 'src/greet.ts'), original); await fixed.dispose() }
    }
    await check('workspace', { mode: 'workspace' })
    await git(f, ['add', '--all']); await git(f, ['commit', '--quiet', '-m', 'synthetic fixed-copy target'])
    const target = (await git(f, ['rev-parse', 'HEAD'])).trim()
    await check('commit', { mode: 'commit', commit: target })
    await check('range', { mode: 'range', from: f.base, to: target })
    await check('root-commit', { mode: 'commit', commit: f.base })
    await check('empty-workspace', { mode: 'workspace' })
    await writeFile(join(f.repository, 'src/bytes.ts'), '\uFEFFexport const bytes = true\r\n')
    await writeFile(join(f.repository, 'src/binary.ts'), Buffer.from([0, 255, 128, 13, 10]))
    await git(f, ['add', '--all']); await git(f, ['update-index', '--chmod=+x', 'src/bytes.ts'])
    await check('byte-and-mode', { mode: 'workspace' })
    const reject = async (name, action, code) => {
      const before = cliCalls
      try { await action(); throw failure('unexpected_boundary_success') }
      catch (error) { if (error.code !== code) throw error }
      requireFact(before === cliCalls)
      report.boundaries.push({ name, errorCode: code, rejectedBeforeDelegate: true })
    }
    await writeFile(join(f.repository, '.gitattributes'), '*.ts text eol=lf\n')
    await reject('attributes', () => createFixedReviewCopy(f, { mode: 'workspace' }), 'unsupported_git_attributes')
    await git(f, ['config', 'filter.synthetic.clean', 'synthetic-filter-command-never-invoked'])
    await reject('filter-config', () => createFixedReviewCopy(f, { mode: 'workspace' }), 'unsupported_git_config')
    const unbornScratch = await mkdtemp(join(parent, 'iteroom-r0-fixed-unborn-'))
    try {
      const repository = join(unbornScratch, 'repository'), home = join(unbornScratch, 'home')
      await mkdir(repository); await mkdir(join(home, 'hooks'), { recursive: true })
      const unborn = { repository, home, options: { cwd: repository, env: controlledEnv(home) } }
      await git(unborn, ['init', '--quiet']); await writeFile(join(repository, 'new.ts'), 'export const fresh = true\n')
      await git(unborn, ['add', 'new.ts']); await writeFile(join(repository, 'loose.ts'), 'export const loose = true\n')
      const fixed = await createFixedReviewCopy(unborn, { mode: 'workspace' })
      try {
        await writeFile(join(repository, 'new.ts'), 'later source change\n')
        const record = fixed.record, context = { mode: 'workspace', repository: fixed.fixture.repository,
          files: new Map(record.entries.map(x => [x.new.path, 'added'])) }
        const args = ['--repo', fixed.fixture.repository, '--format', 'json']
        const preview = parsePreview(await invoke(fixed.fixture, ['delegate', 'preview', ...args]), context)
        const paths = preview.reviewable_files.map(x => x.path)
        const rules = parseRules(await invoke(fixed.fixture, ['delegate', 'rule', ...args, '--', ...paths]), paths)
        await fixed.verify(); requireFact(preview.total_files === 2 && rules.groups.flatMap(x => x.files).length === 2)
        report.unborn = { supported: true, actualCliExitCode: 0, sourceChangedAfterCopy: true,
          copyVerifiedAfterDelegate: true, input: summarizeInput(record),
          coverage: paths.map(path => ({ path, status: 'pending_inference' })) }
        await reject('unborn-unstaged-divergence', () => captureReviewInput(unborn, { mode: 'workspace' }), 'unborn_unstaged_input')
      } finally { await fixed.dispose() }
    } finally {
      if (dirname(unbornScratch) !== parent || !unbornScratch.startsWith(join(parent, 'iteroom-r0-fixed-unborn-'))) throw failure('cleanup_refused')
      await rm(unbornScratch, { recursive: true, force: true })
    }
    return { ...report, status: 'passed', gateB: 'passed', cliCalls, syntheticRepositoriesRemoved: true }
  } catch (error) { return { ...report, status: 'failed', errorCode: error.code ?? 'probe_failed', cliCalls } }
  finally {
    if (dirname(scratch) !== parent || !scratch.startsWith(join(parent, 'iteroom-r0-fixed-probe-'))) throw failure('cleanup_refused')
    await rm(scratch, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectFixedReviewInputs(process.env.ITEROOM_OCR_BIN)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch { process.stderr.write('R0 fixed-input probe failed; paths and source withheld.\n'); process.exitCode = 1 }
}
