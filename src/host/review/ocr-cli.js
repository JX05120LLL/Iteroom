import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { failure } from './ocr-process.js'

export const OCR_PIN = Object.freeze({ version: 'v1.12.9', sourceCommit: 'bccbc15f785269400735d5255540c231e6c02b6d',
  asset: 'opencodereview-windows-amd64.exe', sha256: 'ae6f4785fea34a5cfef93ad22d8e7fb8032bbd12c45f2cbcc98cbe1b38cceff1',
  source: 'https://github.com/alibaba/open-code-review/releases/tag/v1.12.9' })

export async function verifyExecutable(executable) {
  if (!executable || !isAbsolute(executable)) throw failure('cli_unavailable')
  if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('platform_unverified')
  const hash = createHash('sha256')
  try {
    const info = await lstat(executable)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024 * 1024) throw failure('cli_unavailable')
    for await (const bytes of createReadStream(executable)) hash.update(bytes)
  } catch { throw failure('cli_unavailable') }
  if (hash.digest('hex') !== OCR_PIN.sha256) throw failure('binary_mismatch')
}
