import { EventComposer, EventSequence, EventDispatcher } from './dataStore/index.js'
import { BootstrapBuffer, hydrateTrackerState, TrackerEventGate, type TrackerIntent, TrackerLifecycle, type DataCollectTransition } from './lifecycle.js'
import type { GioInitOptions, ResolvedGioConfig } from '../constants/config.js'
import { IdentityPersistence, type DeviceIdFactory, MetaPersistence, QueuePersistence, SessionPersistence, storageKeys } from './storage/index.js'
import { assignedDeviceId, updateIdentity, type Identity, LocationState, SessionManager, type SessionIdFactory } from './userStore.js'
import { readLegacyMiniProgramIdentity, type LegacyIdentityPort } from './storage/legacyIdentity.js'
import { embeddedGioInfo } from '../plugins/gioHybridAdapter/info.js'
import { NativeIdentifierState, type NativeIdentifiersPort } from '../plugins/gioNativeIdentifiers/index.js'
import { PageStore, type PageLoadInput, type PageOrientation, PageLifecycle } from './dataStore/page.js'
import type { ClockPort, LoggerPort, MiniProgramTarget, NetworkPort, NetworkState, StoragePort, SystemContextPort, TimezonePort, TransportPort } from '../types/index.js'
import { buildAppEvent, buildMiniProgramEvent, isValidCustomEventName, normalizeAttributes, type ProtocolEvent } from './dataStore/protocol.js'
import { EventQueue } from './queue.js'
import { AppLifecycle, type AppEntrySnapshot } from './dataStore/app.js'
import { Uploader, type UploaderRuntime } from './uploader.js'
import type { AutoTrackCall, ChangeElement, NormalizedAutoTrackCall } from '../plugins/gioEventAutoTracking/contract.js'
import { AutoTrackDispatcher } from '../plugins/gioEventAutoTracking/index.js'
import { appCapabilityProfile, miniProgramCapabilityProfile, type AutoTrackCapabilityProfile } from '../constants/platform.js'

declare const __GIO_AUTOTRACK_VERIFICATION__: boolean

export type LocalTrackerRuntimeDependencies = Readonly<{
  target?: MiniProgramTarget
  storage: StoragePort
  systemContext: SystemContextPort | ((config: ResolvedGioConfig) => SystemContextPort)
  clock: ClockPort
  timezone: TimezonePort
  deviceIdFactory: DeviceIdFactory
  sessionIdFactory: SessionIdFactory
  /** 通过宿主读取并归一化页面方向。 */
  orientation: () => PageOrientation
  logger?: LoggerPort
  /** 仅内部受控宿主验证注入，不通过 gdp init 暴露。 */
  autoTrackProfile?: AutoTrackCapabilityProfile
  network?: NetworkPort
  upload?: Readonly<{ transport: TransportPort; runtime: UploaderRuntime }>
  legacyIdentity?: LegacyIdentityPort
  nativeIdentifiers?: NativeIdentifiersPort
}>

type RuntimeState = Readonly<{
  identity: { value: Identity }
  identityPersistence: IdentityPersistence
  sessionPersistence: SessionPersistence | null
  metaPersistence: MetaPersistence
  queuePersistence: QueuePersistence | null
  queue: EventQueue
  sequence: EventSequence
  sessions: SessionManager
  location: LocationState
  app: AppLifecycle
  page: PageLifecycle
  dispatcher: EventDispatcher
  pages: PageStore
  autoTrackProfile: AutoTrackCapabilityProfile | null
  uploader: Uploader | null
  stopNetwork: (() => void) | null
  /** 合并网络刷新请求，可要求在当前查询后补一次新读取。 */
  refreshNetwork: (requireFresh?: boolean) => void
  platform: string
  domain: string
  newDevice: boolean
  nativeIdentifiers: NativeIdentifierState | null
}>

/** 将内部意图或探针识别为对象记录，拒绝空值与数组。 */
function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null
}

/** 通过显式宿主端口协调运行时，不向核心暴露 uni 对象，使真实 App 和受控测试共用同一恢复路径。 */
export class LocalTrackerRuntime {
  private readonly lifecycle: TrackerLifecycle
  private readonly gate: TrackerEventGate
  private state: RuntimeState | null = null
  private bootstrapFailed = false
  private appShown = false
  private foreground = false
  private pendingPageShow: TrackerIntent | null = null
  private intentCollection: boolean | undefined
  private readonly pendingSessionCommands = new BootstrapBuffer()
  private hydration: Promise<void> | null = null
  private userKeyIgnoredWarned = false
  private readonly autoTrackDispatcher = new AutoTrackDispatcher()
  private awaitingIdentify = false
  private identifyPending = false
  private firstDeviceSession: string | null = null
  private readonly restoredRequests = new Set<string>()

