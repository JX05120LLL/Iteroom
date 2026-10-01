/** Shared finalization for evidence probes; an unresolved sandbox keeps its service available. */
export async function finalizeCompletion({ stopExecution, readRequests, reconcile, stopService }) {
  let requestsReserved = null, cleanupError = null
  try { await stopExecution() }
  catch (error) { return { requestsReserved, cleanupError: error, executionStopped: false } }
  try {
    requestsReserved = await readRequests()
    if (!Number.isSafeInteger(requestsReserved) || requestsReserved < 0) throw Error('Invalid request evidence')
  } catch (error) { requestsReserved = null; cleanupError = error }
  try { await reconcile() }
  catch (error) { return { requestsReserved, cleanupError: error, executionStopped: true } }
  try { await stopService() } catch (error) { cleanupError = error }
  return { requestsReserved, cleanupError, executionStopped: true }
}
