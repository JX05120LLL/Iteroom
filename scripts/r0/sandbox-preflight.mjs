import { lstat, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { runBounded, controlledEnv, failure } from './ocr-process.mjs'

export const SANDBOX_PIN = Object.freeze({ sourceCommit: '4a5619524650ff7c2cbaf59626df822fce72b161',
  sdkVersion: '1.1.0', sdkIntegrity: 'sha512-Q2d0l8UYajN72AHQxYAU8BCXQxhTyHOJF/5b06A53kAZTcsCmNcQnKaoxAATgH15SCSGFtxuje42DHzrjwYDYA==' })
export async function validatePocRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw failure('unmanaged_sandbox_poc')
  const root = resolve(value)
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('iteroom-r0-sandbox-')) throw failure('unmanaged_sandbox_poc')
  const paths = [root, join(root, 'sdk'), join(root, 'sdk/node_modules'),
    join(root, 'sdk/node_modules/@alibaba-group'), join(root, 'sdk/node_modules/@alibaba-group/opensandbox'),
    join(root, 'sdk/node_modules/@alibaba-group/opensandbox/dist')]
  for (const path of paths) {
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw failure('unmanaged_sandbox_poc')
    } catch (error) { if (error.code !== 'ENOENT') throw error; break }
  }
  return root
}

// Read-only prerequisites: no create/kill/pull, no model or remote API calls.
export async function inspectSandboxPreflight(value) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), pin: SANDBOX_PIN,
    evidenceKind: 'actual-installed-sdk-and-runtime-preflight',
    environment: { platform: process.platform, node: process.version }, gateC: 'not_completed',
    sdkInstalled: false, serverInstalled: false, dockerAvailable: false, actualSandboxCreated: false,
    modelCalled: false, userSourceRead: false, unverified: ['image-digests', 'create-ready-import-edit-test-export-delete',
      'foreground-background-descendant-cancellation', 'disconnect-ttl-server-restart-cleanup-failure',
      'actual-network-and-mount-isolation'] }
  let root
  try { root = await validatePocRoot(value) }
  catch (error) { return { ...report, status: 'unavailable', errorCode: error.code ?? 'invalid_poc_root' } }
  const pkgRoot = join(root, 'sdk/node_modules/@alibaba-group/opensandbox')
  try {
    const manifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
    const lock = JSON.parse(await readFile(join(root, 'sdk/package-lock.json'), 'utf8'))
    if (manifest.name !== '@alibaba-group/opensandbox' || manifest.version !== SANDBOX_PIN.sdkVersion
      || lock.packages['node_modules/@alibaba-group/opensandbox']?.integrity !== SANDBOX_PIN.sdkIntegrity) throw failure('sandbox_sdk_mismatch')
    const { Sandbox, SandboxManager, ConnectionConfig } = await import(pathToFileURL(join(pkgRoot, 'dist/index.js')).href)
    if (['create', 'connect'].some(name => typeof Sandbox[name] !== 'function')
      || ['waitUntilReady', 'kill', 'close'].some(name => typeof Sandbox.prototype[name] !== 'function')
      || typeof SandboxManager.create !== 'function') throw failure('sandbox_contract_mismatch')
    const connection = new ConnectionConfig({ domain: '127.0.0.1:3088', protocol: 'http',
      apiKey: 'synthetic-no-network-key', useServerProxy: true, disableMetrics: true, requestTimeoutSeconds: 5 })
    const manager = SandboxManager.create({ connectionConfig: connection })
    try {
      if (!connection.disableMetrics || connection.getBaseUrl() !== 'http://127.0.0.1:3088/v1'
        || ['listSandboxInfos', 'getSandboxInfo', 'killSandbox'].some(name => typeof manager[name] !== 'function')) throw failure('sandbox_contract_mismatch')
    } finally { await manager.close(); await connection.closeTransport() }
    Object.assign(report, { sdkInstalled: true, sdkVersion: manifest.version, sdkPublicContracts: true, sdkTelemetryDisabled: true })
  } catch (error) { return { ...report, status: 'unavailable', errorCode: error.code === 'ENOENT' ? 'sdk_unavailable' : error.code ?? 'sdk_probe_failed' } }
  const env = controlledEnv(join(root, 'home'))
  try {
    const code = 'import json,importlib.metadata; from opensandbox_server.config import load_config; c=load_config(); print(json.dumps(dict(version=importlib.metadata.version("opensandbox-server"),loopback=c.server.host=="127.0.0.1",port=c.server.port,authenticated=bool(c.server.api_key),networkMode=c.docker.network_mode,publishLoopback=c.docker.publish_host=="127.0.0.1",hostMountsAllowed=bool(c.storage.allowed_host_paths),noNewPrivileges=c.docker.no_new_privileges,pidsLimit=c.docker.pids_limit,portRangeSize=c.docker.port_range_max-c.docker.port_range_min+1,egressMode=c.egress.mode)))'
    const result = await runBounded(join(root, 'venv/Scripts/python.exe'), ['-c', code], {
      cwd: root, env: { ...env, SANDBOX_CONFIG_PATH: join(root, 'r0.toml'), PYTHONUTF8: '1' }, timeoutMs: 10000 })
    const config = JSON.parse(result.stdout)
    if (!config.version.includes('g4a5619524') || !config.loopback || !config.authenticated || config.port !== 3088
      || config.networkMode !== 'bridge' || !config.publishLoopback || config.hostMountsAllowed
      || !config.noNewPrivileges || config.pidsLimit !== 128 || config.portRangeSize < 100) throw failure('sandbox_configuration_mismatch')
    Object.assign(report, { serverInstalled: true, serverConfiguration: config })
  } catch (error) { return { ...report, status: 'unavailable', errorCode: error.code ?? 'server_probe_failed' } }
  try {
    const result = await runBounded('docker', ['-H', 'npipe:////./pipe/dockerDesktopLinuxEngine', 'version', '--format', '{{json .Server.Version}}'], {
      cwd: root, env, timeoutMs: 5000 })
    const version = JSON.parse(result.stdout)
    if (typeof version !== 'string' || !version) throw failure('docker_unavailable')
    report.dockerAvailable = true; report.dockerVersion = version
  } catch (error) { return { ...report, status: 'unavailable', errorCode: 'docker_unavailable', dockerProbeError: error.code ?? 'runtime_error' } }
  return { ...report, status: 'ready_for_poc' }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await inspectSandboxPreflight(process.env.ITEROOM_SANDBOX_POC_ROOT)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exitCode = report.status === 'ready_for_poc' ? 0 : 1
}
