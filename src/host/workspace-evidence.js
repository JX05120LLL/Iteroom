import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, readFile, readlink, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_FILES = 20_000
const MAX_CAPTURED_FILE_BYTES = 1024 * 1024
const MAX_CAPTURED_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024
const MAX_HASHED_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_DIFF_BYTES = 256 * 1024
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let outputSize = 0
    let tooLarge = false
    const limit = options.maxOutputBytes ?? MAX_GIT_OUTPUT_BYTES

    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        outputSize += chunk.length
        if (outputSize > limit) {
          tooLarge = true
          child.kill()
          return
        }
        chunks.push(chunk)
      })
    }
    child.on('error', reject)
    child.on('close', code => {
      if (tooLarge) return reject(new Error(`${command} output exceeded ${limit} bytes`))
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }
      if (code !== 0 && !(options.acceptExitCodes ?? []).includes(code)) {
        return reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${result.stderr.trim()}`))
      }
      resolvePromise(result)
    })
  })
}

function git(cwd, args, options) {
  return run('git', ['--no-pager', '-C', cwd, ...args], options)
}

function splitNul(buffer) {
  const values = buffer.toString('utf8').split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

function porcelainPaths(buffer, prefix) {
  const values = splitNul(buffer)
  const paths = new Set()
  const addPath = path => {
    if (!prefix) paths.add(path)
    else if (path.startsWith(prefix)) paths.add(path.slice(prefix.length))
  }
  for (let i = 0; i < values.length; i++) {
    const record = values[i]
    if (record.length < 4 || record[2] !== ' ') throw new Error('Unexpected git status format')
    addPath(record.slice(3))
    if (/^[RC]/.test(record.slice(0, 2)) || /[RC]$/.test(record.slice(0, 2))) {
      if (++i >= values.length) throw new Error('Incomplete git rename status')
      addPath(values[i])
    }
  }
  return paths
}

function safePath(cwd, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) {
    throw new Error('Invalid Git workspace path')
  }
  const absolute = resolve(cwd, path)
  const inside = relative(cwd, absolute)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Git workspace path escapes project: ${path}`)
  }
  return absolute
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function assertFileInside(cwd, absolute, path) {
  const resolved = await realpath(absolute)
  const inside = relative(cwd, resolved)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`Git workspace path resolves outside project: ${path}`)
  }
}

