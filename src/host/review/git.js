import { join } from 'node:path'
import { runBounded, failure } from './ocr-process.js'

export async function git(fixture, args, options = {}) {
  const result = await runBounded('git', ['--literal-pathspecs', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=false',
    '-c', 'core.fsmonitor=false', '-c', `core.attributesFile=${join(fixture.home, 'empty-attributes')}`,
    '-c', `core.hooksPath=${join(fixture.home, 'hooks')}`, '-c', 'commit.gpgSign=false',
    '-c', 'user.name=Iteroom Synthetic', '-c', 'user.email=synthetic@example.invalid', ...args], { ...fixture.options, ...options })
  if (result.stderr && !args.includes('init')) throw failure('git_diagnostics')
  return result.stdout
}
