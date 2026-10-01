import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { controlledEnv } from '../r0/ocr-process.mjs'
import { git } from '../../src/host/review/git.js'

export const SOURCE = 'src/divide.mjs', TEST = 'src/divide.test.mjs'
export const BAD = 'export const divide = value => value / 0\n'
export const FIXED = 'export const divide = value => value / 2\n'

/** Every byte is authored here. No existing project or user configuration is copied. */
export async function completionFixture(root) {
  const repository = join(root, 'project'), home = join(root, 'git-home')
  await mkdir(join(repository, 'src'), { recursive: true }); await mkdir(home)
  const fixture = { repository, home, options: { cwd: repository, env: controlledEnv(home), timeoutMs: 10000, maxOutputBytes: 1048576 } }
  const put = (path, text) => writeFile(join(repository, path), text)
  await put(SOURCE, 'export const divide = value => value\n')
  await put(TEST, 'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { divide } from "./divide.mjs"\ntest("divide", () => assert.equal(divide(4), 2))\n')
  await put('src/deleted.mjs', 'export const obsolete = true\n')
  await put('src/original.mjs', 'export const stable = true\n')
  await mkdir(join(repository, 'test'))
  await put('test/coverage.test.ts', 'export const expected = 1\n')
  await mkdir(join(repository, 'vendor'))
  await put('vendor/lib.mjs', 'export const external = 1\n')
  await git(fixture, ['init', '-q'])
  await git(fixture, ['add', '.']); await git(fixture, ['commit', '-qm', 'synthetic baseline'])
  fixture.base = (await git(fixture, ['rev-parse', 'HEAD'])).trim()
  await put(SOURCE, BAD)
  await put(TEST, 'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { divide } from "./divide.mjs"\ntest("divide", () => { assert.equal(divide(4), 2); assert.equal(divide(0), 0) })\n')
  await unlink(join(repository, 'src/deleted.mjs'))
  await rename(join(repository, 'src/original.mjs'), join(repository, 'src/renamed.mjs'))
  await put('src/added.mjs', 'export const added = true\n')
  await put('test/coverage.test.ts', 'export const expected = 2\n')
  await put('vendor/lib.mjs', 'export const external = 2\n')
  await git(fixture, ['add', '.']); await git(fixture, ['commit', '-qm', 'synthetic mixed changes'])
  fixture.head = (await git(fixture, ['rev-parse', 'HEAD'])).trim()
  // Retain the historical commit by ref, then represent its bytes as staged changes.
  await git(fixture, ['update-ref', 'refs/heads/synthetic-changes', fixture.head])
  await git(fixture, ['update-ref', 'HEAD', fixture.base, fixture.head])
  // A dirty staged, unstaged and untracked worktree is intentionally retained.
  await put(SOURCE, 'export const divide = value => value / 0\n// synthetic staged input\n')
  await git(fixture, ['add', SOURCE]); await put(SOURCE, BAD)
  await put('src/loose.mjs', 'export const loose = true\n')
  return fixture
}
