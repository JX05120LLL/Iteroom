import { useEffect, useId, useState } from 'react'
import styles from './task-review.module.css'

export interface TaskActivity {
  kind: string
  label: string
  at: string
}

export interface TaskVerification {
  command: string
  cwd?: string
  status: string
  exitCode?: number
  summary?: string
}

export interface TaskChange {
  path: string
  status: string
  priorChange: boolean | string
  diff: string | null
}

export interface Task {
  id: string
  sessionId: string
  cwd: string
  status: string
  evidenceStatus?: 'pending' | 'available' | 'unavailable'
  prompt?: string
  startedAt: string
  endedAt?: string
  requestId?: string
  activities: TaskActivity[]
  verification: TaskVerification[]
  changes: TaskChange[]
  warnings: string[]
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

const STATUS: Record<string, { label: string; tone: string }> = {
  queued: { label: '等待执行', tone: styles.toneWaiting },
  waiting: { label: '等待输入', tone: styles.toneWaiting },
  running: { label: '执行中', tone: styles.toneRunning },
  cancelling: { label: '正在停止', tone: styles.toneWaiting },
  cancelled: { label: '已停止', tone: styles.toneNeutral },
  completed: { label: '已完成', tone: styles.toneDone },
  failed: { label: '执行失败', tone: styles.toneFailed },
}

const CHANGE_STATUS: Record<string, string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  'type-changed': '类型变化',
  unknown: '无法确认',
  renamed: '重命名',
  copied: '复制',
  untracked: '未跟踪',
}

function readableTime(value?: string): string {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<Task>
  return typeof task.id === 'string'
    && typeof task.sessionId === 'string'
    && typeof task.cwd === 'string'
    && typeof task.status === 'string'
    && (task.prompt === undefined || typeof task.prompt === 'string')
    && (task.evidenceStatus === undefined || ['pending', 'available', 'unavailable'].includes(task.evidenceStatus))
    && typeof task.startedAt === 'string'
    && Array.isArray(task.activities)
    && task.activities.every((activity: unknown) => activity !== null && typeof activity === 'object'
      && typeof (activity as TaskActivity).kind === 'string'
      && typeof (activity as TaskActivity).label === 'string'
      && typeof (activity as TaskActivity).at === 'string')
    && Array.isArray(task.verification)
    && task.verification.every((entry: unknown) => entry !== null && typeof entry === 'object'
      && typeof (entry as TaskVerification).command === 'string'
      && ((entry as TaskVerification).cwd === undefined || typeof (entry as TaskVerification).cwd === 'string')
      && typeof (entry as TaskVerification).status === 'string')
    && Array.isArray(task.changes)
    && task.changes.every((change: unknown) => change !== null && typeof change === 'object'
      && typeof (change as TaskChange).path === 'string'
      && typeof (change as TaskChange).status === 'string'
      && ((change as TaskChange).diff === null || typeof (change as TaskChange).diff === 'string'))
    && Array.isArray(task.warnings)
    && task.warnings.every((warning: unknown) => typeof warning === 'string')
}

function hasPriorChange(value: TaskChange['priorChange']): boolean {
  return value === true || (typeof value === 'string' && value !== '' && value !== 'none' && value !== 'false')
}

function verificationTone(status: string): { label: string; tone: string } {
  switch (status) {
    case 'passed':
    case 'success':
    case 'succeeded':
      return { label: '通过', tone: styles.toneDone }
    case 'failed':
    case 'error':
      return { label: '失败', tone: styles.toneFailed }
    case 'running':
      return { label: '执行中', tone: styles.toneRunning }
    case 'out-of-scope':
      return { label: '非本项目', tone: styles.toneNeutral }
    default:
      return { label: '结果未知', tone: styles.toneNeutral }
  }
}

function Diff({ text }: { text: string | null }) {
  if (!text) return <p className={styles.muted}>当前没有可展示的文本 Diff。二进制或超出大小限制的文件可能需要在本地查看。</p>
  return (
    <pre className={styles.diff} aria-label="文件差异">
      {text.split('\n').map((line, index) => {
        const lineTone = line.startsWith('+') && !line.startsWith('+++')
          ? styles.addedLine
          : line.startsWith('-') && !line.startsWith('---')
            ? styles.removedLine
            : ''
        return <span className={lineTone} key={index}>{line}</span>
      })}
    </pre>
  )
}

