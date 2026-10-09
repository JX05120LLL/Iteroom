import { useEffect, useRef, useState, type FormEvent } from 'react'
import styles from './managed-understand.module.css'
import { ManagedRuntimeStatus } from './managed-runtime-status.js'

interface Reference { path: string; snapshotId: string; sha256: string; startLine: number; endLine: number }
interface ManagedTask {
  id: string; kind: string; objective: string; paths: string[]; status: string; engineStatus: string
  snapshotId?: string | null; answer?: string; draft?: string; references?: Reference[]; failureCode?: string
  createdAt: string
}
interface Source { text: string; path: string; snapshotId: string; sha256: string }
interface TaskEvent { seq: number; type: string; status: string; at: string }

const API = '/api/iteroom/managed-tasks'
const labels: Record<string, string> = {
  queued: '待启动', running: '正在理解', cancelling: '正在停止',
  completed: '已完成', failed: '执行失败', cancelled: '已停止', interrupted: '执行中断',
}
const errors: Record<string, string> = {
  MODEL_NOT_CONFIGURED: '尚未配置 DeepSeek 凭证。请在本机设置 DEEPSEEK_API_KEY 或 ITEROOM_MODEL_KEY_FILE 后重启 Iteroom。',
  ACTIVE_TASK_EXISTS: '已有未结束的任务。', RUN_ALREADY_STARTED: '这项任务已经启动，不会重复请求模型。',
  READ_INPUT_CHANGED: '选定文件在固定输入前发生变化。请检查任务范围。',
  READ_LINK_DENIED: '选定路径含链接，已拒绝读取。', READ_TOO_LARGE: '选定文件超过 256 KiB。',
  READ_NOT_TEXT: '选定文件不是可用的 UTF-8 文本。', MODEL_REQUEST_LIMIT: '本次模型请求次数已达上限。',
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body: unknown = await response.json()
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
      ? body.code : `HTTP ${response.status}`
    throw new Error(errors[code] ?? `请求失败（${code}）`)
  }
  return body as T
}

