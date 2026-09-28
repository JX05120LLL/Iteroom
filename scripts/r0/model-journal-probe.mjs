import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createModelRequestGuard } from './model-request-guard.mjs'
import { openModelBudgetJournal } from './model-budget-journal.mjs'
import { controlledEnv, failure } from './ocr-process.mjs'

const exec = promisify(execFile)
const guardOptions = { baseURL: 'http://127.0.0.1:39101', model: 'synthetic-only', maxRequests: 1,
  authorized: true, commit: async () => {}, transport: async () => { throw failure('synthetic_transport_failure') } }
const journalURL = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'model-budget-journal.mjs')).href
const guardURL = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'model-request-guard.mjs')).href

export async function runModelJournalProbe() {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    evidenceKind: 'actual-private-files-and-separate-node-processes', actualModel: false,
    actualHttp: false, credentialsRead: false, userSourceRead: false, gateA: 'not_completed', checks: {},
    unverified: ['real-model-tool-loop', 'monetary-budget', 'power-loss-durability', 'product-budget-store'] }
  const root = await mkdtemp(join(tmpdir(), 'iteroom-r0-model-budget-'))
  const orphanRoot = await mkdtemp(join(tmpdir(), 'iteroom-r0-model-budget-'))
  const identity = createModelRequestGuard(guardOptions).snapshot().identity
  let journal
  const runChild = async (source, childRoot = root) => {
    const child = await exec(process.execPath, ['--input-type=module', '-e', source, childRoot, identity],
      { env: controlledEnv(childRoot), timeout: 5000, maxBuffer: 4096 })
    return JSON.parse(child.stdout)
  }
  try {
    journal = await openModelBudgetJournal({ root, identity })
    const locked = await runChild(`import {openModelBudgetJournal} from ${JSON.stringify(journalURL)};
      try {await openModelBudgetJournal({root:process.argv[1],identity:process.argv[2]}); throw Error('unexpected lock acquisition')}
      catch(error){if(error.code!=='model_budget_locked')throw error; console.log(JSON.stringify({locked:true}))}`)
    report.checks.separateProcessExcluded = locked.locked === true
    await journal.close(); journal = undefined
    const reserved = await runChild(`import {openModelBudgetJournal} from ${JSON.stringify(journalURL)};
      import {createModelRequestGuard} from ${JSON.stringify(guardURL)}; import {readFile} from 'node:fs/promises';
      import {join} from 'node:path';
      const root=process.argv[1],identity=process.argv[2],journal=await openModelBudgetJournal({root,identity});
      let persistedBeforeTransport=false;
      const guard=createModelRequestGuard({baseURL:'http://127.0.0.1:39101',model:'synthetic-only',maxRequests:1,
        authorized:true,state:journal.state,commit:journal.commit,transport:async()=>{
          persistedBeforeTransport=JSON.parse(await readFile(join(root,'budget.json'),'utf8')).attempts===1;
          throw Object.assign(Error('synthetic failure'),{code:'synthetic_transport_failure'})}});
      try {await guard('http://127.0.0.1:39101/chat/completions',{method:'POST',body:JSON.stringify({model:'synthetic-only',
        stream:true,max_tokens:128,thinking:{type:'disabled'},messages:[{role:'user',content:'synthetic probe'}]})})}
      catch(error){if(error.code!=='synthetic_transport_failure')throw error}
      await journal.close();console.log(JSON.stringify({persistedBeforeTransport,attempts:guard.snapshot().attempts}))`)
    report.checks.diskCommittedBeforeSyntheticTransport = reserved.persistedBeforeTransport === true
    journal = await openModelBudgetJournal({ root, identity })
    let sent = false
    const restarted = createModelRequestGuard({ ...guardOptions, state: journal.state, commit: journal.commit,
      transport: async () => { sent = true } })
    try { await restarted('http://127.0.0.1:39101/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'synthetic-only',
      stream: true, max_tokens: 128, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'synthetic probe' }] }) }) }
    catch (error) { report.checks.restartBudgetNotRefunded = error.code === 'model_request_budget_exhausted' && !sent }
    report.reservedAttempts = JSON.parse(await readFile(join(root, 'budget.json'), 'utf8')).attempts
    await journal.close(); journal = undefined
    await runChild(`import {openModelBudgetJournal} from ${JSON.stringify(journalURL)};
      const journal=await openModelBudgetJournal({root:process.argv[1],identity:process.argv[2]});
      await journal.commit({identity:process.argv[2],attempts:1});console.log(JSON.stringify({reserved:true}));process.exit(0)`, orphanRoot)
    try { await openModelBudgetJournal({ root: orphanRoot, identity }) }
    catch (error) { report.checks.orphanLockNotReclaimed = error.code === 'model_budget_locked'
      && JSON.parse(await readFile(join(orphanRoot, 'budget.json'), 'utf8')).attempts === 1 }
  } catch (error) { report.errorCode = error.code ?? 'model_journal_probe_failed' }
  finally {
    if (journal) await journal.close()
    for (const owned of [root, orphanRoot]) {
      if (dirname(resolve(owned)) !== resolve(tmpdir()) || !basename(owned).startsWith('iteroom-r0-model-budget-')) throw failure('unsafe_model_fixture_cleanup')
      await rm(owned, { recursive: true, force: true })
    }
    report.checks.ownedFixturesRemoved = true
  }
  report.status = !report.errorCode && report.reservedAttempts === 1
    && ['separateProcessExcluded', 'diskCommittedBeforeSyntheticTransport', 'restartBudgetNotRefunded',
      'orphanLockNotReclaimed', 'ownedFixturesRemoved'].every(key => report.checks[key]) ? 'passed' : 'failed'
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runModelJournalProbe(); process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.status === 'passed' ? 0 : 1
}