  /** 保存宿主依赖并创建门控组件；真正的状态恢复由 init 触发。 */
  public constructor(private readonly dependencies: LocalTrackerRuntimeDependencies) {
    this.lifecycle = new TrackerLifecycle(dependencies.target)
    this.gate = new TrackerEventGate(this.lifecycle)
  }

  /** 在初始化窗口内注册已交付的内置插件。 */
  public registerPlugins(...plugins: Parameters<TrackerLifecycle['registerPlugins']>): boolean {
    return this.lifecycle.registerPlugins(...plugins)
  }

  /** 返回已注册内置插件名称，用于入口去重。 */
  public registeredPluginNames(): readonly string[] { return this.lifecycle.registeredPlugins().map((plugin) => plugin.name) }

  /** 同步校验配置并启动异步状态恢复；返回 true 不等同于运行时已经就绪。 */
  public init(options: unknown): boolean {
    this.log('info', '[GrowingIO]：Gio uni-app SDK 初始化中...')
    const result = this.lifecycle.init(options as GioInitOptions)
    if (!result.ok) {
      this.log(
        result.code === 'already_initialized' ? 'warn' : 'error',
        result.code === 'already_initialized'
          ? '[GrowingIO]：SDK重复初始化，请检查是否重复加载SDK或接入其他平台SDK导致冲突!'
          : '[GrowingIO]：SDK初始化失败，初始化参数不合法!',
      )
      return false
    }
    this.awaitingIdentify = result.config.forceLogin === true
    this.hydration = this.hydrate(result.config).catch(() => {
      this.bootstrapFailed = true
      this.log('error', '[GrowingIO]：SDK初始化失败，运行时初始化异常!')
    })
    return true
  }

  /** 同时检查初始化状态和依赖装配结果，确认是否可处理就绪期调用。 */
  public ready(): boolean {
    return this.lifecycle.status() === 'ready' && this.state !== null
  }

  /** 读取状态恢复是否失败，用于接入与测试诊断。 */
  public failed(): boolean {
    return this.bootstrapFailed
  }

  /** 供 App 桥接与静态集成测试等待就绪，不作为业务埋点 API。 */
  public async whenReady(): Promise<boolean> {
    await this.hydration
    return this.ready()
  }

  /** 返回队列中协议事件的副本，不暴露请求占用和重试等内部元数据。 */
  public queuedEvents(): readonly ProtocolEvent[] {
    return this.state?.queue.snapshot().map((entry) => entry.event) ?? []
  }

  /** 校验并提交手动事件，初始化期间按有界快照暂存。 */
  public track(eventName: unknown, properties?: unknown): boolean {
    return this.submitAttributes('track', properties, eventName)
  }

  /** 按就绪、采集、插件、能力和页面状态门控探针，再执行隐私归一化与去重。 */
  public autoTrack(call: AutoTrackCall, nativeEvent?: unknown): boolean {
    try {
      if (!this.ready() || !this.collecting() || !this.lifecycle.registeredPlugins().some((plugin) => plugin.name === 'gioEventAutoTracking')) return false
      const state = this.state
      const profile = state?.autoTrackProfile
      const probe = record(call)
      if (state === null || profile == null || probe === null) return false
      const allowed = probe.source === 'tabbar' ? profile.tabBar : probe.kind === 'click' ? profile.autoClick
        : typeof probe.elementType === 'string' && Object.prototype.hasOwnProperty.call(profile.autoChange, probe.elementType) && profile.autoChange[probe.elementType as ChangeElement]
      if (!allowed) { this.autoTrackRejected('capability_unverified'); return false }
      const page = state.pages.current()
      const accepted = this.autoTrackDispatcher.dispatch(call, nativeEvent, page?.shownAt == null ? null : page.pageKey,
        (normalized) => this.gate.submit({ kind: 'autotrack', payload: normalized }, (intent) => this.emit(intent)))
      if (!accepted) this.autoTrackRejected('invalid_or_duplicate')
      return accepted
    } catch {
      this.autoTrackRejected('invalid_probe')
      return false
    }
  }

  /** 提交用户属性事件，复用与手动事件一致的属性和采集门控。 */
  public setUserAttributes(properties: unknown): boolean {
    return this.submitAttributes('user-attributes', properties)
  }

