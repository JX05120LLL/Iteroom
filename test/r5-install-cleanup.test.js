import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProbeBrowserSession } from '../scripts/r5/browser-session.mjs'

test('a partial browser open failure still closes its owned session', async () => {
  let resourceLive = false, closes = 0
  const session = new ProbeBrowserSession(async ([action]) => {
    if (action === 'open') { resourceLive = true; throw Error('navigation failed after launch') }
    assert.equal(action, 'close'); resourceLive = false; closes++
  })
  await assert.rejects(session.open('http://127.0.0.1/'), /navigation failed/)
  assert.equal(resourceLive, true)
  assert.equal(await session.close(), true)
  assert.equal(resourceLive, false)
  assert.equal(await session.close(), null)
  assert.equal(closes, 1)
})

test('an unconfirmed browser close rejects cleanup and remains retryable', async () => {
  let attempts = 0
  const session = new ProbeBrowserSession(async ([action]) => {
    if (action === 'close' && ++attempts === 1) throw Error('close acknowledgement missing')
  })
  assert.equal(await session.close(), null)
  await session.open('http://127.0.0.1/')
  await assert.rejects(session.close(), /acknowledgement missing/)
  assert.equal(await session.close(), true)
  assert.equal(attempts, 2)
})
