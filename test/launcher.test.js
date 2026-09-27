import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const launcher = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/iteroom.mjs')

test('help works from another project and does not create project files', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'iteroom-launcher-help-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))

  const { stdout } = await exec(process.execPath, [launcher, '--help'], { cwd: workspace })
  assert.match(stdout, /Usage: iteroom \[workspace\]/)
  assert.match(stdout, /ITEROOM_DSH_HOME/)
  assert.deepEqual(await readdir(workspace), [])
})

test('invalid project fails before starting the Host', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'iteroom-launcher-invalid-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const absent = join(parent, 'missing')

  await assert.rejects(exec(process.execPath, [launcher, absent, '--no-open']), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Project directory does not exist/)
    assert.doesNotMatch(error.stderr, /could not start DeepSeek Harness/)
    return true
  })
})

test('unknown options fail with an actionable error', async () => {
  await assert.rejects(exec(process.execPath, [launcher, '--host', '0.0.0.0']), error => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /Unknown option: --host/)
    return true
  })
})