async function captureFile(cwd, path, budget) {
  const absolute = safePath(cwd, path)
  let info = await lstat(absolute).catch(error => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return { path, kind: 'missing', size: 0 }

  if (info.isSymbolicLink()) {
    const target = Buffer.from(await readlink(absolute), 'utf8')
    return {
      path,
      kind: 'symlink',
      size: target.length,
      sha256: createHash('sha256').update(target).digest('hex'),
      contentBase64: target.toString('base64'),
    }
  }
  if (!info.isFile()) return { path, kind: 'unsupported', size: info.size }

  await assertFileInside(cwd, absolute, path)
  const executable = Boolean(info.mode & 0o111)

  if (info.size > MAX_HASHED_FILE_BYTES || info.size > budget.hashRemaining) {
    return { path, kind: 'file', size: info.size, executable, sha256: null, contentBase64: null }
  }
  if (info.size > MAX_CAPTURED_FILE_BYTES || info.size > budget.remaining) {
    const digest = await hashFile(absolute)
    const after = await lstat(absolute)
    await assertFileInside(cwd, absolute, path)
    if (!after.isFile() || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.mode !== after.mode) {
      return { path, kind: 'unstable', size: after.size }
    }
    budget.hashRemaining -= info.size
    return { path, kind: 'file', size: info.size, executable, sha256: digest, contentBase64: null }
  }

  let bytes
  for (let attempt = 0; attempt < 2; attempt++) {
    bytes = await readFile(absolute)
    const after = await lstat(absolute)
    await assertFileInside(cwd, absolute, path)
    if (after.isFile() && bytes.length === after.size && info.mtimeMs === after.mtimeMs && info.mode === after.mode) break
    if (attempt === 1) return { path, kind: 'unstable', size: after.size }
    info = after
  }
  if (bytes.length > MAX_CAPTURED_FILE_BYTES || bytes.length > budget.remaining || bytes.length > budget.hashRemaining) {
    return { path, kind: 'unstable', size: bytes.length }
  }
  budget.remaining -= bytes.length
  budget.hashRemaining -= bytes.length
  return {
    path,
    kind: 'file',
    size: bytes.length,
    executable: Boolean(info.mode & 0o111),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentBase64: bytes.toString('base64'),
  }
}

async function workspace(cwd) {
  const absolute = await realpath(resolve(cwd))
  const info = await stat(absolute)
  if (!info.isDirectory()) throw new Error(`Workspace is not a directory: ${absolute}`)
  const root = (await git(absolute, ['rev-parse', '--show-toplevel'])).stdout.toString('utf8').trim()
  if (!root) throw new Error(`Workspace is not a Git worktree: ${absolute}`)
  return { cwd: absolute, gitRoot: await realpath(root) }
}

async function listedPaths(cwd) {
  const output = await git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'])
  return new Set(splitNul(output.stdout))
}

function warningForUnavailable(files) {
  const unavailable = files.filter(file => file.kind === 'unstable' || file.kind === 'unsupported' || file.sha256 === null)
  if (!unavailable.length) return []
  const examples = unavailable.slice(0, 5).map(file => file.path).join(', ')
  return [`${unavailable.length} workspace files could not be fully fingerprinted (${examples}); changes in these paths may be unknown.`]
}

/** Snapshot the Git-visible working tree immediately before a task. The snapshot never writes into the project. */
export async function captureWorkspace(cwd) {
  const project = await workspace(cwd)
  const prefix = relative(project.gitRoot, project.cwd).split(sep).filter(Boolean).join('/')
  const beforeStatus = porcelainPaths((await git(project.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).stdout, prefix ? `${prefix}/` : '')
  const paths = await listedPaths(project.cwd)
  for (const path of beforeStatus) paths.add(path)
  if (paths.size > MAX_FILES) throw new Error(`Workspace has ${paths.size} Git-visible paths; snapshot limit is ${MAX_FILES}`)

  const budget = { remaining: MAX_CAPTURED_TOTAL_BYTES, hashRemaining: MAX_HASHED_TOTAL_BYTES }
  const files = []
  for (const path of [...paths].sort()) {
    const file = await captureFile(project.cwd, path, budget)
    file.priorChange = beforeStatus.has(path)
    files.push(file)
  }

  const afterStatus = porcelainPaths((await git(project.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).stdout, prefix ? `${prefix}/` : '')
  const warnings = warningForUnavailable(files)
  if (files.some(file => file.contentBase64 === null && file.sha256)) {
    warnings.push('Some file contents exceeded the 1 MiB per-file or 16 MiB snapshot budget; their later changes can be detected but no line diff can be shown.')
  }
  if (beforeStatus.size !== afterStatus.size || [...beforeStatus].some(path => !afterStatus.has(path))) {
    warnings.push('Git status changed while capturing the baseline; attribution to this task is uncertain.')
  }

  return { ...project, capturedAt: new Date().toISOString(), files, warnings }
}

function readableText(bytes) {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

async function makeDiff(path, before, after, status) {
  const oldBytes = before?.contentBase64 == null ? null : Buffer.from(before.contentBase64, 'base64')
  const newBytes = after?.contentBase64 == null ? null : Buffer.from(after.contentBase64, 'base64')
  if (status === 'type-changed' || oldBytes === null && before?.kind !== 'missing' && before !== undefined || newBytes === null && after?.kind !== 'missing' && after !== undefined) return null
  const oldContent = oldBytes ?? Buffer.alloc(0)
  const newContent = newBytes ?? Buffer.alloc(0)
  if (!readableText(oldContent) || !readableText(newContent)) return null

  const directory = await mkdtemp(join(tmpdir(), 'iteroom-diff-'))
  try {
    const oldFile = join(directory, 'before')
    const newFile = join(directory, 'after')
    await writeFile(oldFile, oldContent)
    await writeFile(newFile, newContent)
    const result = await git(directory, ['diff', '--no-index', '--no-ext-diff', '--no-color', '--unified=3', '--', oldFile, newFile], {
      acceptExitCodes: [1],
      maxOutputBytes: MAX_DIFF_BYTES,
    })
    const output = result.stdout.toString('utf8')
    const hunk = output.indexOf('@@ ')
    const safeName = path.replaceAll('\r', '\\r').replaceAll('\n', '\\n')
    const oldLabel = before?.kind === 'missing' || before === undefined ? '/dev/null' : `a/${safeName}`
    const newLabel = after?.kind === 'missing' || after === undefined ? '/dev/null' : `b/${safeName}`
    return `--- ${oldLabel}\n+++ ${newLabel}\n${hunk < 0 ? '' : output.slice(hunk)}`
  } finally {
    await rm(join(directory, 'before'), { force: true })
    await rm(join(directory, 'after'), { force: true })
    await rmdir(directory)
  }
}

/** Compare today's Git-visible working tree with a persisted pre-task baseline. */
export async function compareWorkspace(baseline) {
  if (!baseline || typeof baseline.cwd !== 'string' || !Array.isArray(baseline.files)) {
    throw new Error('Invalid workspace baseline')
  }
  const project = await workspace(baseline.cwd)
  if (project.cwd !== baseline.cwd || project.gitRoot !== baseline.gitRoot) {
    throw new Error('Workspace or Git worktree changed since the task baseline')
  }

  const oldFiles = new Map()
  for (const file of baseline.files) {
    safePath(project.cwd, file.path)
    if (oldFiles.has(file.path)) throw new Error(`Duplicate baseline path: ${file.path}`)
    oldFiles.set(file.path, file)
  }
  const paths = await listedPaths(project.cwd)
  for (const path of oldFiles.keys()) paths.add(path)
  if (paths.size > MAX_FILES) throw new Error(`Workspace has ${paths.size} Git-visible paths; comparison limit is ${MAX_FILES}`)

  const budget = { remaining: MAX_CAPTURED_TOTAL_BYTES, hashRemaining: MAX_HASHED_TOTAL_BYTES }
  const changes = []
  const warnings = [...(baseline.warnings ?? [])]
  for (const path of [...paths].sort()) {
    const before = oldFiles.get(path)
    const after = await captureFile(project.cwd, path, budget)
    if (!before && after.kind === 'missing') continue
    if (before?.kind === 'missing' && after.kind === 'missing') continue

    const modeChanged = before?.kind === 'file' && after.kind === 'file'
      && typeof before.executable === 'boolean' && typeof after.executable === 'boolean'
      && before.executable !== after.executable
    const sameContent = before && before.kind === after.kind
      && before.sha256 && after.sha256 && before.sha256 === after.sha256

    let status
    if (before?.kind === 'unstable' || before?.kind === 'unsupported' || after.kind === 'unstable' || after.kind === 'unsupported') {
      status = 'unknown'
    } else if (sameContent && !modeChanged) {
      continue
    } else if (!before || before.kind === 'missing') {
      status = 'added'
    } else if (after.kind === 'missing') {
      status = 'deleted'
    } else if (before?.sha256 === null || after.sha256 === null) {
      status = 'unknown'
    } else if (before.kind !== after.kind) {
      status = 'type-changed'
    } else {
      status = 'modified'
    }

    if (modeChanged) warnings.push(`文件可执行位变更：${path}（${before.executable ? '可执行' : '不可执行'} → ${after.executable ? '可执行' : '不可执行'}）。${sameContent ? '文件内容未变，因此没有文本 Diff。' : ''}`)
    let diff = null
    if (status !== 'unknown' && !sameContent) {
      try {
        diff = await makeDiff(path, before, after, status)
      } catch (error) {
        warnings.push(`Could not build diff for ${path}: ${error.message}`)
      }
    }
    if (diff === null && !sameContent) warnings.push(`Line diff unavailable for ${path}; status is ${status}.`)
    changes.push({ path, status, priorChange: before?.priorChange ?? false, diff })
  }

  return { attribution: 'workspace-delta', changes, warnings }
}
