import { EventComposer } from './index.js'
import type { PageSnapshot } from './page.js'
import type { ClockPort } from '../../types/index.js'
import { SessionManager, type SessionSnapshot, type SessionTransition } from '../userStore.js'
import type { MiniProgramTarget } from '../../types/index.js'
import { MINI_PROGRAM_PROFILES } from '../../constants/miniprogram.js'

export type AppEntrySnapshot = Readonly<{
  path: string | null
  query: string | null
  scene?: string | null
  referralPage?: string | null
}>

export type AppShowResult = Readonly<{
  session: SessionTransition
  visitQueued: boolean
}>

export type AppHideResult = Readonly<{
  session: SessionSnapshot | null
  appClosedQueued: boolean
}>

export type AppLifecycleDependencies = Readonly<{
  sessions: SessionManager
  composer: EventComposer
  clock: ClockPort
  /** dataCollect 由 TrackerLifecycle 管理，此处只判断当前是否允许生成行为事件。 */
  canCollect: () => boolean
  /** 当前页面上下文存在时，APP_CLOSED 复用其路由和 query。 */
  currentPage?: () => PageSnapshot | null
  /** 尽力保存会话，失败不得阻断宿主前后台切换。 */
  persistSession?: (snapshot: SessionSnapshot | null) => void
  /** 后台时触发有时限的尽力刷新，未完成事件仍留队。 */
  forceFlush?: () => void
  miniprogram?: MiniProgramTarget
}>

/** 仅保留有效入口路由与 query，不保存原始宿主参数。 */
function normalizeEntry(entry: AppEntrySnapshot): AppEntrySnapshot {
  return {
    path: typeof entry.path === 'string' && entry.path.length > 0 ? entry.path : null,
    query: typeof entry.query === 'string' ? entry.query : null,
    ...(entry.scene === undefined ? {} : { scene: typeof entry.scene === 'string' && entry.scene !== '' ? entry.scene : null }),
    ...(entry.referralPage === undefined ? {} : { referralPage: typeof entry.referralPage === 'string' ? entry.referralPage : null }),
  }
}

/** App 生命周期的纯数据路由，不直接读取 uni、Page 或 Vue 对象；宿主参数先由桥接层裁剪为快照。 */
export class AppLifecycle {
  private launchEntry: AppEntrySnapshot | null = null
  private currentEntry: AppEntrySnapshot | null = null
  private coldStartPending = false
  private foreground = false

  /** 注入会话、事件组装和存储回调；构造时不触发生命周期。 */
  public constructor(private readonly dependencies: AppLifecycleDependencies) {}

  /** 标记新的 App JS 运行期，由后续 onShow 为新会话生成 VISIT。 */
  public onLaunch(entry: AppEntrySnapshot): void {
    this.launchEntry = normalizeEntry(entry)
    this.coldStartPending = true
  }

  /** 恢复前台状态并判断是否新建会话；仅在新访问且允许采集时生成 VISIT。 */
  public onShow(entry: AppEntrySnapshot, observedAt?: number): AppShowResult {
    const timestamp = observedAt ?? this.dependencies.clock.now()
    this.dependencies.composer.setAppState('FOREGROUND')
    const nextEntry = normalizeEntry(entry)
    const sceneChanged = this.dependencies.miniprogram !== undefined && this.currentEntry?.scene != null
      && nextEntry.scene != null && this.currentEntry.scene !== nextEntry.scene
    let session = this.coldStartPending
      ? this.dependencies.sessions.onProcessLaunch()
      : sceneChanged ? this.dependencies.sessions.renew('scene_changed')
      : this.dependencies.sessions.resume(timestamp)
    if (this.dependencies.miniprogram !== undefined) {
      const activity = this.dependencies.sessions.touch(timestamp)
      if (activity.startedNew) session = activity
    }
    if (this.dependencies.miniprogram === undefined || session.startedNew || this.currentEntry === null) this.currentEntry = nextEntry
    this.dependencies.composer.setEntry(this.currentEntry!)
    this.foreground = true
    this.coldStartPending = false
    this.persistSession(session.snapshot)
    const visitQueued = session.startedNew && this.dependencies.canCollect()
      ? this.dependencies.composer.compose({ eventType: 'VISIT', fields: this.currentEntry }).ok
      : false
    return { session, visitQueued }
  }

  /** 仅在 dataCollect 从 false 切换为 true 后调用。 */
  public onCollectionResumed(): AppShowResult {
    const session = this.dependencies.sessions.onCollectionResumed()
    if (this.dependencies.miniprogram !== undefined) this.dependencies.sessions.touch(this.dependencies.clock.now())
    this.persistSession(session.snapshot)
    const visitQueued = this.dependencies.canCollect()
      ? this.dependencies.composer.compose({ eventType: 'VISIT', fields: this.currentEntry ?? {} }).ok
      : false
    return { session, visitQueued }
  }

  /** 身份路由已替换会话，此处仅在允许采集时补充对应 VISIT。 */
  public onUserChanged(observedAt?: number): boolean {
    if (this.dependencies.miniprogram !== undefined) this.dependencies.sessions.touch(observedAt ?? this.dependencies.clock.now())
    return this.dependencies.canCollect()
      ? this.dependencies.composer.compose({ eventType: 'VISIT', fields: this.currentEntry ?? {} }).ok
      : false
  }

  /** 关闭事件仅尽力发送；持久化和刷新失败不能阻止宿主进入后台。 */
  public onHide(observedAt?: number): AppHideResult {
    if (this.dependencies.miniprogram !== undefined && !this.foreground) return { session: this.dependencies.sessions.current(), appClosedQueued: false }
    this.foreground = false
    const timestamp = observedAt ?? this.dependencies.clock.now()
    this.dependencies.composer.setAppState('BACKGROUND')
    const session = this.dependencies.sessions.hide(timestamp)
    const page = this.dependencies.currentPage?.() ?? null
    const appClosedQueued = session !== null && this.dependencies.canCollect()
      ? this.dependencies.composer.compose({
        eventType: 'APP_CLOSED',
        appState: 'BACKGROUND',
        fields: page === null ? {} : { path: page.route, query: page.query },
      }).ok
      : false
    this.persistSession(session)
    try {
      this.dependencies.forceFlush?.()
    } catch {
      // App.onHide 中的宿主刷新仅尽力执行，不阻塞退后台。
    }
    return { session, appClosedQueued }
  }

  /** 读取启动入口与最近一次 App 显示入口。 */
  public entry(): Readonly<{ launch: AppEntrySnapshot | null; current: AppEntrySnapshot | null }> {
    return { launch: this.launchEntry, current: this.currentEntry }
  }

  /** 首个页面的外部来源；后续页面仍优先使用 PageStore 中的真实上一页。 */
  public pageReferral(): string | null {
    if (this.dependencies.miniprogram === undefined) return null
    return this.currentEntry?.referralPage || `scn:${MINI_PROGRAM_PROFILES[this.dependencies.miniprogram].scenePrefix}${this.currentEntry?.scene ?? 'NA'}`
  }

  /** 活动超时在业务事件之前建立新访问，避免新的事件沿用旧 session。 */
  public onActivity(now: number): boolean {
    if (!this.dependencies.sessions.touch(now).startedNew) return false
    this.onUserChanged(now)
    return true
  }

  /** 尽力保存会话快照，隔离持久化异常以免影响宿主生命周期。 */
  private persistSession(snapshot: SessionSnapshot | null): void {
    try {
      this.dependencies.persistSession?.(snapshot)
    } catch {
      // 本次持久化失败不阻塞生命周期，后续状态变化仍可再次保存。
    }
  }
}
