import { useEffect, useRef, useState, type FormEvent } from 'react'
import styles from './managed-understand.module.css'

interface Execution { id: string; kind: string; command: string; status: string; exitCode?: number | null; outputBytes?: number; outputExcerpt?: string }
interface Task { id: string; kind: string; objective: string; paths: string[]; status: string;
  sandboxStatus?: string; failureCode?: string; executions?: Execution[]; changeCount?: number; artifactId?: string;
  acceptance?: { entries: Array<{ path: string; state: string }> } }
interface Artifact { patch: string; sha256: string; changes: Array<{ path: string; kind: string; beforeSha256: string; afterSha256: string }> }
interface Preview { files: Array<{ path: string; status: 'ready' | 'applied' | 'conflict' }>; verification: Execution | null }
const API = '/api/iteroom/managed-tasks'
const labels: Record<string, string> = { queued: '待启动', running: '隔离执行中', cancelling: '确认停止中',
  awaiting_review: '待审阅补丁', applying: '写回中', completed: '已接受', discarded: '已放弃',
  failed: '执行失败', cancelled: '已停止', interrupted: '执行状态待核对', deleting: '历史清理中' }
const messages: Record<string, string> = {
  SANDBOX_NOT_CONFIGURED: '沙箱未配置。请在本机设置 ITEROOM_SANDBOX_KEY_FILE 和 ITEROOM_SANDBOX_IMAGE 后重启。',
  MODEL_NOT_CONFIGURED: 'DeepSeek 凭证未配置。', ACTIVE_TASK_EXISTS: '已有未结束的任务。',
  RUN_ALREADY_STARTED: '该任务已经启动，不会自动重试。', SANDBOX_TEST_SCOPE_DENIED: '请选择至少一个源文件和一个 .test.mjs 测试文件。',
  ACCEPT_CONFLICT: '本地目标文件已变化或路径不安全。没有继续覆盖；请导出补丁并检查文件。',
  ACCEPT_STATE_CONFLICT: '当前任务不能执行该决定；请刷新任务状态。',
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store', ...init })
  const body: unknown = await response.json()
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string'
      ? body.code : `HTTP ${response.status}`
    throw new Error(messages[code] ?? `请求失败（${code}）`)
  }
  return body as T
}
function post<T>(action: string, body: unknown) {
  return api<T>(`/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export function ManagedModify() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [objective, setObjective] = useState('')
  const [paths, setPaths] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const createId = useRef<string | null>(null)
  const runIds = useRef(new Map<string, string>())
  const cancelIds = useRef(new Map<string, string>())
  const decisionIds = useRef(new Map<string, string>())
  const deleteIds = useRef(new Map<string, string>())

  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const result = await api<{ tasks: Task[] }>('')
        if (!active) return
        const own = result.tasks.filter(task => task.kind === 'modify')
        setTasks(own)
        setSelectedId(current => current ?? own[0]?.id ?? null)
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '任务读取失败') }
      finally { if (active) timer = setTimeout(refresh, 1200) }
    }
    void refresh()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [])

  const selected = tasks.find(task => task.id === selectedId) ?? null
  useEffect(() => {
    setArtifact(null); setPreview(null)
    if (!selected?.artifactId) return
    let active = true
    const query = new URLSearchParams({ taskId: selected.id })
    void Promise.all([api<{ artifact: Artifact }>(`/modify/artifact?${query}`),
      api<Preview>(`/modify/preview?${query}`)]).then(([result, check]) => {
      if (active) { setArtifact(result.artifact); setPreview(check) }
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '补丁读取失败') })
    return () => { active = false }
  }, [selected?.id, selected?.status, selected?.artifactId])

  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void act(async () => {
      const requestId = createId.current ??= crypto.randomUUID()
      const result = await post<{ task: Task }>('create', { requestId, kind: 'modify', objective: objective.trim(),
        paths: paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean) })
      setTasks(current => [result.task, ...current.filter(item => item.id !== result.task.id)])
      setSelectedId(result.task.id); setObjective(''); setPaths(''); createId.current = null
    })
  }
  const start = (task: Task) => void act(async () => {
    const requestId = runIds.current.get(task.id) ?? crypto.randomUUID()
    runIds.current.set(task.id, requestId)
    const result = await post<{ task: Task }>('modify/start', { taskId: task.id, requestId })
    setTasks(current => current.map(item => item.id === task.id ? result.task : item))
  })
  const cancel = (task: Task) => void act(async () => {
    const requestId = cancelIds.current.get(task.id) ?? crypto.randomUUID()
    cancelIds.current.set(task.id, requestId)
    const result = await post<{ task: Task }>('modify/cancel', { taskId: task.id, requestId })
    setTasks(current => current.map(item => item.id === task.id ? result.task : item))
  })
  const reconcile = (task: Task) => void act(async () => {
    const result = await post<{ task: Task }>('modify/reconcile', { taskId: task.id, requestId: crypto.randomUUID() })
    setTasks(current => current.map(item => item.id === task.id ? result.task : item))
  })
  const decide = (task: Task, action: 'accept' | 'discard' | 'recover', mode?: 'finish' | 'rollback') => void act(async () => {
    const key = `${task.id}:${action}:${mode ?? ''}`
    const requestId = decisionIds.current.get(key) ?? crypto.randomUUID()
    decisionIds.current.set(key, requestId)
    const result = await post<{ task: Task }>(`modify/${action}`, { taskId: task.id, requestId, ...(mode ? { mode } : {}) })
    setTasks(current => current.map(item => item.id === task.id ? result.task : item))
  })
  const deleteHistory = (task: Task) => {
    if (task.status !== 'deleting' && !window.confirm('删除此任务的历史、快照和候选补丁？请先导出需要保留的补丁。此操作不会修改项目源码。')) return
    void act(async () => {
      const requestId = deleteIds.current.get(task.id) ?? crypto.randomUUID()
      deleteIds.current.set(task.id, requestId)
      await post('history/delete', { taskId: task.id, requestId })
      setTasks(current => current.filter(item => item.id !== task.id))
      setSelectedId(null)
    })
  }
  const download = () => {
    if (!artifact || !selected) return
    const url = URL.createObjectURL(new Blob([artifact.patch], { type: 'text/x-patch' }))
    const link = document.createElement('a')
    link.href = url; link.download = `iteroom-${selected.id}.patch`; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const activeTask = tasks.some(task => ['queued', 'running', 'cancelling', 'applying'].includes(task.status)
    || task.status === 'interrupted' && !!task.acceptance)
  return <section className={styles.panel} data-iteroom-managed-modify="true" aria-label="受管隔离修改">
    <header className={styles.header}>
      <div><span className={styles.kicker}>ITEROOM / MODIFY</span><h2>隔离修改</h2></div>
      <p>固定输入 · 沙箱验证 · 审阅补丁</p>
    </header>
    <div className={styles.layout}>
      <div className={styles.main}>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {tasks.length > 1 && <nav className={styles.history} aria-label="修改任务历史">{tasks.map(task =>
          <button type="button" key={task.id} aria-current={selectedId === task.id ? 'page' : undefined}
            onClick={() => setSelectedId(task.id)}><span>{task.objective}</span><small>{labels[task.status] ?? task.status}</small></button>)}</nav>}
        {selected && <article className={styles.task}>
          <div className={styles.taskTop}><span className={styles.taskLabel}>当前任务</span>
            <span className={styles.status} data-status={selected.status}>{labels[selected.status] ?? selected.status}</span></div>
          <h3>{selected.objective}</h3>
          <ul className={styles.pathList}>{selected.paths.map(path => <li key={path}><code>{path}</code></li>)}</ul>
          {selected.status === 'queued' && <div className={styles.actions}>
            <button className={styles.primary} type="button" disabled={busy} onClick={() => start(selected)}>固定输入并在沙箱执行</button>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => cancel(selected)}>放弃待启动任务</button>
            <span>仅选定的代码和任务文本会发送给 DeepSeek；测试在隔离环境执行。</span>
          </div>}
          {['running', 'cancelling'].includes(selected.status) && <div className={styles.actions}>
            <span role="status">{selected.status === 'cancelling' ? '正在核对沙箱执行已停止…' : '正在隔离环境中修改与测试…'}</span>
            <button className={styles.secondary} type="button" disabled={busy || selected.status === 'cancelling'} onClick={() => cancel(selected)}>停止</button>
          </div>}
          {selected.executions?.length ? <div className={styles.result}>
            <h4>实际执行</h4>{selected.executions.map(execution => <div key={execution.id}>
              <p><code>{execution.command}</code> · {execution.status} · 退出码 {execution.exitCode ?? '未知'}</p>
              {execution.outputExcerpt && <pre className={styles.code}>{execution.outputExcerpt}{(execution.outputBytes ?? 0) > new TextEncoder().encode(execution.outputExcerpt).length ? '\n…日志已截断' : ''}</pre>}
            </div>)}</div> : null}
          {selected.artifactId && <div className={styles.result}>
            <h4>候选补丁</h4><p>{selected.changeCount} 个选定文件发生变化；接受不会自动提交 Git。</p>
            {preview && <><p>写回前文件状态：{preview.files.map(file => `${file.path}（${file.status === 'ready' ? '与快照一致' : file.status === 'applied' ? '已写入' : '冲突'}）`).join(' · ')}</p>
              <p>最近一次测试：{preview.verification ? `${preview.verification.status} · 退出码 ${preview.verification.exitCode ?? '未知'}` : '无证据'}</p></>}
            <div className={styles.actions}>
              <button className={styles.secondary} type="button" disabled={!artifact} onClick={download}>导出 .patch</button>
              {selected.status === 'awaiting_review' && <>
                <button className={styles.primary} type="button" disabled={busy || !preview || preview.files.some(file => file.status !== 'ready')}
                  onClick={() => decide(selected, 'accept')}>接受并写回本地文件</button>
                <button className={styles.secondary} type="button" disabled={busy} onClick={() => decide(selected, 'discard')}>放弃候选补丁</button>
              </>}
              {selected.status === 'interrupted' && selected.acceptance && <>
                <button className={styles.primary} type="button" disabled={busy || !preview || preview.files.some(file => file.status === 'conflict')}
                  onClick={() => decide(selected, 'recover', 'finish')}>核对后继续写回</button>
                <button className={styles.secondary} type="button" disabled={busy || !preview || preview.files.some(file => file.status === 'conflict')}
                  onClick={() => decide(selected, 'recover', 'rollback')}>核对后撤销已写入</button>
              </>}
            </div>
          </div>}
          {['failed', 'cancelled', 'interrupted'].includes(selected.status) && <p className={styles.failure}>
            {selected.failureCode ?? '执行未完成'} · 沙箱状态：{selected.sandboxStatus ?? '未分配'}。未知动作不会自动重放。</p>}
          {selected.sandboxStatus === 'cleanup_pending' && <div className={styles.actions}>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => reconcile(selected)}>重新核对并清理沙箱</button>
          </div>}
          {['completed', 'discarded', 'failed', 'cancelled', 'interrupted', 'awaiting_review', 'deleting'].includes(selected.status)
            && selected.sandboxStatus !== 'cleanup_pending' && !(selected.status === 'interrupted' && selected.acceptance)
            && <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy}
              onClick={() => deleteHistory(selected)}>{selected.status === 'deleting' ? '继续清理历史' : '删除任务历史'}</button></div>}
        </article>}
        {!activeTask && <form className={styles.form} onSubmit={create}>
          <div className={styles.formTitle}><h3>新建修改任务</h3><span>一次只处理一个任务</span></div>
          <label htmlFor="iteroom-modify-objective">要修改什么</label>
          <textarea id="iteroom-modify-objective" value={objective} onChange={event => setObjective(event.target.value)}
            maxLength={500} rows={3} placeholder="例如：修复 greet 的返回值，使现有测试通过" disabled={busy} required />
          <label htmlFor="iteroom-modify-paths">源文件与测试文件</label>
          <textarea id="iteroom-modify-paths" value={paths} onChange={event => setPaths(event.target.value)}
            rows={3} placeholder={'src/greet.mjs\nsrc/greet.test.mjs'} disabled={busy} required />
          <p className={styles.hint}>每行一个现有 UTF-8 文件；至少一个源文件与一个 .test.mjs 测试文件。仅源文件可在沙箱替换，测试文件固定。当前不支持新增、删除或重命名。</p>
          <button className={styles.primary} type="submit" disabled={busy}>创建修改任务</button>
        </form>}
      </div>
      <aside className={styles.aside} aria-label="候选补丁预览">
        <div className={styles.asideHead}><span className={styles.kicker}>PATCH</span><h3>候选补丁</h3></div>
        {artifact ? <><p>{artifact.changes.map(change => change.path).join(' · ')}</p>
          <pre className={styles.code}>{artifact.patch}</pre></> : <p className={styles.emptySource}>完成沙箱修改与验证后，在这里审阅相对于固定输入的补丁。</p>}
      </aside>
    </div>
  </section>
}