  /** 在读取业务属性前检查采集开关，随后归一化并提交独立 JSON 快照。 */
  private submitAttributes(kind: 'track' | 'user-attributes', properties: unknown, eventName?: unknown): boolean {
    if (this.lifecycle.config()?.dataCollect !== true) return false
    if (kind === 'track' && !isValidCustomEventName(eventName)) return false
    try {
      // 在 JSON 快照之前统一属性语义；关闭采集时不能读取业务属性。
      const attributes = Object.fromEntries(normalizeAttributes(properties).attributes)
      return this.gate.submit({ kind, payload: { eventName, properties: attributes } }, (intent) => this.emit(intent))
    } catch { return false }
  }

  /** 校验并更新身份，按调用顺序延迟早期命令；换登录用户时更新会话，允许采集时生成 VISIT。 */
  public setUserId(userId: unknown, userKey?: unknown): boolean {
    const config = this.lifecycle.config()
    if (config === null || !updateIdentity({ deviceId: 'pending', userId: null, userKey: null }, userId, userKey, config.idMapping).ok) return false
    const deferred = this.deferStateCommand('user-id', { userId, userKey })
    if (deferred !== null) return deferred
    const state = this.state
    if (state === null || config === null) return false
    const previous = state.identity.value
    const update = updateIdentity(previous, userId, userKey, config.idMapping)
    if (!update.ok) return false
    if (update.userKeyIgnored && !this.userKeyIgnoredWarned) {
      this.userKeyIgnoredWarned = true
      this.log('warn', '[GrowingIO]: userKey ignored because idMapping is disabled')
    }
    if (!this.updateIdentity(update.identity)) return false
    // 首次显示之前只保存身份，不能为早期 A→B 创建无入口的 VISIT 或使用历史会话。
    if (!this.appShown) return true
    const transition = state.sessions.onUserIdChange(previous.userId ?? previous.lastUserId, update.identity.userId)
    if (transition.snapshot !== null) void state.sessionPersistence?.persist(transition.snapshot)
    if (transition.startedNew) {
      state.app.onUserChanged()
      if (config.miniprogram !== undefined && this.foreground) {
        state.page.replayCurrentPage()
        this.autoTrackDispatcher.reset()
      }
    }
    this.persistAfterEvent()
    return true
  }

  /** 通过空身份清除登录字段，保留用于换人判断的最近登录身份。 */
  public clearUserId(): boolean {
    return this.setUserId('')
  }

  /** forceLogin 本次运行期只允许分配一次；仅改写本次等待上传的事件。 */
  public identify(value: unknown): boolean {
    const deviceId = assignedDeviceId(value)
    if (!this.awaitingIdentify || this.identifyPending || deviceId === null) return false
    const deferred = this.deferStateCommand('identify', { deviceId })
    if (deferred !== null) { this.identifyPending = deferred; return deferred }
    const state = this.state
    if (state === null) return false
    const entries = state.queue.snapshot().map(entry => this.restoredRequests.has(entry.requestId) ? entry
      : { ...entry, event: { ...entry.event, deviceId } })
    if (!state.queue.restore(entries)) return false
    this.updateIdentity({ ...state.identity.value, deviceId, deviceIdAssigned: true })
    this.awaitingIdentify = false
    this.persistAfterEvent()
    return true
  }

  /** 为受信任的内嵌 H5 提供当前身份，等待强制身份或会话时返回 null。 */
  public getGioInfo(): string | null {
    const config = this.lifecycle.config()
    const state = this.state
    if (!this.ready() || config === null || state === null) return null
    if (config.dataCollect && this.awaitingIdentify) return null
    const session = state.sessions.current()?.sessionId ?? null
    return embeddedGioInfo({ collecting: config.dataCollect, appId: config.miniprogram?.appId ?? state.domain,
      accountId: config.accountId, dataSourceId: config.dataSourceId, platform: state.platform,
      sessionId: session, identity: state.identity.value, idMapping: config.idMapping,
      newDevice: state.newDevice && session !== null && session === this.firstDeviceSession })
  }

  /** 切换采集同意状态；恢复时必须接纳会话重建意图，否则保持关闭。 */
  public setDataCollect(value: unknown): boolean {
    const transition = this.lifecycle.setDataCollect(value)
    if (!transition.ok) return false
    if (transition.changed) {
      if (value === false) this.state?.nativeIdentifiers?.clear()
      else this.state?.nativeIdentifiers?.refresh()
    }
    if (!transition.sessionRenewalRequired) return true
    if (this.submitLifecycle('collection-resume', {})) return true
    // 初始化暂存区已满时，不能绕过必要的恢复边界而直接开启采集。
    this.lifecycle.setDataCollect(false)
    return false
  }

