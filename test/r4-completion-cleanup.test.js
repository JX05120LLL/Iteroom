import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeCompletion } from '../scripts/r4/completion-cleanup.mjs'

test('probe counts requests only after the active execution has stopped', async () => {
  const release = Promise.withResolvers(), entered = Promise.withResolvers()
  let requests = 2, observed = false
  const done = finalizeCompletion({
    stopExecution: async () => { entered.resolve(); await release.promise; requests = 4 },
    readRequests: async () => { observed = true; return requests }, reconcile: async () => {}, stopService: async () => {},
  })
  await entered.promise
  assert.equal(observed, false)
  release.resolve()
  assert.equal((await done).requestsReserved, 4)
})

test('unconfirmed sandbox cleanup retains the control service and reports failure', async () => {
  let stopped = false
  const failure = Object.assign(Error('Unconfirmed resource'), { code: 'SANDBOX_CLEANUP_UNCONFIRMED' })
  const result = await finalizeCompletion({ stopExecution: async () => {}, readRequests: async () => 8,
    reconcile: async () => { throw failure }, stopService: async () => { stopped = true } })
  assert.equal(stopped, false)
  assert.equal(result.cleanupError, failure)
  assert.equal(result.requestsReserved, 8)
})

test('failed request evidence is unknown but does not prevent confirmed resource cleanup', async () => {
  let stopped = false
  const result = await finalizeCompletion({ stopExecution: async () => {}, readRequests: async () => { throw Error('Unreadable journal') },
    reconcile: async () => {}, stopService: async () => { stopped = true } })
  assert.equal(result.requestsReserved, null)
  assert.equal(stopped, true)
  assert.ok(result.cleanupError)
})

test('unconfirmed execution retains service and does not claim a final request count', async () => {
  let read = false, stopped = false
  const result = await finalizeCompletion({ stopExecution: async () => { throw Error('Execution still running') },
    readRequests: async () => { read = true; return 8 }, reconcile: async () => {}, stopService: async () => { stopped = true } })
  assert.equal(read, false)
  assert.equal(stopped, false)
  assert.equal(result.executionStopped, false)
  assert.equal(result.requestsReserved, null)
})
