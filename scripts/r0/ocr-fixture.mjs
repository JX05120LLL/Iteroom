import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { controlledEnv, runBounded, failure } from './ocr-process.mjs'
import { validatePath } from './ocr-contract.mjs'

export async function git(fixture, args, options = {}) {
  const result = await runBounded('git', ['--literal-pathspecs', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false',
    '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${join(fixture.home, 'empty-attributes')}`,
    '-c', `core.hooksPath=${join(fixture.home, 'hooks')}`, '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Iteroom Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], { ...fixture.options, ...options })
  if (result.stderr && !args.includes('init')) throw failure('git_diagnostics')
  return result.stdout
}

export async function createFixture(scratch) {
  const repository = join(scratch, 'repository'), home = join(scratch, 'home')
  await mkdir(repository); await mkdir(home, { recursive: true }); await mkdir(join(home, 'hooks'))
  const fixture = { repository, home, options: { cwd: repository, env: controlledEnv(home), timeoutMs: 10000, maxOutputBytes: 1024 * 1024 } }
  await git(fixture, ['init', '--quiet'])
  const put = async (path, value) => {
    const parts = path.split('/'); parts.pop()
    await mkdir(join(repository, ...parts), { recursive: true })
    await writeFile(join(repository, path), value)
  }
  await put('src/greet.ts', 'export const greeting = "old"\n')
  await put('src/gone.ts', 'export const obsolete = true\n')
  await put('src/original.ts', Array.from({ length: 20 }, (_, n) => `export const item${n} = ${n}\n`).join(''))
  await put('test/greet.test.ts', 'export const testInput = "old"\n')
  await put('vendor/lib.ts', 'export const dependency = "old"\n')
  await git(fixture, ['add', '--all']); await git(fixture, ['commit', '--quiet', '-m', 'synthetic baseline'])
  fixture.base = (await git(fixture, ['rev-parse', 'HEAD'])).trim()
  await git(fixture, ['commit', '--quiet', '--allow-empty', '-m', 'synthetic checkpoint'])
  await put('src/greet.ts', 'export const greeting = "new"\n')
  await unlink(join(repository, 'src/gone.ts'))
  await rename(join(repository, 'src/original.ts'), join(repository, 'src/renamed.ts'))
  await put('src/added.ts', 'export const added = true\n')
  await put('test/greet.test.ts', 'export const testInput = "new"\n')
  await put('vendor/lib.ts', 'export const dependency = "new"\n')
  await git(fixture, ['add', '--all'])
  await put('src/untracked.ts', 'export const loose = true\n')
  await writeFile(join(scratch, 'include-tests.json'), JSON.stringify({ include: ['test/**/*.ts'] }))
  await writeFile(join(scratch, 'invalid-rule.json'), '{invalid')
  return fixture
}

export async function gitChanges(fixture, input) {
  let refs
  if (input.mode === 'workspace') refs = ['HEAD']
  else if (input.mode === 'commit') refs = [`${input.commit}^`, input.commit]
  else if (input.mode === 'range') refs = [input.mergeBase, input.to]
  else throw failure('invalid_mode')
  const raw = await git(fixture, ['diff', '--name-status', '-z', '--find-renames', ...refs, '--'])
  const parts = raw.split('\0'); if (parts.pop() !== '') throw failure('invalid_git_output')
  const files = new Map(), renameSources = {}
  for (let n = 0; n < parts.length;) {
    const status = parts[n++], old = parts[n++], path = status?.startsWith('R') ? parts[n++] : old
    validatePath(path)
    const value = ({ A: 'added', M: 'modified', D: 'deleted', R: 'renamed' })[status?.[0]]
    if (!value || files.has(path)) throw failure('invalid_git_output')
    files.set(path, value)
    if (value === 'renamed') { validatePath(old); renameSources[path] = old }
  }
  if (input.mode === 'workspace') {
    const rawLoose = await git(fixture, ['ls-files', '--others', '--exclude-standard', '-z'])
    for (const path of rawLoose.split('\0').filter(Boolean)) {
      validatePath(path)
      if (files.has(path)) throw failure('invalid_git_output')
      files.set(path, 'added')
    }
  }
  return { files, renameSources }
}
