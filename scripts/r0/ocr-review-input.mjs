import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OCR_PIN, verifyExecutable } from './ocr-delegate.mjs'
import { createFixture, git } from './ocr-fixture.mjs'
import { failure, runBounded } from './ocr-process.mjs'
import { modeArgs, parsePreview, parseRules } from './ocr-contract.mjs'
import { captureReviewInput, summarizeInput } from './review-input.mjs'
import { sha256 } from './review-files.mjs'

function requireFact(value) { if (!value) throw failure('probe_assertion') }
async function commit(fixture, message = 'synthetic review input') {
  await git(fixture, ['add', '--all']); await git(fixture, ['commit', '--quiet', '-m', message])
  return (await git(fixture, ['rev-parse', 'HEAD'])).trim()
}

export async function inspectReviewInputs(executable) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), evidenceKind: 'actual-cli-and-git-inputs',
    gateB: 'not_completed', pin: OCR_PIN, environment: { platform: process.platform, node: process.version },
    actualCli: false, modelCalled: false, sandboxDeployed: false, userSourceRead: false,
    scenarios: [], boundaries: [], unverified: ['atomic-product-snapshot-and-delegate-integration',
      'unborn-workspace-and-git-attribute-filters', 'finding-inference-and-location', 'cross-platform-distribution',
      'real-model', 'actual-sandbox'] }
  try { await verifyExecutable(executable) } catch (error) {
    return { ...report, status: ['cli_unavailable', 'platform_unverified'].includes(error.code) ? 'unavailable' : 'failed', errorCode: error.code }
  }
  const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, 'iteroom-r0-review-input-'))
  try {
    const fixture = await createFixture(scratch)
    let cliCalls = 0
    const invoke = async args => {
      cliCalls++
      const result = await runBounded(executable, args, fixture.options)
      if (result.stderr.trim()) throw failure('cli_diagnostics')
      return result.stdout
    }
    const version = await invoke(['--version'])
    requireFact(version.split('\n')[0].trim() === 'open-code-review v1.12.9 (bccbc15f) windows/amd64')
    report.actualCli = true; report.gitVersion = (await git(fixture, ['--version'])).trim()
    const check = async (name, input) => {
      const record = await captureReviewInput(fixture, input)
      const files = new Map(record.entries.map(x => [x.new?.path ?? x.old.path, x.kind === 'binary' ? 'binary' : x.status]))
      const context = { ...input, repository: fixture.repository, files, mergeBase: record.mergeBase }
      const args = ['--repo', fixture.repository, '--format', 'json', '--max-git-procs', '2', ...modeArgs(input)]
      const preview = parsePreview(await invoke(['delegate', 'preview', ...args]), context)
      const includeArgs = [...args, '--rule', join(scratch, 'include-tests.json')]
      const include = parsePreview(await invoke(['delegate', 'preview', ...includeArgs]), context)
      const excluded = new Map(include.excluded_files.map(x => [x.path, x.exclude_reason]))
      const paths = include.reviewable_files.map(x => x.path)
      const coverage = record.entries.map(entry => {
        const path = entry.new?.path ?? entry.old.path, reason = excluded.get(path)
        if (entry.status === 'deleted' && entry.kind === 'text' && reason === 'deleted') {
          requireFact(entry.old.content !== null)
          paths.push(path)
          return { path, side: 'old', source: 'iteroom-deletion-context', status: 'pending_inference', ocrExcludeReason: reason }
        }
        return { path, side: entry.new ? 'new' : 'old', source: 'ocr-delegate',
          status: reason ? 'excluded' : 'pending_inference', ...(reason ? { ocrExcludeReason: reason } : {}) }
      })
      const rules = paths.length ? parseRules(await invoke(['delegate', 'rule', ...includeArgs, '--', ...paths]), paths) : null
      for (const entry of record.entries) {
        const path = entry.new?.path ?? entry.old.path
        if (/\.test\.ts$/.test(path)) requireFact(include.reviewable_files.some(x => x.path === path))
        if (entry.kind === 'binary') requireFact(coverage.find(x => x.path === path).status === 'excluded')
      }
      const after = await captureReviewInput(fixture, input)
      requireFact(after.inputSha256 === record.inputSha256)
      const result = { name, coverageMatches: true, inputUnchanged: true, input: summarizeInput(record),
        ocr: { schemaVersion: preview.schema_version, defaultReviewable: preview.reviewable_count,
          defaultExcluded: preview.excluded_count, withTestsReviewable: include.reviewable_count, withTestsExcluded: include.excluded_count },
        coverage, rulesSkippedForEmptyInput: !paths.length,
        rules: rules?.groups.map(g => ({ groupId: g.group_id, source: g.source, pattern: g.pattern,
          files: g.files, ruleSha256: sha256(g.rule) })) ?? [] }
      report.scenarios.push(result)
      return record
    }
    await check('workspace', { mode: 'workspace' })
    const target = await commit(fixture)
    await check('commit', { mode: 'commit', commit: target })
    await git(fixture, ['checkout', '--quiet', '-b', 'synthetic-source', fixture.base])
    await writeFile(join(fixture.repository, 'src/source-only.ts'), 'export const fromOnly = true\n')
    const from = await commit(fixture, 'synthetic divergent source')
    const range = await check('divergent-range', { mode: 'range', from, to: target })
    requireFact(range.mergeBase === fixture.base && range.mergeBase !== from
      && !range.entries.some(x => (x.new?.path ?? x.old?.path) === 'src/source-only.ts'))
    await check('root-commit', { mode: 'commit', commit: fixture.base })
    await git(fixture, ['checkout', '--quiet', '--detach', target])
    await git(fixture, ['merge', '--quiet', '--no-ff', '-m', 'synthetic merge', from])
    const merge = (await git(fixture, ['rev-parse', 'HEAD'])).trim()
    const merged = await check('merge-commit', { mode: 'commit', commit: merge })
    requireFact(merged.resolvedBase === target && merged.entries.length === 1)
    await check('empty-workspace', { mode: 'workspace' })
    await git(fixture, ['commit', '--quiet', '--allow-empty', '-m', 'synthetic empty'])
    await check('empty-commit', { mode: 'commit', commit: (await git(fixture, ['rev-parse', 'HEAD'])).trim() })
    await writeFile(join(fixture.repository, 'src/binary.ts'), Buffer.from([0, 255, 128, 13, 10, 0]))
    await writeFile(join(fixture.repository, 'src/中文 [1].ts'), 'export const unicode = "你好"\n')
    await check('binary-and-unicode', { mode: 'workspace' })
    const boundary = async (name, action, expectedCode) => {
      const callsBefore = cliCalls
      try { await action(); throw failure('unexpected_boundary_success') }
      catch (error) {
        if (error.code !== expectedCode) throw error
        requireFact(cliCalls === callsBefore)
        report.boundaries.push({ name, errorCode: error.code, rejectedBeforeDelegate: true })
      }
    }
    await boundary('actual-project-refused', () => captureReviewInput({ ...fixture, repository: process.cwd() }, { mode: 'workspace' }), 'unmanaged_repository')
    await writeFile(join(fixture.repository, 'src/large.ts'), 'a'.repeat(300000))
    await boundary('oversized-input', () => captureReviewInput(fixture, { mode: 'workspace' }), 'input_limit')
    await unlink(join(fixture.repository, 'src/large.ts'))
    const pointer = join(scratch, 'synthetic-pointer')
    await writeFile(pointer, 'synthetic pointer text, not target content')
    const oid = (await git(fixture, ['hash-object', '-w', '--', pointer])).trim()
    await git(fixture, ['update-index', '--add', '--cacheinfo', '120000', oid, 'src/link.ts'])
    await boundary('staged-symlink', () => captureReviewInput(fixture, { mode: 'workspace' }), 'unsupported_git_mode')
    const tree = (await git(fixture, ['rev-parse', `${fixture.base}^{tree}`])).trim()
    const makeCommit = async (message, parents) => (await git(fixture, ['commit-tree', tree,
      ...parents.flatMap(p => ['-p', p]), '-m', message])).trim()
    const left = await makeCommit('synthetic left', [fixture.base]), right = await makeCommit('synthetic right', [fixture.base])
    const topLeft = await makeCommit('synthetic top left', [left, right]), topRight = await makeCommit('synthetic top right', [right, left])
    await boundary('multiple-merge-bases', () => captureReviewInput(fixture, { mode: 'range', from: topLeft, to: topRight }), 'ambiguous_merge_base')
    const unrelated = await makeCommit('synthetic unrelated', [])
    await boundary('unrelated-history', () => captureReviewInput(fixture, { mode: 'range', from: fixture.base, to: unrelated }), 'unrelated_history')
    return { ...report, status: 'passed', cliCalls, syntheticRepositoryRemoved: true }
  } catch (error) { return { ...report, status: 'failed', errorCode: error.code ?? 'probe_failed' } }
  finally {
    if (dirname(resolve(scratch)) !== parent || !scratch.startsWith(join(parent, 'iteroom-r0-review-input-'))) throw failure('cleanup_refused')
    await rm(scratch, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectReviewInputs(process.env.ITEROOM_OCR_BIN)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch { process.stderr.write('R0 review input probe failed; private paths and content withheld.\n'); process.exitCode = 1 }
}
