import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { failure, runBounded } from './ocr-process.mjs'
import { modeArgs, parsePreview, parseRules } from './ocr-contract.mjs'
import { createFixture, git, gitChanges } from './ocr-fixture.mjs'

export const OCR_PIN = Object.freeze({ version: 'v1.12.9', sourceCommit: 'bccbc15f785269400735d5255540c231e6c02b6d',
  asset: 'opencodereview-windows-amd64.exe', sha256: 'ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1',
  source: 'https://github.com/alibaba/open-code-review/releases/tag/v1.12.9' })
const digest = x => createHash('sha256').update(x).digest('hex')
export async function verifyExecutable(executable) {
  if (!executable || !isAbsolute(executable)) throw failure('cli_unavailable')
  if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('platform_unverified')
  const hash = createHash('sha256')
  try { for await (const bytes of createReadStream(executable)) hash.update(bytes) }
  catch { throw failure('cli_unavailable') }
  if (hash.digest('hex') !== OCR_PIN.sha256) throw failure('binary_mismatch')
}
function requireFact(condition) { if (!condition) throw failure('probe_assertion') }
async function fingerprint(fixture) {
  const entries = (await git(fixture, ['ls-files', '-z'])).split('\0').filter(Boolean)
  entries.push(...(await git(fixture, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean))
  const result = []
  for (const path of entries.sort()) {
    try { result.push([path, digest(await readFile(join(fixture.repository, path)))]) }
    catch (error) { if (error.code !== 'ENOENT') throw failure('fixture_read'); result.push([path, 'absent']) }
  }
  return digest(JSON.stringify([result, await git(fixture, ['status', '--porcelain=v1', '-z']), await git(fixture, ['rev-parse', 'HEAD'])]))
}
function summary(p) {
  return { schemaVersion: p.schema_version, totalFiles: p.total_files, reviewableCount: p.reviewable_count,
    excludedCount: p.excluded_count, totalInsertions: p.total_insertions, totalDeletions: p.total_deletions,
    reviewable: p.reviewable_files, excluded: p.excluded_files }
}

export async function inspectOcrDelegate(executable) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), evidenceKind: 'actual-cli-synthetic-git',
    gateB: 'not_completed', environment: { platform: process.platform, arch: process.arch, node: process.version },
    pin: OCR_PIN, modelCalled: false, sandboxDeployed: false, userSourceRead: false,
    modes: [], negativeCases: [], unverified: ['product-snapshot-to-delegate-integration',
      'full-old-side-deletion-and-rename-diff-context', 'complex-branch-and-merge-inputs', 'linux-macos-arm64',
      'product-review-coverage-and-findings', 'real-model', 'actual-sandbox'] }
  try { await verifyExecutable(executable) } catch (error) {
    return { ...report, status: ['cli_unavailable', 'platform_unverified'].includes(error.code) ? 'unavailable' : 'failed', errorCode: error.code }
  }
  const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, 'iteroom-r0-ocr-'))
  try {
    const fixture = await createFixture(scratch)
    const invoke = async (args, options = {}) => {
      const result = await runBounded(executable, args, { ...fixture.options, ...options })
      if (result.stderr.trim()) throw failure('cli_diagnostics')
      return result.stdout
    }
    const version = await invoke(['--version'])
    requireFact(version.split('\n')[0].trim() === 'open-code-review v1.12.9 (bccbc15f) windows/amd64')
    report.versionConfirmed = true
    report.gitVersion = (await git(fixture, ['--version'])).trim()
    const help = await invoke(['delegate', 'preview', '--help'])
    requireFact(['--repo', '--commit', '--from', '--to', '--format', '--rule'].every(flag => help.includes(flag)))
    report.flagsConfirmed = true
    const checkMode = async input => {
      const before = await fingerprint(fixture)
      const changes = await gitChanges(fixture, input)
      const context = { ...input, repository: fixture.repository, files: changes.files }
      const args = ['--repo', fixture.repository, '--format', 'json', '--max-git-procs', '2', ...modeArgs(input)]
      const p = parsePreview(await invoke(['delegate', 'preview', ...args]), context)
      const include = parsePreview(await invoke(['delegate', 'preview', ...args, '--rule', join(scratch, 'include-tests.json')]), context)
      const reasons = Object.fromEntries(p.excluded_files.map(x => [x.path, x.exclude_reason]))
      requireFact(reasons['src/gone.ts'] === 'deleted' && reasons['test/greet.test.ts'] === 'default_path'
        && reasons['vendor/lib.ts'] === 'provider_directory' && p.reviewable_count === 4 && p.total_files === 7)
      requireFact(include.reviewable_count === 5 && include.reviewable_files.some(x => x.path === 'test/greet.test.ts'))
      const paths = include.reviewable_files.map(x => x.path)
      const rules = parseRules(await invoke(['delegate', 'rule', ...args, '--rule', join(scratch, 'include-tests.json'), '--', ...paths]), paths)
      requireFact(await fingerprint(fixture) === before)
      report.modes.push({ mode: input.mode, schemaVersion: p.schema_version, gitCoverageMatches: true,
        repositoryUnchanged: true, renameSources: changes.renameSources, default: summary(p),
        withTestInclude: summary(include), testsIncluded: true, rulesComplete: true,
        rules: rules.groups.map(g => ({ groupId: g.group_id, source: g.source, pattern: g.pattern,
          files: g.files, ruleBytes: Buffer.byteLength(g.rule), ruleSha256: digest(g.rule) })) })
    }
    await checkMode({ mode: 'workspace' })
    await git(fixture, ['add', '--all']); await git(fixture, ['commit', '--quiet', '-m', 'synthetic changes'])
    const commit = (await git(fixture, ['rev-parse', 'HEAD'])).trim()
    await checkMode({ mode: 'commit', commit })
    await git(fixture, ['commit', '--quiet', '--allow-empty', '-m', 'synthetic range endpoint'])
    const to = (await git(fixture, ['rev-parse', 'HEAD'])).trim()
    const mergeBase = (await git(fixture, ['merge-base', fixture.base, to])).trim()
    await checkMode({ mode: 'range', from: fixture.base, to, mergeBase })
    const beforeErrors = await fingerprint(fixture)
    for (const [name, args] of [
      ['invalid-rule-json', ['rule', '--rule', join(scratch, 'invalid-rule.json'), '--', 'src/greet.ts']],
      ['missing-rule', ['rule', '--rule', join(scratch, 'missing-rule.json'), '--', 'src/greet.ts']],
      ['invalid-ref', ['preview', '--commit', 'f'.repeat(40)]],
      ['incomplete-range', ['preview', '--from', fixture.base]],
      ['invalid-format', ['preview', '--format', 'sarif']],
    ]) {
      try { await invoke(['delegate', ...args]); throw failure('unexpected_cli_success') }
      catch (error) {
        if (error.code !== 'process_failed' || !Number.isInteger(error.exitCode) || error.exitCode === 0) throw error
        report.negativeCases.push({ name, rejected: true, errorCode: error.code, exitCode: error.exitCode })
      }
    }
    requireFact(await fingerprint(fixture) === beforeErrors)
    report.status = 'passed'
    report.syntheticRepositoryRemoved = true // Return only after finally succeeds.
    return report
  } catch (error) { return { ...report, status: 'failed', errorCode: error.code ?? 'probe_failed' } }
  finally {
    if (dirname(resolve(scratch)) !== parent || !scratch.startsWith(join(parent, 'iteroom-r0-ocr-'))) throw failure('cleanup_refused')
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectOcrDelegate(process.env.ITEROOM_OCR_BIN)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch { process.stderr.write('R0 OCR probe failed; no CLI stderr or private paths emitted.\n'); process.exitCode = 1 }
}