  /** 初始化后只允许修改采集开关，其他初始化配置保持固定。 */
  public setOptions(options: unknown): boolean {
    const candidate = record(options)
    if (candidate === null || Object.keys(candidate).length !== 1 || !Object.prototype.hasOwnProperty.call(candidate, 'dataCollect')) return false
    return this.setDataCollect(candidate.dataCollect)
  }

  /** 校验经纬度并按调用顺序更新仅内存的位置状态。 */
  public setLocation(latitude: unknown, longitude: unknown): boolean {
    if (!new LocationState().set(latitude, longitude)) return false
    const deferred = this.deferStateCommand('location', { latitude, longitude })
    if (deferred !== null) return deferred
    return this.state?.location.set(latitude, longitude) ?? false
  }

  /** 清除后续事件的位置字段，初始化期间保持与其他状态命令的顺序。 */
  public clearLocation(): boolean {
    const deferred = this.deferStateCommand('clear-location', {})
    if (deferred !== null) return deferred
    if (this.state === null) return false
    this.state.location.clear()
    return true
  }

  /** 提交 App 冷启动入口快照，初始化期间保序暂存。 */
  public onAppLaunch(entry: AppEntrySnapshot): boolean {
    return this.submitLifecycle('app-launch', entry)
  }

  /** 记录真实前台观察时间并提交显示意图，供会话超时判断使用。 */
  public onAppShow(entry: AppEntrySnapshot): boolean {
    return this.submitLifecycle('app-show', entry)
  }

  /** 记录真实后台观察时间，提交关闭事件和尽力刷新意图。 */
  public onAppHide(): boolean {
    return this.submitLifecycle('app-hide', {})
  }

  /** 提交页面加载快照，不保留 Vue 或宿主页面对象。 */
  public onPageLoad(input: PageLoadInput): boolean {
    return this.submitLifecycle('page-load', input)
  }

  /** 提交页面显示与标题快照，建立行为事件的页面关联。 */
  public onPageShow(instanceId: string, title: string | null): boolean {
    return this.submitLifecycle('page-show', { instanceId, title })
  }

  /** 提交页面隐藏状态，关闭该页面的当前行为关联。 */
  public onPageHide(instanceId: string): boolean {
    return this.submitLifecycle('page-hide', { instanceId })
  }

  /** 提交页面释放意图，清理该实例的状态。 */
  public onPageUnload(instanceId: string): boolean {
    return this.submitLifecycle('page-unload', { instanceId })
  }

  /** 更新指定页面的标题快照，不额外生成 PAGE。 */
  public onPageTitleChanged(instanceId: string, title: string): boolean {
    return this.submitLifecycle('page-title', { instanceId, title })
  }

