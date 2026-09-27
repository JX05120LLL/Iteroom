import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { captureWorkspace, compareWorkspace } from './workspace-evidence.js'

const FILE_VERSION = 1
const SAFE_CHECK_COMMANDS = new Set([
  'npm test', 'npm run test', 'npm run check', 'npm run build', 'npm run lint', 'npm run typecheck',
  'pnpm test', 'pnpm run test', 'pnpm run check', 'pnpm run build', 'pnpm run lint', 'pnpm run typecheck',
  'yarn test', 'yarn run test', 'yarn run check', 'yarn run build', 'yarn run lint', 'yarn run typecheck',
  'npx tsc', 'npx tsc --noEmit', 'npx vitest', 'npx vitest run', 'npx jest', 'npx eslint',
  'node --test', 'pytest', 'uv run pytest', 'ruff check .', 'uv run ruff check .',
  'mvn test', 'mvn verify', 'mvn package', 'mvn compile',
  'gradle test', 'gradle check', 'gradle build', './gradlew test', './gradlew check', './gradlew build',
  'go test', 'go test ./...', 'cargo test', 'dotnet test', 'git diff --check', 'tsc --noEmit', 'tsc --build',
])
const WORKSPACE_BOUNDARY = '仅比较 Git 可见文件的内容、类型与可执行位净变化；只变暂存状态或 Git 忽略文件不在范围内，外部编辑也可能混入。'

export function defaultTaskDataHome() {
  const configured = process.env.ITEROOM_DATA_HOME
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error('ITEROOM_DATA_HOME must be an absolute path')
    return resolve(configured)
  }
  const harnessHome = process.env.DSH_HOME
  return harnessHome && isAbsolute(harnessHome)
    ? join(resolve(harnessHome), 'iteroom')
    : join(homedir(), '.iteroom')
}

function key(sessionId, turn) { return `${sessionId}\0${turn}` }

function validIdentity(sessionId, turn) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(sessionId)
    && Number.isSafeInteger(turn) && turn >= 1
}

function safeTime(time) {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString()
}

function resultBlock(event) {
  const block = event.data?.message?.content?.[0]
  return block?.type === 'tool-result' ? block : null
}

function shellVerification(call, result, workspaceCwd) {
  if (!['bash', 'pwsh'].includes(call.name)) return null
  let args
  try { args = JSON.parse(call.arguments) } catch { return null }
  if (!args || typeof args.command !== 'string' || args.run_in_background === true) return null
  const command = args.command.trim()
  if (command.length > 64 || command !== args.command || !SAFE_CHECK_COMMANDS.has(command)) return null

  if (!isAbsolute(workspaceCwd) || args.workdir !== undefined && typeof args.workdir !== 'string') {
    return { command, status: 'unknown', summary: '无法确认检查命令的工作目录。' }
  }
  const cwd = resolve(workspaceCwd, args.workdir ?? '.')
  const relativeCwd = relative(workspaceCwd, cwd)
  const outsideWorkspace = relativeCwd === '..' || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)

  const unknown = { command, cwd, status: 'unknown', summary: '无法从工具结果确认退出状态。' }
  const block = resultBlock(result)
  const text = block?.content?.length === 1 && block.content[0].type === 'text'
    ? block.content[0].text : null
  if (block?.isError || typeof text !== 'string') return unknown
  if (/\[(?:timed out after|killed by signal:|sandbox:|approval:|output truncated;)/i.test(text)) {
    return { ...unknown, summary: '命令被中断、拒绝或输出不完整，不能确认验证结果。' }
  }
  const marker = /\n\[exit code: (\d+)\]$/.exec(text)
  const exitCode = marker ? Number(marker[1]) : 0
  if (!Number.isSafeInteger(exitCode)) return unknown
  return {
    command,
    cwd,
    status: outsideWorkspace ? 'out-of-scope' : exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    summary: outsideWorkspace
      ? '检查在当前项目之外执行，退出码不作为本项目的验证结果。'
      : 'DSH 前台 Shell 工具实际执行；这里只判断该命令的退出状态。',
  }
}

