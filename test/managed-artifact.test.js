import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { readManagedArtifact, saveManagedArtifact } from '../src/host/managed-artifact.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'

test('candidate patch is durable outside project, hash-bound and never writes source', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r2-artifact-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  await writeFile(join(project, 'x.mjs'), 'export const x=1\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'artifact-1', kind: 'modify', objective: 'Change x', paths: ['x.mjs'] })).task
  const snapshot = await captureManagedSnapshot(store, task.id)
  const before = Buffer.from('export const x=1\n')
  const after = Buffer.from('export const x=2\n')
  const candidate = { version: 1, taskId: task.id, snapshotId: snapshot.id,
    changes: [{ path: 'x.mjs', kind: 'modified', beforeSha256: createHash('sha256').update(before).digest('hex'),
      afterSha256: createHash('sha256').update(after).digest('hex'), beforeBytes: before.length, afterBytes: after.length }],
    patch: 'diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1,1 +1,1 @@\n-export const x=1\n+export const x=2\n',
    sha256: '' }
  candidate.sha256 = createHash('sha256').update(candidate.patch).digest('hex')
  const saved = await saveManagedArtifact(store, task.id, candidate)
  assert.equal(saved.changeCount, 1)
  assert.equal((await readManagedArtifact(store, task.id, saved.id)).patch, candidate.patch)
  assert.equal(await readFile(join(project, 'x.mjs'), 'utf8'), 'export const x=1\n')
  await assert.rejects(readManagedArtifact(store, task.id, 'e'.repeat(64)), { code: 'ARTIFACT_NOT_FOUND' })
  await assert.rejects(saveManagedArtifact(store, task.id, { ...candidate, changes: [{ ...candidate.changes[0], path: '../escape' }] }), { code: 'ARTIFACT_INVALID' })
  await assert.rejects(saveManagedArtifact(store, task.id, { ...candidate,
    changes: [{ ...candidate.changes[0], beforeSha256: 'b'.repeat(64) }] }), { code: 'ARTIFACT_INVALID' })
})