  /** 恢复各类持久状态并装配会话、页面、事件和上传组件，全部就绪后回放暂存调用。 */
  private async hydrate(config: NonNullable<ReturnType<TrackerLifecycle['config']>>): Promise<void> {
    const keys = storageKeys(config.dataSourceId, config.miniprogram === undefined ? undefined : { ...config.miniprogram, accountId: config.accountId })
    const queue = new EventQueue(undefined, config.miniprogram === undefined ? buildAppEvent : buildMiniProgramEvent)
    const migration = config.legacyMiniProgramIdentity
    const identityPersistence = new IdentityPersistence(this.dependencies.storage, keys.identity, config.dataSourceId, this.dependencies.deviceIdFactory,
      migration === undefined || this.dependencies.legacyIdentity === undefined ? undefined
        : () => readLegacyMiniProgramIdentity(this.dependencies.legacyIdentity!, migration, config.idMapping, this.dependencies.clock.now()))
    const sessionPersistence = config.miniprogram === undefined ? new SessionPersistence(this.dependencies.storage, keys.session) : null
    const metaPersistence = new MetaPersistence(this.dependencies.storage, keys.meta)
    const queuePersistence = this.dependencies.storage.persistentQueue ? new QueuePersistence(this.dependencies.storage, keys.queue) : null
    const hydrated = await hydrateTrackerState({
      /** 恢复当前数据源的设备与登录身份。 */
      hydrateIdentity: () => identityPersistence.hydrate(),
      /** 恢复历史会话记录，等待真实生命周期确定是否续用。 */
      hydrateSession: () => sessionPersistence?.hydrate() ?? Promise.resolve({ snapshot: null, source: 'missing' }),
      /** 独立恢复全局序号，避免身份或会话损坏导致编号重置。 */
      hydrateMeta: () => metaPersistence.hydrate(),
      /** 恢复并校验缓存队列，拒绝损坏或超限的快照。 */
      hydrateQueue: () => queuePersistence?.hydrate(queue) ?? Promise.resolve('missing'),
      /** 读取当前配置对应的宿主系统上下文。 */
      loadSystemContext: () => this.systemContext(config).load(),
    })
    if (!hydrated.ok) {
      this.bootstrapFailed = true
      this.log('error', '[GrowingIO]：SDK初始化失败!')
      return
    }
    for (const entry of queue.snapshot()) this.restoredRequests.add(entry.requestId)
    if (config.miniprogram !== undefined && hydrated.state.systemContext.appVersion === '') this.log('warn', '[GrowingIO]: mini-program appVersion unavailable')

    const sessions = new SessionManager(config.sessionPolicy, this.dependencies.sessionIdFactory, hydrated.state.session.snapshot,
      hydrated.state.identity.identity.lastUserId ?? hydrated.state.identity.identity.userId)
    // 队列和序号分别落盘，异常退出可能只保存其中一个；不能复用已分配给缓存事件的序号。
    const restoredSequence = queue.snapshot().reduce((largest, entry) => typeof entry.event.eventSequenceId === 'number'
      ? Math.max(largest, entry.event.eventSequenceId) : largest, hydrated.state.meta.snapshot.eventSequenceId)
    const sequence = new EventSequence(restoredSequence)
    const location = new LocationState()
    const identity = { value: hydrated.state.identity.identity }
    if (!config.idMapping && identity.value.userKey !== null) {
      identity.value = { ...identity.value, userKey: null }
      await identityPersistence.persist(identity.value)
    }
    let networkState: NetworkState = hydrated.state.systemContext.networkState
    const pages = new PageStore()
    const nativePlugin = this.lifecycle.registeredPlugins().find(plugin => plugin.name === 'gioNativeIdentifiers')
    const nativeIdentifiers = nativePlugin?.name === 'gioNativeIdentifiers' && config.miniprogram === undefined
      ? new NativeIdentifierState(this.dependencies.nativeIdentifiers, nativePlugin.options.fields, hydrated.state.systemContext.platform as import('../types/index.js').AppPlatform) : null
    const composer = new EventComposer(
      config, hydrated.state.systemContext, () => identity.value, sessions, sequence, queue,
      this.dependencies.clock, this.dependencies.timezone, location, () => networkState, () => pages.current(), () => nativeIdentifiers?.current() ?? {},
    )
    const page = new PageLifecycle({
      pages,
      composer,
      clock: this.dependencies.clock,
      orientation: this.dependencies.orientation,
      /** 同时检查当前开关和正在回放意图的采集状态。 */
      canCollect: () => this.collecting(),
      entryReferral: () => this.state?.app.pageReferral() ?? null,
    })
    const dispatcher = new EventDispatcher(composer, () => pages.current())
    const uploader = this.dependencies.upload === undefined ? null : new Uploader(
      queue,
      this.dependencies.upload.transport,
      this.dependencies.upload.runtime,
      config.serverUrl,
      config.accountId,
      (drop) => this.log('warn', `[GrowingIO]: upload dropped (${drop.reason})`),
      () => { if (!this.awaitingIdentify) void queuePersistence?.persist(queue) },
      config.debug ? (events) => this.debugEvents(events) : undefined,
      () => !this.awaitingIdentify && this.dependencies.network?.isConnected() !== false,
      config.miniprogram?.uploadIntervalMs ?? 0,
    )
    const appWithFlush = new AppLifecycle({
      miniprogram: config.miniprogram?.target,
      sessions,
      composer,
      clock: this.dependencies.clock,
      /** 同时检查当前开关和正在回放意图的采集状态。 */
      canCollect: () => this.collecting(),
      /** 读取当前可见页面，供关闭事件补充页面上下文。 */
      currentPage: () => pages.current(),
      /** 仅在存在快照时尽力保存会话。 */
      persistSession: (snapshot) => { if (snapshot !== null) void sessionPersistence?.persist(snapshot) },
      /** 后台切换时尽力刷新队列，不阻塞宿主生命周期。 */
      forceFlush: () => { if (uploader !== null) void uploader.forceFlush() },
    })
    let connected = this.dependencies.network?.isConnected()
    let networkRevision = 0
    /** 应用最新网络状态并优先保护通知版本，恢复连接时重新派发待传事件。 */
    const updateNetwork = (next: NetworkState): void => {
      networkRevision++
      networkState = next
      // cellular/unknown 也可能明确联网；由独立连接状态决定能否恢复上传。
      const nextConnected = this.dependencies.network?.isConnected()
      if (connected === false && nextConnected !== false) uploader?.flush()
      else uploader?.schedule()
      connected = nextConnected
    }
    const stopNetwork = this.dependencies.network === undefined ? null : this.dependencies.network.subscribe(updateNetwork)
    let readingNetwork = false
    let refreshPending = false
    /** 合并并发网络查询；前台期间要求的新读取不会被旧查询吞掉。 */
    const refreshNetwork = (requireFresh = false): void => {
      const network = this.dependencies.network
      if (network === undefined) return
      if (readingNetwork) {
        // 启动阶段可共用首次查询；后续回前台需要新的网络读取。
        refreshPending ||= requireFresh
        return
      }
      readingNetwork = true
      const revision = networkRevision
      /** 仅在没有更新宿主通知时应用查询结果，避免旧数据覆盖新连接状态。 */
      const applyReading = (next: NetworkState): void => {
        // 宿主网络通知可能在查询完成后、Promise 回调执行前到达。
        if (revision === networkRevision) updateNetwork(next)
      }
      void network.current().then(applyReading).catch(() => applyReading('UNKNOWN')).finally(() => {
        readingNetwork = false
        if (refreshPending) {
          refreshPending = false
          refreshNetwork()
        }
      })
    }
    refreshNetwork()
    this.state = {
      identity, identityPersistence, sessionPersistence, metaPersistence, queuePersistence, queue, sequence, sessions, location,
      app: appWithFlush, page, dispatcher, pages, uploader, stopNetwork, refreshNetwork,
      platform: hydrated.state.systemContext.platform, domain: hydrated.state.systemContext.domain,
      newDevice: hydrated.state.identity.source === 'generated' || hydrated.state.identity.source === 'corrupt',
      nativeIdentifiers,
      autoTrackProfile: this.dependencies.autoTrackProfile ?? (config.miniprogram === undefined
        ? appCapabilityProfile(hydrated.state.systemContext.platform, typeof __GIO_AUTOTRACK_VERIFICATION__ !== 'undefined' && __GIO_AUTOTRACK_VERIFICATION__ === true)
        : miniProgramCapabilityProfile(config.miniprogram.target, typeof __GIO_AUTOTRACK_VERIFICATION__ !== 'undefined' && __GIO_AUTOTRACK_VERIFICATION__ === true)),
    }
    if (this.lifecycle.config()?.dataCollect === true) nativeIdentifiers?.refresh()
    this.log('success', '[GrowingIO]：Gio uni-app SDK 初始化完成！')
    this.gate.release((intent) => this.emit(intent))
  }

