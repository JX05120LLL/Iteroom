import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureWorkspace, compareWorkspace } from '../src/host/workspace-evidence.js'

const exec = promisify(execFile)

async function git(cwd, ...args) {
  await exec('git', ['-C', cwd, ...args])
}

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'iteroom-evidence-test-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await git(cwd, 'init', '--quiet')
  await git(cwd, 'config', 'user.name', 'Iteroom Test')
  await git(cwd, 'config', 'user.email', 'test@example.invalid')
  await git(cwd, 'config', 'core.autocrlf', 'false')
  return cwd
}

test('reports only changes since the baseline, preserving pre-existing dirty attribution', async t => {
  const cwd = await repository(t)
  await writeFile(join(cwd, 'edited.txt'), 'committed\n')
  await writeFile(join(cwd, 'removed.txt'), 'remove me\n')
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '--quiet', '-m', 'base')

  await writeFile(join(cwd, 'edited.txt'), 'user change\n')
  await writeFile(join(cwd, 'notes.txt'), 'user note\n')
  const baseline = await captureWorkspace(cwd)
  assert.equal(JSON.parse(JSON.stringify(baseline)).files.length, 3)

  await writeFile(join(cwd, 'edited.txt'), 'user change\nassistant change\n')
  await writeFile(join(cwd, 'notes.txt'), 'user note\nassistant note\n')
  await writeFile(join(cwd, 'new.txt'), 'task file\n')
  await rm(join(cwd, 'removed.txt'))
  const { changes, warnings } = await compareWorkspace(JSON.parse(JSON.stringify(baseline)))

  assert.deepEqual(changes.map(({ path, status, priorChange }) => ({ path, status, priorChange })), [
    { path: 'edited.txt', status: 'modified', priorChange: true },
    { path: 'new.txt', status: 'added', priorChange: false },
    { path: 'notes.txt', status: 'modified', priorChange: true },
    { path: 'removed.txt', status: 'deleted', priorChange: false },
  ])
  assert.match(changes[0].diff, /\+assistant change/)
  assert.doesNotMatch(changes[0].diff, /\+user change/)
  assert.match(changes[2].diff, /\+assistant note/)
  assert.doesNotMatch(changes[2].diff, /\+user note/)
  assert.match(changes[1].diff, /--- \/dev\/null/)
  assert.match(changes[3].diff, /\+\+\+ \/dev\/null/)
  assert.deepEqual(warnings, [])
  assert.equal(await readFile(join(cwd, 'edited.txt'), 'utf8'), 'user change\nassistant change\n')
})

test('an unchanged worktree has no task diff, even when it starts dirty', async t => {
  const cwd = await repository(t)
  await writeFile(join(cwd, 'existing.txt'), 'original\n')
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '--quiet', '-m', 'base')
  await writeFile(join(cwd, 'existing.txt'), 'already dirty\n')

  const baseline = await captureWorkspace(cwd)
  const result = await compareWorkspace(baseline)
  assert.deepEqual(result.changes, [])
})

test('a Git-visible executable mode change is reported without an invented line diff', async t => {
  const cwd = await repository(t)
  await git(cwd, 'config', 'core.filemode', 'true')
  const path = join(cwd, 'script.sh')
  await writeFile(path, '#!/bin/sh\necho ready\n')
  await git(cwd, 'add', 'script.sh')
  await git(cwd, 'commit', '--quiet', '-m', 'base')

  const baseline = await captureWorkspace(cwd)
  const beforeMode = (await stat(path)).mode
  await chmod(path, beforeMode | 0o111)
  const gitStatus = await exec('git', ['-C', cwd, 'status', '--porcelain', '--', 'script.sh'])
  if (!gitStatus.stdout.trim()) {
    t.skip('this platform does not expose executable-bit changes to Git')
    return
  }

  const result = await compareWorkspace(baseline)
  assert.deepEqual(result.changes.map(({ path, status, priorChange, diff }) => ({ path, status, priorChange, diff })), [
    { path: 'script.sh', status: 'modified', priorChange: false, diff: null },
  ])
  assert.ok(result.warnings.some(warning => warning.includes('script.sh')
    && warning.includes('可执行位') && warning.includes('内容未变')))
})

test('an oversized file can be detected but is never shown as an invented line diff', async t => {
  const cwd = await repository(t)
  const path = join(cwd, 'large.txt')
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 'a'))
  const baseline = await captureWorkspace(cwd)
  assert.equal(baseline.files[0].contentBase64, null)
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 'b'))

  const result = await compareWorkspace(baseline)
  assert.deepEqual(result.changes.map(({ path, status, priorChange, diff }) => ({ path, status, priorChange, diff })), [
    { path: 'large.txt', status: 'modified', priorChange: true, diff: null },
  ])
  assert.ok(result.warnings.some(warning => warning.includes('Line diff unavailable')))
})

test('a new oversized file is an addition even when its contents cannot be captured', async t => {
  const cwd = await repository(t)
  const baseline = await captureWorkspace(cwd)
  await writeFile(join(cwd, 'large-new.txt'), Buffer.alloc(1024 * 1024 + 1, 'x'))

  const result = await compareWorkspace(baseline)
  assert.deepEqual(result.changes.map(({ path, status, priorChange, diff }) => ({ path, status, priorChange, diff })), [
    { path: 'large-new.txt', status: 'added', priorChange: false, diff: null },
  ])
  assert.ok(result.warnings.some(warning => warning.includes('large-new.txt')))
})

test('staged initial edits are marked pre-existing and a subdirectory stays in scope', async t => {
  const cwd = await repository(t)
  const subdir = join(cwd, 'sub')
  await mkdir(subdir)
  await writeFile(join(cwd, 'outside.txt'), 'outside original\n')
  await writeFile(join(subdir, 'inside.txt'), 'inside original\n')
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '--quiet', '-m', 'base')
  await writeFile(join(subdir, 'inside.txt'), 'staged edit\n')
  await git(cwd, 'add', 'sub/inside.txt')

  const baseline = await captureWorkspace(subdir)
  await writeFile(join(subdir, 'inside.txt'), 'staged edit\nnew edit\n')
  await writeFile(join(cwd, 'outside.txt'), 'outside changed\n')
  const result = await compareWorkspace(baseline)

  assert.equal(result.attribution, 'workspace-delta')
  assert.deepEqual(result.changes.map(({ path, status, priorChange }) => ({ path, status, priorChange })), [
    { path: 'inside.txt', status: 'modified', priorChange: true },
  ])
  assert.match(result.changes[0].diff, /\+new edit/)
  assert.doesNotMatch(result.changes[0].diff, /\+staged edit/)
})

test('a non-Git directory fails instead of appearing as an empty workspace', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'iteroom-evidence-nongit-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await assert.rejects(captureWorkspace(cwd), /git .* failed/)
})
