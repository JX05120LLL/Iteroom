import { lstat, realpath, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './ocr-fixture.mjs'
import { readRegular } from './review-files.mjs'
import { failure } from './ocr-process.mjs'

// This intentionally narrow R0 profile rejects attributes/configuration that
// could transform input bytes or invoke repository supplied programs.
export async function assertPlainGit(fixture) {
  const root = join(fixture.repository, '.git')
  for (const path of ['objects', 'objects/info', 'objects/pack', 'refs']) {
    const absolute = join(root, path), info = await lstat(absolute)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(absolute) !== absolute) throw failure('external_git_storage')
  }
  let metadataEntries = 0
  const checkStorage = async absolute => {
    for (const name of await readdir(absolute)) {
      if (++metadataEntries > 2000) throw failure('input_limit')
      const path = join(absolute, name), info = await lstat(path)
      if (info.isSymbolicLink() || await realpath(path) !== path || (info.isFile() && info.nlink !== 1)) throw failure('external_git_storage')
      if (info.isDirectory()) await checkStorage(path)
      else if (!info.isFile()) throw failure('external_git_storage')
    }
  }
  await checkStorage(join(root, 'objects')); await checkStorage(join(root, 'refs'))
  for (const path of ['HEAD', 'index', 'packed-refs']) await readRegular(root, path, 1024 * 1024)
  for (const path of ['objects/info/alternates', 'objects/info/http-alternates', 'commondir', 'shallow', 'info/grafts']) {
    if (await readRegular(root, path, 65536) !== null) throw failure('external_git_storage')
  }
  try { await lstat(join(root, 'refs/replace')); throw failure('external_git_storage') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  // Check the file itself before asking Git to parse it. --no-includes prevents
  // even configuration reads from following include/includeIf directives.
  if (!await readRegular(root, 'config', 65536)) throw failure('unsupported_git_config')
  const config = await git(fixture, ['config', '--local', '--no-includes', '--null', '--list'])
  const allowed = new Set(['core.repositoryformatversion', 'core.filemode', 'core.bare',
    'core.logallrefupdates', 'core.symlinks', 'core.ignorecase'])
  for (const row of config.split('\0').filter(Boolean)) {
    const [key, ...value] = row.split('\n')
    if (!allowed.has(key) || (key === 'core.bare' && value.join('\n') !== 'false')
      || (key === 'core.repositoryformatversion' && value.join('\n') !== '0')) throw failure('unsupported_git_config')
  }
  if (await readRegular(root, 'info/attributes', 65536) !== null) throw failure('unsupported_git_attributes')
}

export function rejectAttributePath(path) {
  if (path.split('/').some(part => part.toLowerCase() === '.gitattributes')) throw failure('unsupported_git_attributes')
}
