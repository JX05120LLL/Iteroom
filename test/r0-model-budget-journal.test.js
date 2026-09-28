import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, writeFile, mkdir, unlink, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { createModelRequestGuard } from '../scripts/r0/model-request-guard.mjs'
import { controlledEnv } from '../scripts/r0/ocr-process.mjs'

const exec = promisify(execFile)
const baseURL = 'http://127.0.0.1:39101', model = 'synthetic-only'
const guard = options => createModelRequestGuard({ baseURL, model, maxRequests: 1, authorized: true,
  commit: async () => {}, transport: async () => new Response('synthetic'), ...options })
const identity = guard().snapshot().identity
const request = () => [baseURL + '/chat/completions', { method: 'POST', body: JSON.stringify({ model, stream: true,
  max_tokens: 128, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'synthetic probe' }] }) }]
const moduleURL = pathToFileURL(resolve('scripts/r0/model-budget-journal.mjs')).href
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r0-model-budget-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('iteroom-r0-model-budget-'))
    await rm(root, { recursive: true, force: true })
  })
  return root
}
const open = async root => (await import('../scripts/r0/model-budget-journal.mjs')).openModelBudgetJournal({ root, identity })

test('disk reservation precedes transport and survives close/reopen without refund', async t => {
  const root = await fixture(t), journal = await open(root)
  const fetch = guard({ state: journal.state, commit: journal.commit, transport: async () => {
    const saved = JSON.parse(await readFile(join(root, 'budget.json'), 'utf8'))
    assert.deepEqual(saved, { identity, attempts: 1 }); throw Error('synthetic transport failure')
  } })
  await assert.rejects(fetch(...request())); await journal.close()
  const restarted = await open(root)
  assert.equal(restarted.state.attempts, 1)
  await assert.rejects(guard({ state: restarted.state, commit: restarted.commit })(...request()), { code: 'model_request_budget_exhausted' })
  await restarted.close()
})

test('a separate Node process cannot acquire the held journal lock', async t => {
  const root = await fixture(t), journal = await open(root)
  const source = `import {openModelBudgetJournal} from ${JSON.stringify(moduleURL)};
    try {await openModelBudgetJournal({root:process.argv[1],identity:process.argv[2]}); process.exitCode=1}
    catch(error){if(error.code!=='model_budget_locked')throw error;process.stdout.write('locked')}`
  const child = await exec(process.execPath, ['--input-type=module', '-e', source, root, identity], { env: controlledEnv(root) })
  assert.equal(child.stdout, 'locked'); await journal.close()
})

test('invalid JSON, changed identity, counter shape and non-monotonic commits are rejected', async t => {
  const root = await fixture(t)
  for (const record of ['{', JSON.stringify({ identity: '0'.repeat(64), attempts: 0 }),
    JSON.stringify({ identity, attempts: 7 }), JSON.stringify({ identity, attempts: 0, private: 'synthetic' })]) {
    await writeFile(join(root, 'budget.json'), record)
    await assert.rejects(open(root))
  }
  await unlink(join(root, 'budget.json'))
  const journal = await open(root)
  await assert.rejects(journal.commit({ identity, attempts: 2 }), { code: 'model_budget_sequence_invalid' })
  await assert.rejects(journal.commit({ identity, attempts: 1, private: 'synthetic' }), { code: 'model_budget_sequence_invalid' })
  await journal.commit({ identity, attempts: 1 })
  await assert.rejects(journal.commit({ identity, attempts: 1 }), { code: 'model_budget_sequence_invalid' })
  await journal.close()
})

test('orphan lock is not reclaimed automatically and a junction root is refused', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'budget.lock'), 'synthetic orphan')
  await assert.rejects(open(root), { code: 'model_budget_locked' })
  assert.equal(await readFile(join(root, 'budget.lock'), 'utf8'), 'synthetic orphan')
  const target = await fixture(t), link = join(root, 'link')
  await symlink(target, link, 'junction')
  await assert.rejects(open(link), { code: 'unmanaged_model_budget_root' })
})

test('an actual disk replacement failure prevents all subsequent HTTP attempts', async t => {
  const root = await fixture(t), journal = await open(root)
  await unlink(join(root, 'budget.json')); await mkdir(join(root, 'budget.json'))
  let sent = 0
  const fetch = guard({ state: journal.state, commit: journal.commit, transport: async () => { sent++ } })
  await assert.rejects(fetch(...request()), { code: 'model_budget_write_failed' })
  await assert.rejects(fetch(...request()), { code: 'model_budget_write_failed' })
  assert.equal(sent, 0); await journal.close()
})

test('partial initial lock write closes its real handle, retains the unknown lock and preserves the original I/O error', async t => {
  const root = await fixture(t), originalOpen = fs.open.bind(fs)
  let handle, caught
  t.mock.method(fs, 'open', async (...args) => {
    const opened = await originalOpen(...args)
    if (basename(args[0]) === 'budget.lock') {
      handle = opened
      const originalWrite = handle.writeFile.bind(handle)
      t.mock.method(handle, 'writeFile', async () => {
        await originalWrite('synthetic-partial-lock')
        throw Object.assign(Error('synthetic initialization I/O error'), { code: 'ENOSPC' })
      })
    }
    return opened
  })
  try {
    try { await open(root) } catch (error) { caught = error }
    assert.equal(handle.fd, -1, 'initialization failure must close its opened handle')
    assert.equal(caught?.code, 'ENOSPC')
    assert.equal(await readFile(join(root, 'budget.lock'), 'utf8'), 'synthetic-partial-lock')
  } finally { if (handle?.fd !== -1) await handle.close() }
})

test('separate-process disk probe retains failed reservations and orphan locks without model HTTP', async () => {
  const { runModelJournalProbe } = await import('../scripts/r0/model-journal-probe.mjs')
  const report = await runModelJournalProbe()
  assert.equal(report.status, 'passed'); assert.equal(report.actualModel, false); assert.equal(report.actualHttp, false)
  assert.equal(report.reservedAttempts, 1)
  for (const value of Object.values(report.checks)) assert.equal(value, true)
  assert.doesNotMatch(JSON.stringify(report), /apiKey|Bearer|AppData|"messages"/)
})
