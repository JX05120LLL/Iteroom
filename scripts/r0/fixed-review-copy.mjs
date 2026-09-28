import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { captureReviewInput, captureWorkspaceState } from './review-input.mjs'
import { assertManaged } from './review-files.mjs'
import { assertPlainGit } from './review-git-boundary.mjs'
import { git } from './ocr-fixture.mjs'
import { controlledEnv, failure } from './ocr-process.mjs'

export async function createFixedReviewCopy(source, input) {
  await assertManaged(source)
  source = { ...source, options: { cwd: source.repository, env: controlledEnv(source.home),
    timeoutMs: 10000, maxOutputBytes: 1024 * 1024 } }
  const record = await captureReviewInput(source, input)
  const workspace = input.mode === 'workspace' && await captureWorkspaceState(source)
  const objectRows = (await git(source, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'])).trim().split('\n').filter(Boolean)
  if (objectRows.length > 1000) throw failure('input_limit')
  let objectBytes = 0
  const objects = []
  for (const row of objectRows) {
    const match = /^([0-9a-f]{40}) (blob|tree|commit|tag) ([0-9]+)$/.exec(row)
    if (!match) throw failure('invalid_git_output')
    const [, oid, type, size] = match
    objectBytes += Number(size)
    if (Number(size) > 1024 * 1024 || objectBytes > 16 * 1024 * 1024) throw failure('input_limit')
    const bytes = await git(source, ['cat-file', type, oid], { encoding: 'buffer' })
    const raw = Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])
    if (bytes.length !== Number(size) || createHash('sha1').update(raw).digest('hex') !== oid) throw failure('input_changed')
    objects.push({ oid, compressed: deflateSync(raw) })
  }
  const parent = resolve(tmpdir()), scratch = await mkdtemp(join(parent, 'iteroom-r0-fixed-copy-'))
  const repository = join(scratch, 'repository'), home = join(scratch, 'home')
  const fixture = { repository, home, options: { cwd: repository, env: controlledEnv(home), timeoutMs: 10000, maxOutputBytes: 1024 * 1024 } }
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    if (dirname(scratch) !== parent || !scratch.startsWith(join(parent, 'iteroom-r0-fixed-copy-'))) throw failure('cleanup_refused')
    await rm(scratch, { recursive: true, force: true }); disposed = true
  }
  try {
    await mkdir(repository); await mkdir(join(home, 'hooks'), { recursive: true })
    await git(fixture, ['init', '--quiet', `--template=${join(home, 'hooks')}`])
    await git(fixture, ['config', 'core.filemode', process.platform === 'win32' ? 'false' : 'true'])
    for (const object of objects) {
      const directory = join(repository, '.git/objects', object.oid.slice(0, 2))
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, object.oid.slice(2)), object.compressed, { flag: 'wx' })
    }
    const head = (await git(source, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowedExitCodes: [0, 1] })).trim()
    if (head) await git(fixture, ['update-ref', 'HEAD', head])
    if (workspace) {
      for (const row of workspace.staged) {
        const [, mode, oid, path] = /^([0-9]{6}) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(row)
        await git(fixture, ['update-index', '--add', '--cacheinfo', mode, oid, path])
      }
      for (const [path, bytes] of workspace.files) {
        if (bytes === null) continue
        const absolute = join(repository, path)
        await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, bytes, { flag: 'wx' })
        if (process.platform !== 'win32' && workspace.staged.some(row => row.startsWith('100755 ') && row.endsWith(`\t${path}`))) await chmod(absolute, 0o755)
      }
    }
    await assertPlainGit(fixture)
    if ((await captureReviewInput(source, input)).inputSha256 !== record.inputSha256
      || (workspace && (await captureWorkspaceState(source)).fingerprint !== workspace.fingerprint)) throw failure('input_changed')
    const verify = async () => {
      if (disposed || (await captureReviewInput(fixture, input)).inputSha256 !== record.inputSha256) throw failure('input_changed')
    }
    await verify()
    return Object.freeze({ fixture, record, verify, dispose })
  } catch (error) { await dispose(); throw error }
}