function post<T>(action: string, body: unknown) {
  return api<T>(`/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })
}

export function ManagedUnderstand() {
  const [tasks, setTasks] = useState<ManagedTask[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [objective, setObjective] = useState('')
  const [paths, setPaths] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<Source | null>(null)
  const [highlight, setHighlight] = useState<Reference | null>(null)
  const [events, setEvents] = useState<TaskEvent[]>([])
  const createId = useRef<string | null>(null)
  const runIds = useRef(new Map<string, string>())
  const cancelIds = useRef(new Map<string, string>())

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const result = await api<{ tasks: ManagedTask[] }>('')
        if (!active) return
        const ownTasks = result.tasks.filter(task => task.kind === 'understand')
        setTasks(ownTasks)
        setSelectedId(current => current ?? ownTasks[0]?.id ?? null)
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '无法读取任务')
      } finally {
        if (active) timer = setTimeout(refresh, 1200)
      }
    }
    void refresh()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    let active = true
    let cursor = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setEvents([]); setSource(null); setHighlight(null)
    const refresh = async () => {
      try {
        const after = cursor
        const query = new URLSearchParams({ taskId: selectedId, after: String(after) })
        const result = await api<{ events: TaskEvent[]; cursor: number }>(`/events?${query}`)
        if (!active) return
        setEvents(current => [...current, ...result.events.filter(item => item.seq > after)])
        cursor = result.cursor
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : '无法读取任务进度')
      } finally {
        if (active) timer = setTimeout(refresh, 1200)
      }
    }
    void refresh()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [selectedId])

  const selected = tasks.find(task => task.id === selectedId) ?? null
  const activeTask = tasks.some(task => ['queued', 'running', 'cancelling'].includes(task.status))
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void act(async () => {
      const selectedPaths = paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean)
      const requestId = createId.current ??= crypto.randomUUID()
      const result = await post<{ task: ManagedTask }>('create', {
        requestId, kind: 'understand', objective: objective.trim(), paths: selectedPaths,
      })
      setSelectedId(result.task.id)
      setTasks(current => [result.task, ...current.filter(task => task.id !== result.task.id)])
      createId.current = null
      setObjective(''); setPaths('')
    })
  }
  const start = (task: ManagedTask) => void act(async () => {
    const requestId = runIds.current.get(task.id) ?? crypto.randomUUID()
    runIds.current.set(task.id, requestId)
    const result = await post<{ task: ManagedTask }>('start', { taskId: task.id, requestId })
    setTasks(current => current.map(item => item.id === task.id ? result.task : item))
  })
  const cancel = (task: ManagedTask) => void act(async () => {
    const requestId = cancelIds.current.get(task.id) ?? crypto.randomUUID()
    cancelIds.current.set(task.id, requestId)
    const result = await post<{ task: ManagedTask }>('cancel', { taskId: task.id, requestId })
    setTasks(current => current.map(item => item.id === task.id ? result.task : item))
  })
  const showSource = (task: ManagedTask, reference: Reference) => void act(async () => {
    const query = new URLSearchParams({ taskId: task.id, path: reference.path })
    const result = await api<Source>(`/source?${query}`)
    if (result.snapshotId !== reference.snapshotId || result.sha256 !== reference.sha256) {
      throw new Error('引用与固定输入不一致，已停止展示。')
    }
    setSource(result); setHighlight(reference)
  })

  const lines = source?.text.split('\n') ?? []
  if (lines.at(-1) === '') lines.pop()
  const from = highlight ? Math.max(1, highlight.startLine - 6) : 1
  const to = highlight ? Math.min(lines.length, highlight.endLine + 6) : 0
  const createForm = <form className={styles.form} onSubmit={create}>
    <div className={styles.formTitle}><h3>新建理解任务</h3><span>一次只处理一个任务</span></div>
    <label htmlFor="iteroom-objective">想了解什么</label>
    <textarea id="iteroom-objective" value={objective} onChange={event => setObjective(event.target.value)}
      maxLength={500} rows={3} placeholder="例如：解释这个模块如何处理错误，以及入口在哪里" disabled={busy} required />
    <label htmlFor="iteroom-paths">文件路径</label>
    <textarea id="iteroom-paths" value={paths} onChange={event => setPaths(event.target.value)}
      rows={3} placeholder={'src/index.ts\nsrc/utils.ts'} disabled={busy} required />
    <p className={styles.hint}>每行一个项目相对路径，最多 16 个。启动后，选定文件的片段会发送给配置的模型；本任务不提供写入或命令工具。</p>
    <button className={styles.primary} type="submit" disabled={busy}>创建任务</button>
  </form>

  return <section className={styles.panel} data-iteroom-managed-understand="true" aria-label="受管代码理解">
    <header className={styles.header}>
      <div><span className={styles.kicker}>ITEROOM / UNDERSTAND</span><h2>代码理解</h2></div>
      <p>选定文件 · 固定输入 · 只读推理</p>
    </header>
    <div className={styles.layout}>
      <div className={styles.main}>
        <ManagedRuntimeStatus kind="understand" />
        {error && <div className={styles.error} role="alert">{error}</div>}
        {tasks.length > 1 && <nav className={styles.history} aria-label="理解任务历史">
          {tasks.map(task => <button type="button" key={task.id} aria-current={selectedId === task.id ? 'page' : undefined}
            onClick={() => setSelectedId(task.id)}>
            <span>{task.objective}</span><small>{labels[task.status] ?? '状态未知'}</small>
          </button>)}
        </nav>}
        {selected && <article className={styles.task}>
          <div className={styles.taskTop}><span className={styles.taskLabel}>当前任务</span>
            <span className={styles.status} data-status={selected.status}>{labels[selected.status] ?? '状态未知'}</span></div>
          <h3>{selected.objective}</h3>
          <ul className={styles.pathList}>{selected.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
          {selected.status === 'queued' && <div className={styles.actions}>
            <button className={styles.primary} type="button" disabled={busy} onClick={() => start(selected)}>固定输入并开始理解</button>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => cancel(selected)}>取消任务</button>
            <span>将向 DeepSeek 发送本任务选定的代码片段</span>
          </div>}
          {['running', 'cancelling'].includes(selected.status) && <div className={styles.actions}>
            <span role="status">{selected.status === 'cancelling' ? '正在确认推理进程已停止…' : '正在读取固定输入并生成回答…'}</span>
            <button className={styles.secondary} type="button" disabled={busy || selected.status === 'cancelling'} onClick={() => cancel(selected)}>停止</button>
          </div>}
          {selected.status === 'running' && selected.draft && <div className={styles.draft} aria-label="生成中的模型片段">
            <h4>生成中 · 尚未核实</h4><p>{selected.draft}</p>
          </div>}
          {selected.status === 'completed' && <div className={styles.result}>
            <div className={styles.resultHead}><h4>回答</h4><span>模型解释，来源见下方实际读取记录</span></div>
            <p>{selected.answer}</p>
            <h4>读取的固定范围</h4>
            <div className={styles.references}>{selected.references?.map((reference, index) =>
              <button key={`${reference.path}-${index}`} type="button" onClick={() => showSource(selected, reference)}>
                {reference.path}:{reference.startLine}{reference.endLine !== reference.startLine ? `–${reference.endLine}` : ''}
              </button>)}</div>
          </div>}
          {['failed', 'interrupted', 'cancelled'].includes(selected.status) &&
            <p className={styles.failure}>{selected.status === 'cancelled'
              ? selected.engineStatus === 'not_started' ? '任务已取消，未启动推理。' : '任务已停止。' : '本次没有可确认的回答。'}
              {selected.failureCode ? ` 原因：${selected.failureCode}` : ''} 不会自动重发模型请求。</p>}
          {events.length > 0 && <div className={styles.timeline} aria-label="任务进度">
            {events.map(event => <span key={event.seq}>{event.seq}. {event.type === 'snapshot' ? '输入已固定'
              : event.type === 'draft' ? '收到模型片段'
                : event.type === 'baseline' ? `已有状态：${labels[event.status] ?? '未知'}` : labels[event.status] ?? event.type}</span>)}
          </div>}
        </article>}
        {!activeTask && createForm}
      </div>
      <aside className={styles.aside} aria-label="固定来源">
        <div className={styles.asideHead}><span className={styles.kicker}>SOURCE</span><h3>固定来源</h3></div>
        {source && highlight ? <><div className={styles.sourceMeta}><code>{source.path}</code><span>第 {highlight.startLine}–{highlight.endLine} 行</span></div>
          <pre className={styles.code}>{lines.slice(from - 1, to).map((line, index) =>
            <span key={from + index} className={from + index >= highlight.startLine && from + index <= highlight.endLine ? styles.selectedLine : ''}>
              <em>{from + index}</em>{line || ' '}{'\n'}
            </span>)}</pre></> : <p className={styles.emptySource}>完成任务后，点击来源路径查看固定快照中的对应行。</p>}
      </aside>
    </div>
  </section>
}
