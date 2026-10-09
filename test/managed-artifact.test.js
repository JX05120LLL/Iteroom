import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedTaskStore } from '../src/host/managed-task-store.js'
import { readManagedArtifact, saveManagedArtifact } from '../src/host/managed-artifact.js'
import { captureManagedSnapshot } from '../src/host/managed-snapshot.js'
import { createPatchCandidate, definePatchScope } from '../src/host/managed-patch-contract.js'

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

test('v2 cannot enter v1 persistence and legacy candidates remain cold-readable unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r5-compat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project'); await mkdir(project)
  await writeFile(join(project, 'x.js'), 'old\n')
  const store = new ManagedTaskStore(join(root, 'data'), project)
  const task = (await store.create({ requestId: 'compat', kind: 'modify', objective: 'Synthetic compatibility', paths: ['x.js'] })).task
  const snapshot = await captureManagedSnapshot(store, task.id)
  const hash = value => createHash('sha256').update(value).digest('hex')
  const patch = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,1 +1,1 @@\n-old\n+new\n'
  const legacy = { version: 1, taskId: task.id, snapshotId: snapshot.id,
    changes: [{ path: 'x.js', kind: 'modified', beforeSha256: hash('old\n'), afterSha256: hash('new\n'), beforeBytes: 4, afterBytes: 4 }],
    patch, sha256: hash(patch) }
  const saved = await saveManagedArtifact(store, task.id, legacy)
  const scope = definePatchScope(task.id, [{ path: 'x.js', writable: true,
    before: { kind: 'file', mode: '100644', sha256: hash('old\n'), byteLength: 4 } }])
  const candidate = createPatchCandidate(scope, [{ kind: 'modified', old: { path: 'x.js', text: 'old\n' }, new: { path: 'x.js', text: 'new\n' } }])
  const directory = join(store.dataHome, 'managed-artifacts-v1', (await store.location()).projectId, task.id)
  const inventory = await readdir(directory)
  await assert.rejects(saveManagedArtifact(store, task.id, candidate), { code: 'ARTIFACT_INVALID' })
  await assert.rejects(saveManagedArtifact(store, task.id, { ...candidate, version: 1, snapshotId: snapshot.id }), { code: 'ARTIFACT_INVALID' })
  assert.deepEqual(await readdir(directory), inventory)
  const reopened = new ManagedTaskStore(store.dataHome, project)
  assert.deepEqual(await readManagedArtifact(reopened, task.id, saved.id), legacy)
  assert.equal(await readFile(join(project, 'x.js'), 'utf8'), 'old\n')
  assert.equal((await reopened.get(task.id)).artifactId, undefined)
})
