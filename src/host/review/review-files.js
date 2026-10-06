import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, basename, resolve, join, relative, isAbsolute, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { failure } from './ocr-process.js'
import { validatePath } from './ocr-contract.js'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const blobOid = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
export function text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw failure('unsupported_encoding') }
}
export async function assertManaged(fixture) {
  const root = resolve(fixture.repository), scratch = dirname(root), parent = await realpath(tmpdir())
  if (fixture.productRoot !== undefined) {
    const offset = relative(root, resolve(fixture.home))
    if (resolve(fixture.productRoot) !== root || !isAbsolute(fixture.home) || fixture.options.cwd !== root
      || !(offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))) throw failure('unmanaged_repository')
    for (const path of [root, join(root, '.git'), fixture.home]) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw failure('unmanaged_repository')
    }
    return
  }
  if (basename(root) !== 'repository' || dirname(scratch) !== parent || !basename(scratch).startsWith('iteroom-r0-')
    || resolve(fixture.home) !== join(scratch, 'home') || fixture.options.cwd !== root) throw failure('unmanaged_repository')
  for (const path of [scratch, root, join(root, '.git'), fixture.home]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw failure('unmanaged_repository')
  }
}
export async function readRegular(root, path, maxBytes) {
  validatePath(path)
  const parts = path.split('/'); let cursor = root
  for (const part of parts) {
    cursor = join(cursor, part)
    let info
    try { info = await lstat(cursor) } catch (error) {
      if (error.code === 'ENOENT') return null
      throw failure('unsafe_file')
    }
    if (info.isSymbolicLink() || (cursor !== join(root, path) && !info.isDirectory())) throw failure('unsafe_file')
  }
  const info = await lstat(cursor)
  if (!info.isFile() || info.nlink !== 1) throw failure('unsafe_file')
  if (info.size > maxBytes) throw failure('input_limit')
  const real = await realpath(cursor), rel = relative(root, real)
  if (rel.startsWith('..') || isAbsolute(rel)) throw failure('unsafe_file')
  const handle = await open(cursor, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size) throw failure('input_changed')
    const bytes = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    const after = await handle.stat()
    if (size > maxBytes) throw failure('input_limit')
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || await realpath(cursor) !== real) throw failure('input_changed')
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}
export function side(path, mode, bytes, oid = blobOid(bytes)) {
  const binary = bytes.subarray(0, 8000).includes(0)
  return Object.freeze({ path, mode, blobOid: oid, bytes: bytes.length, contentSha256: sha256(bytes),
    content: binary ? null : text(bytes), binary })
}