function TaskCard({ task, latest }: { task: Task; latest: boolean }) {
  const status = STATUS[task.status] ?? { label: '状态未知', tone: styles.toneNeutral }
  const headingId = useId()

  return (
    <article className={styles.taskCard} aria-labelledby={headingId}>
      <header className={styles.taskHeader}>
        <div className={styles.taskTitleGroup}>
          <span className={styles.eyebrow}>{latest ? '当前任务' : '历史任务'} · {readableTime(task.startedAt)}</span>
          <h3 id={headingId} className={styles.taskTitle}>{task.prompt || '文字任务'}</h3>
        </div>
        <span className={`${styles.status} ${status.tone}`} aria-live={latest ? 'polite' : undefined}>
          <span className={styles.statusDot} aria-hidden="true" />{status.label}
        </span>
      </header>

      <div className={styles.workspace}>
        <span className={styles.fieldLabel}>工作区</span>
        <code title={task.cwd}>{task.cwd || '未绑定工作区'}</code>
      </div>

      <section className={styles.block} aria-label="执行记录">
        <div className={styles.blockHeading}><h4>执行记录</h4><span>{task.activities.length} 项</span></div>
        {task.activities.length ? (
          <ol className={styles.timeline}>
            {task.activities.map((activity, index) => (
              <li key={`${activity.at}-${index}`}>
                <span className={styles.activityTime}>{readableTime(activity.at)}</span>
                <span className={styles.activityLabel}>{activity.label || '执行活动'}</span>
              </li>
            ))}
          </ol>
        ) : <p className={styles.muted}>尚无可确认的执行记录。</p>}
      </section>

      <section className={styles.block} aria-label="任务期间工作区变化">
        <div className={styles.blockHeading}><h4>任务期间工作区变化</h4><span>{task.changes.length} 个文件</span></div>
        {task.changes.length ? (
          <div className={styles.changeList}>
            {task.changes.map((change, index) => (
              <details className={styles.change} key={`${change.path}-${index}`}>
                <summary>
                  <span className={styles.changeName} title={change.path}>{change.path}</span>
                  <span className={styles.changeMeta}>{CHANGE_STATUS[change.status] ?? '状态未知'}</span>
                </summary>
                {hasPriorChange(change.priorChange) && (
                  <p className={styles.priorNote}>任务开始前已有改动，请核对归属。</p>
                )}
                <Diff text={change.diff} />
              </details>
            ))}
          </div>
        ) : <p className={styles.muted}>{task.evidenceStatus === 'unavailable'
          ? '无法取得文件差异证据，请在本地检查工作区。'
          : task.evidenceStatus === 'pending'
            ? '任务仍在执行，当前尚无可确认的工作区净变化。'
            : '当前工作区没有记录到净变化。'}</p>}
      </section>

      <section className={styles.block} aria-label="验证证据">
        <div className={styles.blockHeading}><h4>验证证据</h4><span>{task.verification.length} 条命令</span></div>
        {task.verification.length ? (
          <ul className={styles.verificationList}>
            {task.verification.map((entry, index) => {
              const result = verificationTone(entry.status)
              return (
                <li key={`${entry.command}-${index}`} className={styles.verification}>
                  <div className={styles.verificationTop}>
                    <span className={`${styles.verificationState} ${result.tone}`}>{result.label}</span>
                    {typeof entry.exitCode === 'number' && <span className={styles.exitCode}>退出码 {entry.exitCode}</span>}
                  </div>
                  <code className={styles.command}>{entry.command || '命令未记录'}</code>
                  {entry.cwd && <p className={styles.verificationCwd}>工作目录 <code>{entry.cwd}</code></p>}
                  {entry.summary && <p className={styles.verificationSummary}>{entry.summary}</p>}
                </li>
              )
            })}
          </ul>
        ) : <p className={styles.muted}>尚无可确认的命令执行结果。助手的文字说明不算验证证据。</p>}
      </section>

      {task.warnings.length > 0 && (
        <section className={styles.warning} aria-label="注意事项">
          <h4>需要留意</h4>
          <ul>{task.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </section>
      )}
    </article>
  )
}

export function TaskReview({ sessionId }: { sessionId: string | null }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    setTasks([])
    setError(null)
    if (!sessionId) {
      setLoadState('idle')
      return
    }

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    setLoadState('loading')

    const refresh = async () => {
      controller = new AbortController()
      try {
        const response = await fetch(`/api/iteroom/tasks?sessionId=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`任务数据请求失败（HTTP ${response.status}）`)
        const body: unknown = await response.json()
        if (!body || typeof body !== 'object' || !('tasks' in body) || !Array.isArray(body.tasks) || !body.tasks.every(isTask)) {
          throw new Error('任务数据格式不正确')
        }
        if (!active) return
        setTasks(body.tasks.filter((task) => task.sessionId === sessionId)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)))
        setError(null)
        setLoadState('ready')
      } catch (cause) {
        if (!active || controller?.signal.aborted) return
        setError(cause instanceof Error ? cause.message : '暂时无法读取任务数据')
        setLoadState('error')
      } finally {
        if (active) timer = setTimeout(refresh, 1800)
      }
    }

    void refresh()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      controller?.abort()
    }
  }, [sessionId, retry])

  return (
    <section className={styles.panel} aria-label="Iteroom 任务审阅" data-iteroom-task-review="true">
      <header className={styles.panelHeader}>
        <div><span className={styles.panelKicker}>ITEROOM / REVIEW</span><h2>任务审阅</h2></div>
        {sessionId && <span className={styles.liveIndicator}><span aria-hidden="true" />本机记录</span>}
      </header>

      {!sessionId ? (
        <div className={styles.empty}>
          <span className={styles.emptyNumber}>01</span>
          <h3>打开一段文字会话</h3>
          <p>进入会话后，这里会按任务列出执行记录、文件差异与验证证据。</p>
        </div>
      ) : (
        <>
          {loadState === 'loading' && <p className={styles.loading} role="status">正在读取本机会话记录…</p>}
          {error && (
            <div className={styles.error} role="alert">
              <span>{error}。{tasks.length > 0 ? '下方可能是旧数据。' : ''}</span>
              <button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button>
            </div>
          )}
          {loadState !== 'loading' && tasks.length === 0 && !error && (
            <div className={styles.empty}>
              <span className={styles.emptyNumber}>02</span>
              <h3>还没有任务记录</h3>
              <p>在当前会话发送文字任务。开始执行后，真实活动和改动会出现在这里。</p>
            </div>
          )}
          {tasks.length > 0 && (
            <div className={styles.tasks}>
              {tasks.map((task, index) => <TaskCard key={task.id} task={task} latest={index === 0} />)}
            </div>
          )}
        </>
      )}
    </section>
  )
}
