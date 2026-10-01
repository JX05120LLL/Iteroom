import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import styles from './managed-understand.module.css'
import reviewStyles from './managed-review.module.css'
import { emptyTaskSelection, type ManagedTaskSelection } from './managed-navigation.js'

type Mode = 'workspace' | 'commit' | 'range'
interface Task { id: string; kind: string; status: string; reviewSnapshotId?: string; reviewPlanId?: string; reviewReportId?: string; reviewOutcome?: string; reviewInput: { mode: Mode }; createdAt: string; reviewFailureCode?: string; reviewCleanupPending?: boolean; failureCode?: string; recheckOrigin?: { modifyTaskId: string; artifactId: string } }
interface Side { path: string; content: string | null; contentSha256: string }
interface Entry { status: string; diff: string | null; old: Side | null; new: Side | null }
interface Coverage { path: string; status: string; side: string; oldPath: string | null; newPath: string | null; ocrExcludeReason: string | null; includedBy: string }
interface Preparation { id: string; input: { entries: Entry[]; outcome: string }; coverage: Coverage[]; ocr: { version: string; actualCli: boolean } }
interface RunCoverage { path: string; status: string; reason: string | null; groupId: number | null }
interface Plan { id: string; groups: { id: number }[]; coverage: RunCoverage[] }
interface Finding { id: string; path: string; sourcePath: string; side: 'old' | 'new'; quote: string; message: string; severity: string; location: string; startLine: number | null; endLine: number | null }
interface Report { id: string; outcome: string; coverage: RunCoverage[]; findings: Finding[] }

const API = '/api/iteroom/managed-tasks'
const modes: Record<Mode, string> = { workspace: '工作树', commit: '单提交', range: '提交范围' }
const reasons: Record<string, string> = { deleted: '删除文件：采用旧侧内容', default_path: '测试文件：显式纳入',
  secret_exclude: '敏感路径', provider_directory: '依赖目录', unsupported_ext: '不支持的文件类型',
  binary: '二进制文件', too_large: '文件过大', user_exclude: '规则排除', context_budget: '完整文件上下文超过预算',
  group_budget: '分组数量超过预算', context_not_read: '引擎未读取此组', group_not_reported: '引擎未报告此组' }
const coverageLabels: Record<string, string> = { pending: '待审', completed: '已审', failed: '失败', excluded: '已排除' }
const taskLabel = (task: Task) => task.reviewOutcome === 'partial' ? '部分完成'
  : ({ running: '审查中', cancelling: '正在停止', completed: '审查完成', failed: '审查失败', cancelled: '已取消', interrupted: '已中断' } as Record<string, string>)[task.status]
    ?? (task.reviewSnapshotId ? '已固定 · 尚未推理' : '尚未固定')
const errors: Record<string, string> = { REVIEW_CLI_UNAVAILABLE: '未配置已验证的 OpenCodeReview CLI。请设置 ITEROOM_OCR_BIN 后重启。',
  ACTIVE_TASK_EXISTS: '项目已有未结束的任务，请先结束它。', REVIEW_BINARY_MISMATCH: 'OpenCodeReview 版本或校验值不匹配。',
  REVIEW_UNSUPPORTED_GIT_CONFIG: '仓库含当前审查准备不支持的 Git 配置，已停止读取。',
  REVIEW_INPUT_LIMIT: '变更超过当前文件数或大小限制。', REVIEW_INPUT_CHANGED: '读取期间项目发生变化，请重新准备。',
  REVIEW_SNAPSHOT_INVALID: '固定输入校验失败，已停止展示。', REVIEW_PLAN_INVALID: '审查计划校验失败。',
  REVIEW_RESULT_INVALID: '审查结果校验失败。', REVIEW_NO_CONTEXT: '没有符合当前上下文预算的分组，未启动模型。',
  MODEL_NOT_CONFIGURED: '未配置 DeepSeek API Key，任务仍未启动。', REVIEW_OUTPUT_INVALID: '模型响应不符合审查契约，未生成有效发现。' }