/** Fold durable DSH events into product task cards; model prose is never evidence. */
export function projectTasks(inspection, evidenceByTurn = new Map()) {
  const sessionId = inspection.meta.id
  const cwd = inspection.meta.cwd ?? ''
  const inherited = Number.isSafeInteger(inspection.inheritedEventCount) ? inspection.inheritedEventCount : 0
  const tasks = new Map()
  let activeTurn = null

  for (const event of inspection.events) {
    if (event.seq < inherited) continue
    if (event.type === 'turn/start') {
      const turn = event.data.turn
      if (!Number.isSafeInteger(turn) || turn < 1) continue
      activeTurn = turn
      tasks.set(turn, {
        id: `${sessionId}:${turn}`, sessionId, cwd, status: 'running',
        startedAt: safeTime(event.time), activities: [], verification: [], changes: [], warnings: [],
        evidenceStatus: 'unavailable',
        _calls: new Map(),
      })
      continue
    }
    const turn = event.type === 'user/message' ? activeTurn : event.data?.turn
    const task = tasks.get(turn)
    if (!task) continue

    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      if (typeof event.data.source.rpcId === 'string') task.requestId ??= event.data.source.rpcId
      const prompt = Array.isArray(event.data.content)
        ? event.data.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join(' ').replace(/\s+/g, ' ').trim()
        : ''
      if (prompt && !task.prompt) task.prompt = prompt.slice(0, 200)
    } else if (event.type === 'tool/call') {
      task._calls.set(event.data.callId, event.data)
      task.activities.push({ kind: 'tool-start', label: `调用 ${event.data.name} 工具`, at: safeTime(event.time) })
    } else if (event.type === 'tool/result') {
      const block = resultBlock(event)
      const call = block && task._calls.get(block.toolCallId)
      if (!call) continue
      task.activities.push({
        kind: block.isError ? 'tool-error' : 'tool-end',
        label: `${call.name} 工具${block.isError ? '失败' : '返回结果'}`,
        at: safeTime(event.time),
      })
      const check = shellVerification(call, event, cwd)
      if (check) task.verification.push(check)
    } else if (event.type === 'turn/end') {
      activeTurn = null
      const reason = event.data.reason?.kind
      task.endedAt = safeTime(event.time)
      task.status = reason === 'completed' ? 'completed'
        : reason === 'aborted' ? 'cancelled'
          : reason === 'blocked' ? 'waiting' : 'failed'
      if (reason === 'aborted') {
        for (const check of task.verification) {
          if (check.exitCode === 1 && check.status === 'failed') {
            check.status = 'unknown'
            check.summary = '任务被取消，退出码 1 可能来自强制终止，不能判断检查是否失败。'
          }
        }
      }
    }
  }

  return [...tasks.entries()].map(([turn, task]) => {
    const evidence = evidenceByTurn.get(turn)
    if (evidence?.baseline?.cwd && evidence.baseline.cwd !== cwd) {
      task.warnings.push('保存的工作区快照与会话工作区不一致，已隐藏差异。')
    } else if (evidence?.baseline && evidence?.final) {
      task.evidenceStatus = 'available'
      task.changes = evidence.final.changes ?? []
      task.warnings.push(...evidence.final.warnings ?? [])
    } else if (!task.endedAt && evidence?.baseline) {
      task.evidenceStatus = 'pending'
    } else if (task.endedAt && evidence?.baseline) {
      task.warnings.push('任务结束时的工作区差异未保存，无法安全还原该轮文件变化。')
    } else if (task.endedAt) {
      task.warnings.push('没有可用的任务前工作区快照，无法确认该轮文件变化。')
    }
    if (evidence?.captureError) task.warnings.push(evidence.captureError)
    if (evidence?.finalError) task.warnings.push(evidence.finalError)
    if (evidence?.baseline?.warnings) task.warnings.push(...evidence.baseline.warnings)
    task.warnings.push(WORKSPACE_BOUNDARY)
    if (!task.endedAt && evidence?.baseline) task.warnings.push('任务仍在执行，文件差异尚未固定。')
    if (!task.verification.some(check => check.status === 'passed' || check.status === 'failed')) {
      task.warnings.push('没有可确认的本项目验证命令结果。')
    }
    task.warnings = [...new Set(task.warnings)]
    delete task._calls
    return task
  }).reverse()
}

/** Stores bounded workspace snapshots only; DSH Session remains the event authority. */
export class TaskStore {
  constructor(dataHome, { capture = captureWorkspace, compare = compareWorkspace } = {}) {
    if (!isAbsolute(dataHome)) throw new Error('Task data home must be absolute')
    this.dataHome = resolve(dataHome)
    this.capture = capture
    this.compare = compare
    this.preparing = new Map()
    this.finishing = new Map()
    this.workspaceFinalizing = new Map()
    this.live = new Map()
  }

  path(sessionId, turn) {
    if (!validIdentity(sessionId, turn)) throw new Error('Invalid task identity')
    const folder = createHash('sha256').update(sessionId).digest('hex')
    return join(this.dataHome, 'tasks', folder, `${turn}.json`)
  }

