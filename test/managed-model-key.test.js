import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadManagedModelKey } from '../src/host/managed-model-key.js'

test('managed model key may come from project-external JSON without exposing it in task records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r1-key-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const path = join(root, 'private-model.json')
  await writeFile(path, JSON.stringify({ provider: 'deepseek-official', baseURL: 'https://api.deepseek.com',
    model: 'deepseek-flash', apiKey: 'sk-synthetic-only' }))
  assert.equal(await loadManagedModelKey(project, { ITEROOM_MODEL_KEY_FILE: path }), 'sk-synthetic-only')
  assert.equal(await loadManagedModelKey(project, {}), null)
  const inProject = join(project, 'private-model.json')
  await writeFile(inProject, '{}')
  await assert.rejects(loadManagedModelKey(project, { ITEROOM_MODEL_KEY_FILE: inProject }), { code: 'MODEL_KEY_FILE_INVALID' })
  const alias = join(root, 'alias.json')
  try { await symlink(path, alias, 'file') }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error }
  await assert.rejects(loadManagedModelKey(project, { ITEROOM_MODEL_KEY_FILE: alias }), { code: 'MODEL_KEY_FILE_INVALID' })
})