  /** 结合当前同意开关与意图快照判断此刻是否允许生成行为事件。 */
  private collecting(): boolean {
    return this.lifecycle.config()?.dataCollect === true && this.intentCollection !== false
  }

  /** 根据初始化配置取得系统上下文端口，兼容直接注入和工厂两种形式。 */
  private systemContext(config: ResolvedGioConfig): SystemContextPort {
    return typeof this.dependencies.systemContext === 'function'
      ? this.dependencies.systemContext(config)
      : this.dependencies.systemContext
  }

  /** 为前后台意图保留观察时间，即使关闭采集也允许必要状态被维护。 */
  private submitLifecycle(kind: string, payload: Readonly<Record<string, unknown>>): boolean {
    if (this.lifecycle.config() === null) return false
    // 保留初始化期间实际观察到的后台间隔，报文时间仍按事件构建时刻生成。
    const timed = kind === 'app-show' || kind === 'app-hide'
    let observedAt: number | undefined
    if (timed) {
      try { observedAt = this.dependencies.clock.now() } catch { return false }
      if (!Number.isFinite(observedAt) || observedAt < 0) return false
    }
    return this.gate.submitLifecycle({ kind, payload, ...(observedAt === undefined ? {} : { observedAt }) }, (intent) => this.emit(intent))
  }

  /** 在当前意图的采集快照下执行路由，结束后恢复外层状态。 */
  private emit(intent: TrackerIntent): boolean {
    const previous = this.intentCollection
    this.intentCollection = intent.collecting
    try { return this.emitIntent(intent) } finally { this.intentCollection = previous }
  }

