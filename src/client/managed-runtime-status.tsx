import { useEffect, useRef, useState } from 'react'
import styles from './managed-understand.module.css'

interface RuntimeStatus {
  model: { status: 'configured' | 'missing' | 'invalid'; accountVerified: false }
  sandbox: { configuration: 'configured' | 'missing' | 'invalid';
    service: 'not_checked' | 'available' | 'unavailable'; checkedAt: string | null; code: string | null }
  budgets: Record<'understand' | 'modify' | 'review', { maxRequests: number; maxOutputTokens: number }>
}
const configLabels = { configured: '已配置', missing: '未配置', invalid: '配置无效' }

export function ManagedRuntimeStatus({ kind }: { kind: 'understand' | 'modify' | 'review' }) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const refresh = async (check = false) => {
    controller.current?.abort()
    const current = controller.current = new AbortController()
    setBusy(true); setError(null)
    try {
      const response = await fetch('/api/iteroom/runtime' + (check ? '/sandbox-check' : ''), {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([current.signal, AbortSignal.timeout(6000)]),
        ...(check ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      })
      if (!response.ok) throw Error('无法读取运行状态，请刷新后重试。')
      const result: RuntimeStatus = await response.json()
      if (!current.signal.aborted) setStatus(result)
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : '运行状态暂不可用。')
    } finally { if (!current.signal.aborted) setBusy(false) }
  }
  useEffect(() => { void refresh(); return () => controller.current?.abort() }, [])
  const budget = status?.budgets[kind]
  const summary = error ? '暂不可用' : !status ? '读取中…'
    : status.model.status === 'configured' && (kind !== 'modify' || status.sandbox.configuration === 'configured')
      ? '配置已校验' : '需要配置'
  const service = !status || status.sandbox.service === 'not_checked' ? '尚未检查'
    : status.sandbox.service === 'available' ? '可连接 · 未验证镜像或执行'
      : status.sandbox.code === 'SANDBOX_SERVICE_TIMEOUT' ? '连接超时' : '当前不可连接'
  return <details className={styles.runtime} aria-label="受管运行状态">
    <summary>运行配置 <span role="status" aria-live="polite">{busy ? '检查中…' : summary}</span></summary>
    <div className={styles.runtimeBody}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {status && !error && <>
        <dl className={styles.runtimeFacts}>
          <dt>模型</dt><dd>DeepSeek Flash · {configLabels[status.model.status]} · 账户未验证</dd>
          <dt>沙箱配置</dt><dd>{configLabels[status.sandbox.configuration]}</dd>
          <dt>沙箱连接</dt><dd>{service}{status.sandbox.checkedAt && <> · {new Date(status.sandbox.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })} 检查</>}</dd>
          <dt>本任务上限</dt><dd>最多 {budget?.maxRequests} 次请求，每次最多 {budget?.maxOutputTokens} 输出 tokens</dd>
        </dl>
        {status.model.status !== 'configured' && <p className={styles.hint}>请在本机配置 DeepSeek 凭证并重启；凭证保存在项目外。</p>}
        {status.sandbox.configuration !== 'configured' && <p className={styles.hint}>隔离修改需配置沙箱凭证与固定 Node 镜像，然后重启。</p>}
        <p className={styles.hint}>配置校验不调用模型。连接检查只访问本机沙箱服务，不创建沙箱。请求上限不是费用硬限额；账单未核对。</p>
      </>}
      <div className={styles.runtimeButtons}>
        <button type="button" className={styles.secondary} disabled={busy} onClick={() => void refresh()}>刷新配置</button>
        <button type="button" className={styles.secondary} disabled={busy || !!error || status?.sandbox.configuration !== 'configured'}
          onClick={() => void refresh(true)}>检查沙箱连接</button>
      </div>
    </div>
  </details>
}