Object.assign(errors, { REVIEW_FIX_UNSUPPORTED: '请选择已定位的新侧普通修改；当前不能直接修复旧侧、删除、重命名或测试文件候选。',
  REVIEW_FIX_INPUT_CHANGED: '当前文件已与审查输入不同，请重新固定变更并审查。',
  INVALID_REVIEW_FIX_INPUT: '请填写修复目标并选择至少一个已有测试文件。',
  HISTORY_REFERENCED: '此记录仍被修复或复查任务引用，请先删除子任务记录。' })
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(API + path, { credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok) throw Error(errors[value.code] ?? `请求失败（${value.code ?? response.status}）`)
  return value as T
}

export function ManagedReview({ openModify, selection = emptyTaskSelection }: {
  openModify?: (taskId: string) => void; selection?: ManagedTaskSelection
} = {}) {
  const [tasks, setTasks] = useState<Task[]>([]), [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('workspace'), [commit, setCommit] = useState('')
  const [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [preparation, setPreparation] = useState<Preparation | null>(null), [fileIndex, setFileIndex] = useState(0)
  const [plan, setPlan] = useState<Plan | null>(null), [report, setReport] = useState<Report | null>(null)
  const [findingId, setFindingId] = useState<string | null>(null)
  const [fixObjective, setFixObjective] = useState(''), [testPaths, setTestPaths] = useState('')
  const fixRequest = useRef<{ key: string; id: string } | null>(null)
  const requestedId = useSyncExternalStore(selection.subscribe, selection.getSnapshot)
  useEffect(() => { if (requestedId) setSelectedId(requestedId) }, [requestedId])
  const request = useRef<{ key: string; id: string } | null>(null)
  const cancelIds = useRef(new Map<string, string>())
  const startIds = useRef(new Map<string, string>())
  const refresh = async () => { const result = await api<{ tasks: Task[] }>(''); setTasks(result.tasks); return result.tasks }
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await api<{ tasks: Task[] }>('')
        if (active) { setTasks(result.tasks); setSelectedId(id => id ?? result.tasks.find(task => task.kind === 'review')?.id ?? null) }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : '无法读取任务') }
      finally { if (active) timer = setTimeout(poll, 1500) }
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [])
  const own = tasks.filter(task => task.kind === 'review'), selected = own.find(task => task.id === selectedId)
  const snapshotId = selected?.reviewSnapshotId
  useEffect(() => {
    let active = true
    setPreparation(null); setFileIndex(0); setFindingId(null)
    if (selectedId && snapshotId) void api<{ preparation: Preparation }>(`/review/preparation?${new URLSearchParams({ taskId: selectedId })}`)
      .then(result => { if (active) setPreparation(result.preparation) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '无法读取固定输入') })
    return () => { active = false }
  }, [selectedId, snapshotId])
  useEffect(() => {
    let active = true
    setPlan(null); setReport(null)
    if (selectedId && snapshotId) void api<{ plan: Plan }>(`/review/plan?${new URLSearchParams({ taskId: selectedId })}`)
      .then(result => { if (active) setPlan(result.plan) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '无法读取计划') })
    if (selectedId && selected?.reviewReportId) void api<{ result: Report }>(`/review/result?${new URLSearchParams({ taskId: selectedId })}`)
      .then(value => { if (active) setReport(value.result) })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '无法读取结果') })
    return () => { active = false }
  }, [selectedId, snapshotId, selected?.reviewPlanId, selected?.reviewReportId])
  const act = async (action: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败') }
    finally { setBusy(false) }
  }
  const prepare = (event: FormEvent) => {
    event.preventDefault()
    void act(async () => {
      const input = mode === 'workspace' ? { mode } : mode === 'commit' ? { mode, commit } : { mode, from, to }
      const key = JSON.stringify(input)
      if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
      try {
        const result = await api<{ task: Task }>('/review/prepare', { requestId: request.current.id, input })
        setSelectedId(result.task.id); request.current = null
      } finally { await refresh() }
    })
  }
  const cancel = (task: Task) => void act(async () => {
    const requestId = cancelIds.current.get(task.id) ?? crypto.randomUUID()
    cancelIds.current.set(task.id, requestId)
    await api('/review/cancel', { taskId: task.id, requestId }); await refresh()
  })
  const start = (task: Task) => void act(async () => {
    const requestId = startIds.current.get(task.id) ?? crypto.randomUUID()
    startIds.current.set(task.id, requestId)
    await api('/review/start', { taskId: task.id, requestId }); await refresh()
  })
  const remove = (task: Task) => void act(async () => {
    await api('/history/delete', { taskId: task.id, requestId: crypto.randomUUID() })
    setSelectedId(null); await refresh()
  })
  const blocking = tasks.some(task => ['queued', 'running', 'cancelling', 'awaiting_review', 'applying', 'deleting'].includes(task.status))
  const file = preparation?.input.entries[fileIndex], coverage = preparation?.coverage[fileIndex]
  const candidates = preparation?.coverage.filter(item => item.status === 'pending_inference').length ?? 0
  const runCoverage = report?.coverage ?? plan?.coverage
  const finding = report?.findings.find(item => item.id === findingId)
  const source = finding && file?.[finding.side]
  const eligibleFix = !!finding && finding.location === 'located' && finding.side === 'new'
    && file?.status === 'modified' && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(finding.sourcePath)
  const createFix = (event: FormEvent) => {
    event.preventDefault()
    if (!selected || !finding) return
    void act(async () => {
      const input = { taskId: selected.id, findingId: finding.id, objective: fixObjective.trim(),
        testPaths: testPaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean) }
      const key = JSON.stringify(input)
      if (fixRequest.current?.key !== key) fixRequest.current = { key, id: crypto.randomUUID() }
      const result = await api<{ task: { id: string } }>('/review/fix', { ...input, requestId: fixRequest.current.id })
      fixRequest.current = null; await refresh(); openModify?.(result.task.id)
    })
  }
  return <section className={`${styles.panel} ${reviewStyles.panel}`} data-iteroom-managed-review="true" aria-label="变更审查" aria-busy={busy}>
    <header className={styles.header}><div><span className={styles.kicker}>ITEROOM / REVIEW</span><h2>变更审查</h2></div>
      <p>固定变更与规则，查看覆盖和候选发现</p></header>
    <div className={styles.layout}><main className={styles.main}>
      {error && <div className={styles.error} role="alert">{error}</div>}
      <form className={styles.form} onSubmit={prepare}>
        <div className={styles.formTitle}><h3>准备审查输入</h3><span>当前启动项目</span></div>
        <fieldset className={reviewStyles.modes} disabled={busy}><legend>变更来源</legend>
          {(Object.keys(modes) as Mode[]).map(value => <label key={value}><input type="radio" name="review-mode"
            value={value} checked={mode === value} onChange={() => setMode(value)} />{modes[value]}</label>)}</fieldset>
        {mode === 'commit' && <label>提交 SHA<input className={reviewStyles.hashInput} value={commit}
          onChange={event => setCommit(event.target.value)} pattern="[0-9a-f]{40}" maxLength={40} required disabled={busy} placeholder="完整的 40 位小写 SHA" /></label>}
        {mode === 'range' && <>
          <label>起点 SHA<input className={reviewStyles.hashInput} value={from} onChange={event => setFrom(event.target.value)}
            pattern="[0-9a-f]{40}" maxLength={40} required disabled={busy} placeholder="完整的 40 位小写 SHA" /></label>
          <label>终点 SHA<input className={reviewStyles.hashInput} value={to} onChange={event => setTo(event.target.value)}
            pattern="[0-9a-f]{40}" maxLength={40} required disabled={busy} placeholder="从共同祖先到此提交的变化" /></label>
        </>}
        <p className={styles.hint}>工作树包含暂存、未暂存和未跟踪变更。准备过程在本机独立副本中运行，当前不会发送代码给模型。单提交采用第一父提交；提交范围采用唯一共同祖先。</p>
        <button type="submit" className={styles.primary} disabled={busy || blocking}>{busy ? '处理中…' : '固定输入'}</button>
        {blocking && <p className={styles.hint}>已有未结束的任务；放弃准备后可创建下一项。</p>}
      </form>
      {selected && <article className={styles.task}>
        <div className={styles.taskTop}><span className={styles.taskLabel}>{modes[selected.reviewInput.mode]}</span>
          <span className={styles.status}>{taskLabel(selected)}</span></div>
        <h3>审查记录</h3>
        {selected.recheckOrigin && <p className={styles.hint}>修复后新输入 · 关联修改任务 {selected.recheckOrigin.modifyTaskId.slice(0, 8)}。此记录独立保存；尚未推理时不能作为修复通过的证据。</p>}
        <p className={styles.hint}>审查覆盖不代表测试通过；候选发现需要人工确认，零发现也不保证没有问题。</p>
        {selected.reviewFailureCode && <p className={styles.failure}>{selected.reviewCleanupPending
          ? '进程或临时资源收束未确认，任务保持阻塞；需要人工核对，当前不能自动释放或重放。'
          : errors[selected.reviewFailureCode] ?? `准备失败（${selected.reviewFailureCode}），可放弃后重新创建。`}</p>}
        {selected.failureCode && <p className={styles.failure}>{errors[selected.failureCode] ?? `执行停止（${selected.failureCode}）`}</p>}
        <p className={styles.hint}>开始后将把已固定的代码与规则发送给 DeepSeek。每项最多 2 组、4 次请求、每次 512 输出 tokens；超过预算的文件保持待审。</p>
        <div className={styles.actions}><button className={styles.secondary} disabled={busy || selected.status !== 'queued' || !plan?.groups.length || selected.reviewCleanupPending}
          onClick={() => start(selected)}>开始审查</button>
          {selected.status === 'queued' && <button className={styles.secondary} disabled={busy || selected.reviewCleanupPending} onClick={() => cancel(selected)}>放弃准备</button>}
          {['running', 'cancelling'].includes(selected.status) && <button className={styles.secondary} disabled={busy || selected.status === 'cancelling'} onClick={() => cancel(selected)}>停止审查</button>}
          {['completed', 'failed', 'cancelled', 'interrupted'].includes(selected.status) && <button className={styles.secondary} disabled={busy} onClick={() => remove(selected)}>删除审查记录</button>}</div>
        {preparation && <div className={styles.result}>
          <div className={styles.resultHead}><h4>{runCoverage ? `${runCoverage.length} 个变更 · ${runCoverage.filter(item => item.status === 'completed').length} 个已审 · ${runCoverage.filter(item => item.status === 'pending').length} 个待审 · ${runCoverage.filter(item => item.status === 'failed').length} 个失败 · ${runCoverage.filter(item => item.status === 'excluded').length} 个排除`
            : `${preparation.coverage.length} 个变更 · ${candidates} 个待推理 · ${preparation.coverage.length - candidates} 个排除`}</h4></div>
          <p className={styles.hint}>OpenCodeReview {preparation.ocr.version}{preparation.ocr.actualCli ? ' · 实际 CLI' : ' · 模拟准备'}</p>
          <code className={reviewStyles.fingerprint}>固定输入 {preparation.id.slice(0, 16)}</code>
          {!preparation.coverage.length && <p>没有变更；未执行审查。</p>}
          <div className={reviewStyles.files} aria-label="文件覆盖清单">{preparation.coverage.map((item, index) => <button key={item.path}
            className={styles.secondary} aria-pressed={index === fileIndex} onClick={() => { setFileIndex(index); setFindingId(null) }}>
            <code>{item.path}</code><span>{coverageLabels[runCoverage?.[index]?.status ?? (item.status === 'excluded' ? 'excluded' : 'pending')]}</span></button>)}</div>
          {report && <div className={reviewStyles.findings} aria-label="候选发现"><h4>{report.findings.length} 个候选发现</h4>
            {!report.findings.length && <p className={styles.hint}>本次没有有效候选发现，请结合覆盖清单和执行状态判断范围。</p>}
            {report.findings.map(item => <button key={item.id} className={styles.secondary} aria-pressed={findingId === item.id}
              onClick={() => { setFileIndex(preparation.coverage.findIndex(file => file.path === item.path)); setFindingId(item.id); setFixObjective(item.message); fixRequest.current = null }}>
              <span>{item.message}</span><small>{item.sourcePath} · {item.side === 'old' ? '旧侧' : '新侧'} · {item.location === 'located'
                ? `第 ${item.startLine}–${item.endLine} 行` : item.location === 'ambiguous' ? '片段重复，未定位' : '片段未匹配，未定位'} · 待人工确认</small></button>)}
          </div>}
        </div>}
      </article>}
      {finding && <form className={styles.form} onSubmit={createFix}>
        <div className={styles.formTitle}><h3>关联修复</h3><span>来源：已固定的审查候选</span></div>
        <label>修复目标<textarea value={fixObjective} maxLength={500} required disabled={busy}
          onChange={event => setFixObjective(event.target.value)} /></label>
        <label>已有测试文件（每行一个）<textarea value={testPaths} required disabled={busy}
          placeholder="src/example.test.mjs" onChange={event => setTestPaths(event.target.value)} /></label>
        <p className={styles.hint}>创建时只固定所选源码和测试，不调用模型或写回项目。测试保持固定；随后到隔离修改页面显式开始执行。</p>
        {!eligibleFix && <p className={styles.hint}>当前只支持已定位的新侧普通修改；旧侧、删除、重命名和测试文件候选暂不能直接修复。</p>}
        <button className={styles.primary} type="submit" disabled={busy || blocking || !eligibleFix || !fixObjective.trim() || !testPaths.trim() || !openModify}>创建修复任务</button>
      </form>}
    </main><aside className={styles.aside}>
      <div className={styles.asideHead}><h3>{finding ? '固定源码' : '固定 Diff'}</h3><span className={styles.hint}>只读预览</span></div>
      {file && coverage ? <>
        <div className={styles.sourceMeta}><code>{coverage.oldPath && coverage.newPath && coverage.oldPath !== coverage.newPath
          ? `${coverage.oldPath} → ${coverage.newPath}` : coverage.path}</code></div>
        <p className={styles.hint}>{coverage.ocrExcludeReason ? reasons[coverage.ocrExcludeReason] ?? coverage.ocrExcludeReason : '已纳入审查范围'}
          {coverage.side === 'old' ? ' · 旧侧内容' : ' · 新侧内容'}</p>
        {runCoverage?.[fileIndex]?.reason && <p className={styles.hint}>{reasons[runCoverage[fileIndex].reason!] ?? runCoverage[fileIndex].reason}</p>}
        {finding && source?.content !== null && source ? <>
          <code className={reviewStyles.fingerprint}>源码 SHA-256 {source.contentSha256.slice(0, 16)} · {finding.side === 'old' ? '旧侧' : '新侧'}</code>
          <pre className={`${styles.code} ${reviewStyles.diff}`}>{source.content!.split('\n').map((line, index) => <span key={index}
            className={finding.location === 'located' && index + 1 >= finding.startLine! && index + 1 <= finding.endLine! ? reviewStyles.highlight : undefined}>{index + 1}: {line}{'\n'}</span>)}</pre>
        </> : file.diff !== null ? <pre className={`${styles.code} ${reviewStyles.diff}`}>{file.diff}</pre>
          : <p className={styles.emptySource}>此文件已排除，准备记录不保留它的正文或 Diff。</p>}
      </> : <p className={styles.emptySource}>固定输入后，在文件覆盖清单中选择一个文件。</p>}
      <h3 className={reviewStyles.historyTitle}>审查历史</h3>
      <div className={styles.history}>{own.map(task => <button key={task.id} aria-current={task.id === selectedId ? 'page' : undefined}
        onClick={() => setSelectedId(task.id)}><span>{modes[task.reviewInput.mode]}</span><small>{taskLabel(task)} · {new Date(task.createdAt).toLocaleDateString()}</small></button>)}</div>
    </aside></div>
  </section>
}
