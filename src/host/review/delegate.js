import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { OCR_PIN, verifyExecutable } from './ocr-cli.js'
import { modeArgs, parsePreview, parseRules } from './ocr-contract.js'
import { runBounded, failure } from './ocr-process.js'
import { sha256 } from './review-files.js'
import { git } from './git.js'

// Pinned Delegate omits untracked files under these top-level provider directories.
// Iteroom keeps their paths in its own coverage record rather than inventing CLI entries.
// Contract source: bccbc15f internal/diff/git.go (Apache-2.0).
const PROVIDER_DIRECTORIES = new Set(['.idea', '.vscode', '.svn', '.git', 'vendor', 'node_modules',
  'target', '.happypack', '.cachefile', '_packages', 'rpm', 'pkgs'])

export function sensitiveReviewPath(path) {
  return path.split('/').some(part => /^(?:\.ssh|\.aws|\.azure|\.kube|\.env(?:\..*)?|\.npmrc|\.pypirc|\.git-credentials|secrets?(?:\..*)?|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$/i.test(part)
    || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(part))
}

export async function prepareReviewDelegate({ executable, copy }) {
  await verifyExecutable(executable)
  const fixture = copy.fixture, record = copy.record
  const invoke = async args => {
    const result = await runBounded(executable, args, fixture.options)
    if (result.stderr.trim()) throw failure('cli_diagnostics')
    return result.stdout
  }
  const version = await invoke(['--version'])
  if (version.split('\n')[0].trim() !== 'open-code-review v1.12.9 (bccbc15f) windows/amd64') throw failure('binary_mismatch')
  const files = new Map(record.entries.map(entry => [entry.new?.path ?? entry.old.path,
    entry.kind === 'binary' ? 'binary' : entry.status]))
  const omittedProvider = new Set()
  if (record.mode === 'workspace') {
    const tracked = new Set((await git(fixture, ['ls-files', '--cached', '-z'])).split('\0').filter(Boolean))
    for (const path of files.keys()) {
      if (path.includes('/') && PROVIDER_DIRECTORIES.has(path.split('/')[0]) && !tracked.has(path)) {
        files.delete(path); omittedProvider.add(path)
      }
    }
  }
  const context = { ...record.selection, repository: fixture.repository, files, mergeBase: record.mergeBase }
  const args = ['--repo', fixture.repository, '--format', 'json', '--max-git-procs', '2', ...modeArgs(record.selection)]
  await copy.verify()
  const preview = parsePreview(await invoke(['delegate', 'preview', ...args]), context)
  const rulePath = join(fixture.home, 'iteroom-review-include.json')
  // Include only test source patterns; provider and secret exclusions remain visible.
  await writeFile(rulePath, JSON.stringify({ include: ['test/**/*.{ts,tsx,js,mjs,cjs}', 'tests/**/*.{ts,tsx,js,mjs,cjs}',
    '**/*.test.{ts,tsx,js,mjs,cjs}', '**/*.spec.{ts,tsx,js,mjs,cjs}'] }), { flag: 'wx', mode: 0o600 })
  const includeArgs = [...args, '--rule', rulePath]
  const included = parsePreview(await invoke(['delegate', 'preview', ...includeArgs]), context)
  const defaultReasons = new Map(preview.excluded_files.map(item => [item.path, item.exclude_reason]))
  const reasons = new Map(included.excluded_files.map(item => [item.path, item.exclude_reason]))
  const coverage = record.entries.map(entry => {
    const path = entry.new?.path ?? entry.old.path
    const sensitive = [entry.old?.path, entry.new?.path].filter(Boolean).some(sensitiveReviewPath)
    const reason = sensitive ? 'secret_exclude' : omittedProvider.has(path) ? 'provider_directory' : reasons.get(path) ?? null
    const deleted = entry.status === 'deleted' && entry.kind === 'text' && reason === 'deleted'
    const testIncluded = !reason && defaultReasons.get(path) === 'default_path'
    return { path, status: !reason || deleted ? 'pending_inference' : 'excluded',
      side: entry.new ? 'new' : 'old', oldPath: entry.old?.path ?? null, newPath: entry.new?.path ?? null,
      ocrExcludeReason: reason ?? (testIncluded ? 'default_path' : null),
      includedBy: omittedProvider.has(path) ? 'iteroom-provider-exclusion'
        : deleted ? 'iteroom-deletion-context' : testIncluded ? 'iteroom-test-include' : 'ocr-delegate' }
  })
  const selected = coverage.filter(item => item.status === 'pending_inference').map(item => item.path)
  const rules = selected.length ? parseRules(await invoke(['delegate', 'rule', ...includeArgs, '--', ...selected]), selected) : null
  await copy.verify()
  return { version: OCR_PIN.version, sourceCommit: OCR_PIN.sourceCommit, executableSha256: OCR_PIN.sha256,
    schemaVersion: '1', actualCli: true, coverage,
    groups: rules?.groups.map(group => ({ groupId: group.group_id, source: group.source,
      pattern: group.pattern, rule: group.rule, sha256: sha256(group.rule), files: group.files })) ?? [] }
}
