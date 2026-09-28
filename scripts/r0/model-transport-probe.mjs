import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createModelRequestGuard } from './model-request-guard.mjs'
import { sha256 } from './review-files.mjs'

export async function runModelTransportProbe() {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    evidenceKind: 'fixed-official-adapter-local-synthetic-http-sse', adapterVersion: '0.1.5-rc.3',
    actualModel: false, gateA: 'not_completed', userSourceRead: false, credentialsRead: false, checks: {}, requests: 0,
    unverified: ['real-provider', 'real-model-tool-loop', 'monetary-budget', 'live-runner-journal'] }
  let serverFailure, mode = 'text', saved, abortedRequestClosed = false
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const data of request) { body += data; if (Buffer.byteLength(body) > 65536) throw Error('Local request exceeded bound') }
      const wire = JSON.parse(body)
      if (request.method !== 'POST' || request.url !== '/chat/completions' || request.headers.authorization !== 'Bearer synthetic-only-not-a-key') throw Error('Local request scope changed')
      report.requests++
      report.checks.boundedOutput = wire.max_tokens === 128
      report.checks.thinkingDisabled = wire.thinking?.type === 'disabled'
      report.lastRequestSha256 = sha256(body)
      if (mode === 'auth') { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'synthetic authorization failure' } })); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode === 'abort') { response.on('close', () => { abortedRequestClosed = true }); response.write(': synthetic wait\n\n'); return }
      const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({ id: 'synthetic-response', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
      response.end(chunk({ role: 'assistant', content: 'Synthetic local response.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n')
    } catch (error) { serverFailure = error; response.writeHead(500); response.end('synthetic contract failed') }
  })
  const nativeFetch = globalThis.fetch
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
    const baseURL = `http://127.0.0.1:${server.address().port}`, model = 'synthetic-only'
    const guard = createModelRequestGuard({ baseURL, model, authorized: true, maxRequests: 3,
      commit: async state => { saved = state }, transport: nativeFetch })
    globalThis.fetch = guard
    const connection = resolveAdapterOptions({ baseURL, apiKeyEnv: 'ITEROOM_SYNTHETIC_ONLY', thinking: 'disabled', reasoningEffort: 'off',
      maxTokens: 128, models: [{ id: model, contextWindow: 8192, maxTokens: 128 }], streamIdleTimeoutMs: 2000 })
    const adapter = new DeepSeekAdapter({ options: () => connection, resolveApiKey: async () => 'synthetic-only-not-a-key',
      resolveUserId: () => 'synthetic-only-user', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
    const options = signal => ({ provider: 'deepseek-official', model, maxTokens: 128, signal, tools: [],
      messages: [createUserMessage({ content: [{ type: 'text', text: 'Synthetic local transport probe.' }], source: { kind: 'user' } })] })
    const collect = async signal => { const chunks = []; for await (const chunk of adapter.stream(options(signal))) chunks.push(chunk); return chunks }
    const chunks = await collect(new AbortController().signal)
    report.checks.textSseParsed = chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Synthetic local response.')
      && chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'stop')
    mode = 'auth'
    try { await collect(new AbortController().signal) } catch (error) { report.checks.httpAuthErrorPreserved = error.code === 'AUTH' }
    mode = 'abort'
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 150)
    try { await collect(controller.signal) } catch (error) { report.checks.abortAttemptRetained = error.code === 'ABORTED' && saved.attempts === 3 }
    finally { clearTimeout(timer) }
    for (let i = 0; !abortedRequestClosed && i < 50; i++) await new Promise(done => setTimeout(done, 10))
    report.checks.clientDisconnectObserved = abortedRequestClosed
    report.checks.loopbackOnly = server.address().address === '127.0.0.1'
    report.reservedAttempts = guard.snapshot().attempts
  } catch (error) { report.errorCode = error.code ?? error.cause?.code ?? 'local_transport_probe_failed' }
  finally {
    globalThis.fetch = nativeFetch
    server.closeAllConnections()
    await new Promise(done => server.close(done))
    report.checks.serverStopped = !server.listening
    report.checks.abortedRequestClosed = abortedRequestClosed
  }
  report.status = !serverFailure && !report.errorCode && report.requests === 3
    && ['boundedOutput', 'thinkingDisabled', 'textSseParsed', 'httpAuthErrorPreserved', 'abortAttemptRetained', 'clientDisconnectObserved', 'loopbackOnly', 'serverStopped']
      .every(key => report.checks[key]) ? 'passed' : 'failed'
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runModelTransportProbe(); process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exitCode = report.status === 'passed' ? 0 : 1
}
