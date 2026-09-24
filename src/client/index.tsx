import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import styles, { stylesheet } from './ui.module.css'

const CALL_PANEL = 'iteroom.call' as MainPanelId
const ICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><path d="M10 54V28C10 16 19 7 31 7h2c12 0 21 9 21 21v26" stroke="#254D42" stroke-width="5" stroke-linecap="round"/><path d="M23 54V31a9 9 0 0 1 18 0v23" stroke="#254D42" stroke-width="5" stroke-linecap="round"/><path d="M10 54h13m18 0h13" stroke="#B2644C" stroke-width="5" stroke-linecap="round"/></svg>',
)

function IteroomMark({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" className={styles.mark} width={size} height={size} viewBox="0 0 64 64" fill="none">
      <path d="M10 54V28C10 16 19 7 31 7h2c12 0 21 9 21 21v26" className={styles.markArch} strokeWidth="5" strokeLinecap="round" />
      <path d="M23 54V31a9 9 0 0 1 18 0v23" className={styles.markArch} strokeWidth="5" strokeLinecap="round" />
      <path d="M10 54h13m18 0h13" className={styles.markBase} strokeWidth="5" strokeLinecap="round" />
    </svg>
  )
}

function IteroomName() {
  return <span className={styles.wordmark}>iteroom</span>
}

function MicrophoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5.5 10.5a6.5 6.5 0 0 0 13 0M12 17v4m-4 0h8" />
    </svg>
  )
}

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15 18-6-6 6-6M9 12h11" />
    </svg>
  )
}

function PhoneDownIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 15.5a15 15 0 0 1 18 0l-2.2 3a1.5 1.5 0 0 1-2 .4l-2.3-1.4a1.5 1.5 0 0 1-.7-1.7l.3-1.1a11 11 0 0 0-4.2 0l.3 1.1a1.5 1.5 0 0 1-.7 1.7l-2.3 1.4a1.5 1.5 0 0 1-2-.4Z" />
    </svg>
  )
}

function TextTaskIcon() {
  return (
    <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="15" rx="3" /><path d="M8 10h8M8 14h6" />
    </svg>
  )
}

function CaptionsIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 10h4m-4 4h3m4-4h3m-3 4h3" />
    </svg>
  )
}

function VoiceEntry({ openCall }: { openCall: () => void }) {
  return (
    <button className={styles.voiceEntry} type="button" onClick={openCall} title="打开语音空间" aria-label="打开语音空间">
      <MicrophoneIcon size={16} /><span>语音讨论</span>
    </button>
  )
}

function CallNavIcon({ size = 18 }: { size?: number }) {
  return <MicrophoneIcon size={size} />
}

function CallPage({ returnToChat }: { returnToChat: () => void }) {
  return (
    <main className={styles.page} data-iteroom-call-page="true" lang="zh-CN" aria-label="Iteroom 语音空间">
      <header className={styles.topbar}>
        <div className={styles.topbarIdentity}>
          <button className={styles.headerBrand} type="button" onClick={returnToChat} aria-label="Iteroom，返回文字工作台">
            <IteroomMark size={34} /><IteroomName />
          </button>
          <span className={styles.topbarDivider} aria-hidden="true" />
          <span className={styles.pageName}>语音空间</span>
        </div>
        <button className={styles.back} type="button" onClick={returnToChat}>
          <ArrowLeftIcon /> 返回文字工作台
        </button>
      </header>

      <div className={styles.callMain}>
        <h1 className={styles.srOnly}>语音空间界面预览</h1>
        <button className={styles.taskContext} type="button" onClick={returnToChat}>
          <span className={styles.taskCaption}>文字任务</span>
          <span className={styles.taskName}>返回当前会话</span>
          <span className={styles.taskNote}>原会话状态保持不变</span>
          <span className={styles.taskChevron} aria-hidden="true">›</span>
        </button>

        <div className={styles.voiceFocus}>
          <div className={styles.soundMark} aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <p className={styles.connectionState}><span className={styles.stateDot} aria-hidden="true" />尚未连接 <span className={styles.stateDivider}>·</span> 界面预览</p>
        </div>

        <section className={styles.transcript} aria-labelledby="iteroom-transcript-heading">
          <div className={styles.transcriptHeading}>
            <h2 id="iteroom-transcript-heading">实时字幕</h2>
            <span>尚无转写</span>
          </div>
          <p className={styles.transcriptEmpty}>语音尚未接入。建立通话后，实时转写会显示在这里。</p>
        </section>
      </div>

      <footer className={styles.dockShell}>
        <div className={styles.dock} role="group" aria-label="语音控制预览，当前不可用">
          <button className={styles.taskButton} type="button" onClick={returnToChat} aria-label="返回文字工作台"><TextTaskIcon /><span>文字任务</span></button>
          <span className={styles.dockDivider} aria-hidden="true" />
          <button className={styles.iconButton} type="button" disabled aria-label="麦克风尚未接入" title="麦克风尚未接入"><MicrophoneIcon /></button>
          <button className={styles.iconButton} type="button" disabled aria-label="字幕尚未接入" title="字幕尚未接入"><CaptionsIcon /></button>
          <span className={styles.dockSpacer} />
          <span className={styles.dockNote}>控件仅为界面预览</span>
          <button className={styles.endButton} type="button" disabled aria-label="尚无通话可结束"><PhoneDownIcon />结束通话</button>
        </div>
      </footer>
    </main>
  )
}

function installPageBrand(): () => void {
  const title = document.querySelector('title')
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  const oldIcon = favicon?.getAttribute('href')
  const oldUiAttribute = document.body.getAttribute('data-iteroom-ui')
  document.body.setAttribute('data-iteroom-ui', 'true')
  favicon?.setAttribute('href', ICON)
  const updateTitle = () => {
    const current = document.title
    if (current.includes('DeepSeek Harness')) document.title = current.replaceAll('DeepSeek Harness', 'Iteroom')
    else if (current === 'DSH Local Build') document.title = 'Iteroom'
  }
  updateTitle()
  const observer = new MutationObserver(updateTitle)
  if (title) observer.observe(title, { childList: true, characterData: true, subtree: true })
  return () => {
    observer.disconnect()
    if (oldIcon !== null && oldIcon !== undefined) favicon?.setAttribute('href', oldIcon)
    if (oldUiAttribute === null) document.body.removeAttribute('data-iteroom-ui')
    else document.body.setAttribute('data-iteroom-ui', oldUiAttribute)
  }
}

export const inject = ['slots', 'layout']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.iteroomUi = 'true'
    style.textContent = stylesheet
    document.head.append(style)
    const restoreBrand = installPageBrand()
    return () => { restoreBrand(); style.remove() }
  }, 'iteroom: styles and page brand')

  const openCall = () => ctx.layout.selectPanel(CALL_PANEL)
  const returnToChat = () => ctx.layout.selectPanel(null)

  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark' }, IteroomMark))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name' }, IteroomName))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, IteroomMark))
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({ name: 'conversation.input.right', id: 'iteroom.voice', order: 180,
      inject: () => ({ openCall }) }, VoiceEntry))

  ctx.slots.inject('main', () =>
    ctx.slots.inject('sidebar.panellist', function* () {
      yield ctx.slots.register({ name: 'main', key: CALL_PANEL,
        inject: () => ({ returnToChat }) }, CallPage)
      yield ctx.slots.register({ name: 'sidebar.panellist', id: CALL_PANEL, order: 400,
        label: '语音空间' }, CallNavIcon)
    }))
}