  /** 初始化或首个会话建立前按序暂存状态变更，防止早期事件串用后续身份与位置。 */
  private deferStateCommand(kind: string, payload: Readonly<Record<string, unknown>>): boolean | null {
    if (this.state === null) return this.submitLifecycle(kind, payload)
    // 首个等待会话的事件之后，状态修改也需要保序，防止事件串用后续身份或位置。
    if (!this.appShown && this.pendingSessionCommands.size() > 0) {
      return this.pendingSessionCommands.push({ kind, payload, collecting: this.intentCollection ?? this.lifecycle.config()?.dataCollect })
    }
    return null
  }

  /** 将已验证意图分发到对应领域组件，并维护页面去重边界、持久化和发送调度。 */
  private emitIntent(intent: TrackerIntent): boolean {
    const state = this.state
    if (state === null) return false
    const payload = record(intent.payload)
    if (payload === null) return false
    const mini = this.lifecycle.config()?.miniprogram !== undefined
    if (mini && intent.kind === 'page-show' && !this.foreground) {
      if (typeof payload.instanceId !== 'string' || (typeof payload.title !== 'string' && payload.title !== null)) return false
      this.pendingPageShow = intent
      return true
    }
    if (intent.kind === 'track' || intent.kind === 'user-attributes') {
      if (!this.collecting()) return false
      // 恢复出的历史会话不能承接本次启动的业务事件，等待首次真实 App.onShow。
      if (!this.appShown) return this.pendingSessionCommands.push(intent)
    }
    if (mini && this.foreground && this.collecting() && ['track', 'user-attributes', 'autotrack', 'page-show'].includes(intent.kind)) {
      if (state.app.onActivity(this.dependencies.clock.now())) {
        if (intent.kind !== 'page-show') state.page.replayCurrentPage()
        this.autoTrackDispatcher.reset()
      }
    }
    const shownBefore = state.pages.current()
    let emitted = false
    let lifecycleHandled = false
    switch (intent.kind) {
      case 'user-id': return this.setUserId(payload.userId, payload.userKey)
      case 'identify': this.identifyPending = false; return this.identify(payload.deviceId)
      case 'location': return this.setLocation(payload.latitude, payload.longitude)
      case 'clear-location': return this.clearLocation()
      case 'user-attributes': emitted = state.dispatcher.setUserAttributes(payload.properties); break
      case 'collection-resume':
        if (this.appShown && this.collecting()) this.resumeCollection()
        return true
      case 'track': emitted = state.dispatcher.track({ eventName: payload.eventName, properties: payload.properties }); break
      case 'autotrack': emitted = state.dispatcher.autoTrack(payload as NormalizedAutoTrackCall); break
      case 'app-launch': state.app.onLaunch(payload as AppEntrySnapshot); emitted = true; lifecycleHandled = true; break
      case 'app-show': {
        const shown = state.app.onShow(payload as AppEntrySnapshot, intent.observedAt)
        emitted = shown.visitQueued
        state.refreshNetwork(this.appShown)
        this.appShown = true
        this.foreground = true
        if (this.firstDeviceSession === null) this.firstDeviceSession = state.sessions.current()?.sessionId ?? null
        if (this.pendingPageShow !== null) {
          const pending = this.pendingPageShow
          this.pendingPageShow = null
          // PAGE 在 App 真正显示时生成，使用此刻同意状态，不回放隐藏期间的采集状态。
          this.emit({ ...pending, collecting: this.collecting() })
        } else if (mini && shown.session.startedNew) state.page.replayCurrentPage(true)
        lifecycleHandled = true
        for (const command of this.pendingSessionCommands.drain()) this.emit(command as TrackerIntent)
        break
      }
      case 'app-hide':
        this.foreground = false
        if (mini) this.pendingPageShow = null
        emitted = state.app.onHide(intent.observedAt).appClosedQueued
        lifecycleHandled = true
        break
      case 'page-load': emitted = state.page.onLoad(payload as PageLoadInput) !== null; lifecycleHandled = true; break
      case 'page-title':
        if (typeof payload.instanceId !== 'string' || typeof payload.title !== 'string') return false
        state.pages.setTitle(payload.instanceId, payload.title)
        return true
      case 'page-show': emitted = typeof payload.instanceId === 'string' && (typeof payload.title === 'string' || payload.title === null)
        ? state.page.onShow(payload.instanceId, payload.title).pageQueued : false; lifecycleHandled = typeof payload.instanceId === 'string' && (typeof payload.title === 'string' || payload.title === null); break
      case 'page-hide':
        if (typeof payload.instanceId === 'string') {
          if (this.pendingPageShow?.payload.instanceId === payload.instanceId) this.pendingPageShow = null
          state.page.onHide(payload.instanceId)
          emitted = true
          lifecycleHandled = true
        }
        break
      case 'page-unload':
        if (typeof payload.instanceId === 'string') {
          if (this.pendingPageShow?.payload.instanceId === payload.instanceId) this.pendingPageShow = null
          state.page.onUnload(payload.instanceId)
          emitted = true
          lifecycleHandled = true
        }
        break
      default: return false
    }
    if (state.pages.current() !== shownBefore) this.autoTrackDispatcher.reset()
    if (emitted || lifecycleHandled) this.debugAction(intent.kind, payload)
    this.persistAfterEvent()
    return emitted
  }