  async read(sessionId, turn) {
    try {
      const record = JSON.parse(await readFile(this.path(sessionId, turn), 'utf8'))
      if (record.version !== FILE_VERSION || record.sessionId !== sessionId || record.turn !== turn) {
        throw new Error('Task evidence identity mismatch')
      }
      return record
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }

  async write(record) {
    const path = this.path(record.sessionId, record.turn)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    try { await rename(temporary, path) }
    catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  async prepare({ sessionId, turn, cwd, signal }) {
    if (!validIdentity(sessionId, turn)) return
    const id = key(sessionId, turn)
    if (this.preparing.has(id)) return this.preparing.get(id)
    const pending = (async () => {
      const previous = await this.read(sessionId, turn)
      if (previous) return previous
      const record = { version: FILE_VERSION, sessionId, turn, cwd: cwd ?? '', baseline: null }
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
        record.captureError = '会话没有有效的绝对工作区路径，无法采集任务前快照。'
      } else if (signal?.aborted) {
        record.captureError = '任务在采集工作区快照前已取消。'
      } else {
        await this.workspaceFinalizing.get(cwd)?.catch(() => {})
        try { record.baseline = await this.capture(cwd) }
        catch (error) { record.captureError = `任务前工作区快照失败：${error.message}` }
      }
      await this.write(record)
      return record
    })()
    this.preparing.set(id, pending)
    try { return await pending } finally { this.preparing.delete(id) }
  }

  async finish({ sessionId, turn, cwd }) {
    if (!validIdentity(sessionId, turn)) return
    const id = key(sessionId, turn)
    if (this.finishing.has(id)) return this.finishing.get(id)
    const priorFinalization = this.workspaceFinalizing.get(cwd)
    const pending = (async () => {
      await priorFinalization?.catch(() => {})
      await this.preparing.get(id)
      const record = await this.read(sessionId, turn)
      if (!record || record.final || record.finalError || !record.baseline?.files || record.baseline.cwd !== cwd) return
      try {
        const comparison = await this.compare(record.baseline)
        record.final = { at: new Date().toISOString(), changes: comparison.changes, warnings: comparison.warnings }
      } catch (error) {
        record.finalError = `无法读取任务结束时的工作区差异：${error.message}`
      }
      const { cwd: baselineCwd, gitRoot, capturedAt, warnings, files } = record.baseline
      record.baseline = { cwd: baselineCwd, gitRoot, capturedAt, warnings, fileCount: files.length }
      await this.write(record)
      this.live.delete(id)
    })()
    this.finishing.set(id, pending)
    if (typeof cwd === 'string') this.workspaceFinalizing.set(cwd, pending)
    try { await pending } finally {
      this.finishing.delete(id)
      if (this.workspaceFinalizing.get(cwd) === pending) this.workspaceFinalizing.delete(cwd)
    }
  }

  async tasksForInspection(inspection) {
    const sessionId = inspection?.meta?.id
    if (typeof sessionId !== 'string' || !Array.isArray(inspection.events)) throw new Error('Invalid Session inspection')
    const turns = inspection.events.filter(event => event.type === 'turn/start'
      && event.seq >= (inspection.inheritedEventCount ?? 0)).map(event => event.data.turn)
    const evidence = new Map()
    for (const turn of turns) {
      if (!validIdentity(sessionId, turn)) continue
      const id = key(sessionId, turn)
      await this.preparing.get(id)
      await this.finishing.get(id)
      const record = await this.read(sessionId, turn)
      if (record) evidence.set(turn, record)
    }
    const tasks = projectTasks(inspection, evidence)
    const active = tasks.find(task => !task.endedAt)
    if (active) {
      const turn = Number(active.id.slice(active.id.lastIndexOf(':') + 1))
      const record = evidence.get(turn)
      if (record?.baseline && record.baseline.cwd === inspection.meta.cwd) {
        const id = key(sessionId, turn)
        let cached = this.live.get(id)
        if (!cached || Date.now() - cached.time > 5000) {
          cached = { time: Date.now(), result: this.compare(record.baseline) }
          this.live.set(id, cached)
        }
        try {
          const comparison = await cached.result
          active.changes = comparison.changes
          active.warnings.push(...comparison.warnings)
          active.warnings = [...new Set(active.warnings)]
        } catch (error) {
          active.warnings.push(`当前工作区差异暂不可用：${error.message}`)
        }
      }
    }
    return tasks
  }
}
