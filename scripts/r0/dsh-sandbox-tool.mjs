import { shellCommand } from './sandbox-runtime.mjs'
import { failure } from './ocr-process.mjs'
import { sha256 } from './review-files.mjs'
import { cleanupDecision } from './sandbox-faults.mjs'

const delay = ms => new Promise(done => setTimeout(done, ms))
export function dshCleanupDecision({ allocationPending, cleanupFailed, resourceInventoryCaptured }) {
  return cleanupDecision({ allocationPending: allocationPending || resourceInventoryCaptured !== true, cleanupFailed })
}
export function verifyProcesses(pids, readStat, phase) {
  if (!['alive', 'stopped'].includes(phase) || !Array.isArray(pids) || pids.length !== 2
    || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || pids[0] === pids[1]) throw Error('Invalid process evidence')
  for (const pid of pids) {
    let stat
    try { stat = readStat(pid) }
    catch (error) { if (phase === 'stopped' && error.code === 'ENOENT') continue; throw error }
    const match = stat.match(/^(\d+) \(.*\) ([A-Za-z]) /s)
    if (!match || Number(match[1]) !== pid) throw Error('Invalid process stat')
    if (phase === 'alive' ? ['Z', 'X', 'x'].includes(match[2]) : match[2] !== 'Z') throw Error('Process state mismatch')
  }
  return true
}
export function processProbeSource(phase) {
  if (!['alive', 'stopped'].includes(phase)) throw failure('invalid_process_probe')
  return 'import{readFileSync}from"node:fs";const verify=' + verifyProcesses.toString()
    + ';try{verify(JSON.parse(readFileSync("/workspace/pids.json","utf8")),pid=>readFileSync("/proc/"+pid+"/stat","utf8"),'
    + JSON.stringify(phase) + ')}catch{process.exit(1)}'
}
export function forwardAdapterFactory(factory) {
  return {
    createLifecycleStack: options => factory.createLifecycleStack(options),
    createEgressStack: options => factory.createEgressStack(options),
    createNetworkPolicyStack: options => factory.createNetworkPolicyStack(options),
    createExecdStack: options => factory.createExecdStack({ ...options,
      connectionConfig: { ...options.connectionConfig, sseFetch: globalThis.fetch } }),
  }
}
export function validateAction(args) {
  if (!args || Array.isArray(args) || Object.keys(args).length !== 1
    || !['repair', 'fail', 'wait'].includes(args.action)) throw failure('sandbox_action_denied')
  return args.action
}
export async function executeSandboxAction(sandbox, args, signal, state, save, onStarted) {
  const action = validateAction(args)
  signal.throwIfAborted()
  state.toolExecutions++
  const run = async (name, argv, options = {}) => {
    let output = ''
    const append = msg => {
      output += msg.text
      if (Buffer.byteLength(output) > 65536) throw failure('sandbox_output_limit')
    }
    const result = await sandbox.commands.run(shellCommand(argv), { timeoutSeconds: 10, cwd: '/workspace', ...options },
      { onStdout: append, onStderr: append, skipAccumulation: true })
    state.executions ??= []
    state.executions.push({ name, executionIdSha256: result.id && sha256(result.id), exitCode: result.exitCode ?? null,
      outputBytes: Buffer.byteLength(output), outputSha256: sha256(output), errorPresent: !!result.error })
    save()
    return { ...result, output }
  }
  if (action === 'repair') {
    await sandbox.files.writeFiles([{ path: '/workspace/add.mjs', data: 'export const add = (a,b) => a+b;\n', mode: 644 }])
    const result = await run('repair-test', ['node', '-e', 'import{appendFileSync}from"node:fs";import{spawnSync}from"node:child_process";appendFileSync("/workspace/actions.txt","repair\\n");const r=spawnSync(process.execPath,["--test","/workspace/add.test.mjs"],{stdio:"inherit"});process.exit(r.status??1)'])
    state.remoteExitCode = result.exitCode
    if (result.exitCode !== 0 || result.error) throw failure('remote_test_failed')
    save()
    return JSON.stringify({ action, exitCode: result.exitCode, output: result.output })
  }
  if (action === 'fail') {
    const result = await run('explicit-failure', ['node', '-e', 'import{appendFileSync}from"node:fs";appendFileSync("/workspace/actions.txt","fail\\n");console.error("synthetic command failed");process.exit(7)'])
    state.remoteExitCode = result.exitCode; save()
    throw failure(result.exitCode === 7 ? 'remote_command_failed' : 'failure_probe_mismatch')
  }
  const sentinel = 'import{spawn}from"node:child_process";import{writeFileSync,appendFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});appendFileSync("/workspace/actions.txt","wait\\n");appendFileSync("/workspace/starts.txt","start\\n");writeFileSync("/workspace/pids.json",JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);'
  const active = await run('cancel-parent-and-child', ['node', '-e', sentinel], { background: true, timeoutSeconds: 120 })
  if (!active.id) throw failure('execution_id_missing')
  let ready = false
  for (let i = 0; i < 30; i++) {
    try { if (await sandbox.files.readFile('/workspace/starts.txt') === 'start\n') { ready = true; break } }
    catch (error) { if (error.statusCode !== 404) throw error }
    await delay(100)
  }
  if (!ready || !(await sandbox.commands.getCommandStatus(active.id)).running) throw failure('cancel_execution_not_ready')
  const alive = await run('confirm-cancel-parent-and-child-alive', ['node', '-e', processProbeSource('alive')])
  if (alive.exitCode !== 0 || alive.error) throw failure('cancel_descendants_not_alive')
  state.parentAndChildAliveBeforeCancel = true
  state.runningBeforeCancel = true; save()
  try {
    await new Promise((done, reject) => {
      const onAbort = () => { state.signalObserved = true; save(); clearTimeout(timer); done() }
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); reject(failure('cancel_signal_missing')) }, 5000)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      else onStarted()
    })
  } finally {
    // A DSH abort is only a request; prove remote quiescence separately.
    await sandbox.commands.interrupt(active.id)
    state.remoteStopped = (await sandbox.commands.getCommandStatus(active.id)).running === false
    const stopped = await run('confirm-cancel-descendants', ['node', '-e', processProbeSource('stopped')])
    state.descendantsStopped = stopped.exitCode === 0 && !stopped.error
    save()
    if (!state.remoteStopped || !state.descendantsStopped) throw failure('remote_cancellation_unconfirmed')
  }
  signal.throwIfAborted()
  throw failure('cancel_signal_missing')
}