  /** 仅在身份实际变化时替换内存状态并尽力持久化。 */
  private updateIdentity(identity: Identity): boolean {
    const state = this.state
    if (state === null) return false
    const previous = state.identity.value
    if (previous.deviceId === identity.deviceId && previous.userId === identity.userId && previous.userKey === identity.userKey && previous.lastUserId === identity.lastUserId && previous.deviceIdAssigned === identity.deviceIdAssigned) return true
    state.identity.value = identity
    void state.identityPersistence.persist(identity)
    return true
  }

  /** 建立恢复采集的新会话与 PAGE，并清空旧页面的无埋点去重状态。 */
  private resumeCollection(): void {
    const state = this.state
    if (state === null) return
    state.app.onCollectionResumed()
    state.page.replayCurrentPage()
    this.autoTrackDispatcher.reset()
    this.persistAfterEvent()
  }

  /** 保存队列及序号快照，再立即尝试上传；持久化失败不阻塞主调用。 */
  private persistAfterEvent(): void {
    const state = this.state
    if (state === null) return
    if (!this.awaitingIdentify) void state.queuePersistence?.persist(state.queue)
    void state.metaPersistence.persist(state.sequence.current())
    state.uploader?.schedule()
  }

  /** 沿用小程序 SDK 的生命周期诊断形式，协议事件 JSON 仅在实际派发时输出。 */
  private debugAction(kind: string, payload: Readonly<Record<string, unknown>>): void {
    if (this.lifecycle.config()?.debug !== true) return
    const timestamp = this.dependencies.clock.now()
    switch (kind) {
      case 'app-launch': this.log('debug', `App: onLaunch ${timestamp}`); return
      case 'app-show': this.log('debug', `App: onShow ${timestamp}`); return
      case 'app-hide': this.log('debug', `App: onHide ${timestamp}`); return
      case 'page-load': this.log('debug', `Page: ${typeof payload.route === 'string' ? payload.route : ''} # onLoad ${timestamp}`); return
      case 'page-show': this.log('debug', `Page: ${typeof payload.instanceId === 'string' ? payload.instanceId : ''} # onShow ${timestamp}`); return
      case 'page-hide': this.log('debug', `Page: ${typeof payload.instanceId === 'string' ? payload.instanceId : ''} # onHide ${timestamp}`); return
      case 'page-unload': this.log('debug', `Page: ${typeof payload.instanceId === 'string' ? payload.instanceId : ''} # onUnload ${timestamp}`); return
      case 'autotrack': this.log('debug', `[GrowingIO Debug]: action=${payload.kind === 'change' ? 'change' : 'click'}`); return
      default: this.log('debug', `[GrowingIO Debug]: action=${kind}`)
    }
  }

  /** 只有上传器能确认批次即将派发，因此在此记录协议事件对象数组。 */
  private debugEvents(events: readonly ProtocolEvent[]): void {
    if (this.lifecycle.config()?.debug !== true) return
    try {
      // App 调试基座可能只展示 console.log 的第一个参数，必须合成一条完整日志。
      this.dependencies.logger?.debug(`[GrowingIO Debug]: ${JSON.stringify(events)}`)
    } catch {
      // 诊断输出异常不应改变采集流程。
    }
  }

  /** 调试开启时只记录固定拒绝原因，避免打印原始探针或私密输入。 */
  private autoTrackRejected(reason: string): void {
    if (this.lifecycle.config()?.debug === true) this.log('debug', `[GrowingIO Debug]: autotrack_rejected=${reason}`)
  }

  /** 将诊断交给宿主日志端口，隔离日志实现抛出的异常。 */
  private log(level: keyof LoggerPort, message: string): void {
    try { this.dependencies.logger?.[level](message) } catch { /* 诊断输出异常不应改变采集流程。 */ }
  }
}
