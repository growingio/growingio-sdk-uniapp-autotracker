import { SDK_VERSION } from '../../constants/config.js'
import { appCapabilityProfile, type AutoTrackCapabilityProfile } from '../../constants/platform.js'
import { BuiltinPluginRegistry, type GioBuiltinPlugin } from '../../core/lifecycle.js'
import type { AppEntrySnapshot } from '../../core/dataStore/app.js'
import { PageStore, type PageLoadInput, type PageSnapshot } from '../../core/dataStore/page.js'
import { isValidCustomEventName, normalizeAttributes, type ProtocolEvent } from '../../core/dataStore/protocol.js'
import { updateIdentity } from '../../core/userStore.js'
import type { ClockPort } from '../../types/index.js'
import { AutoTrackDispatcher } from '../gioEventAutoTracking/index.js'
import type { AutoTrackCall, ChangeElement } from '../gioEventAutoTracking/contract.js'
import { asciiId, HybridPortFailure, HYBRID_MAX_BYTES, normalizeUniMPConfig, record, validateReply, wireBytes,
  type EventDraft, type HelloPayload, type HostGate, type HybridError, type HybridErrorCode, type HybridOptions,
  type HybridScheduler, type Operation, type UniMPConfig, type UniMPHostPort, type UniMPRequest, type UniMPReply } from './contract.js'

declare const __GIO_AUTOTRACK_VERIFICATION__: boolean

export type UniMPDependencies = Readonly<{
  port: UniMPHostPort
  scheduler: HybridScheduler
  clock: ClockPort
  instanceIdFactory: () => string
  sdkVersion?: string
  autoTrackProfile?: AutoTrackCapabilityProfile
  warn?: (message: string) => void
}>
type Phase = 'dormant' | 'connecting' | 'connected' | 'suspended' | 'incompatible' | 'disposed'
type Delivery = { id: string; status: 'pending' | 'accepted' | 'unavailable'; page: PageSnapshot }
type Observation = { instanceId: string; page: PageSnapshot; epoch: number; delivery: Delivery | null }
type Entry = {
  wire: string; bytes: number; requestId: number; method: Operation['method']; eventType?: EventDraft['eventType']
  page?: Delivery; timer: unknown
}
const CLOSED_HOST: HostGate = { dataCollect: false, containerVisible: false }
const INCOMPATIBLE = ['unsupported_version', 'configuration_mismatch', 'app_not_allowed', 'unsupported_event']
const DISCONNECT = ['stale_connection', 'host_not_ready', 'source_closed']

/** Native 独占数据状态；本协调器只管理有界草稿、单 FIFO 与连接 / 身份 / 页面门禁。 */
export class UniMPRuntime {
  private readonly registry = new BuiltinPluginRegistry()
  private config: UniMPConfig | null = null
  private options: HybridOptions = {}
  private phase: Phase = 'dormant'
  private instanceId = ''
  private requestCounter = 0
  private generation = 0
  private pageCounter = 0
  private epoch = 0
  private foreground = false
  private identityBlocked = false
  private identityWrite = false
  private host: HostGate = CLOSED_HOST
  private connectionId: string | null = null
  private pendingHello: UniMPRequest | null = null
  private helloAttempt = 0
  private round = 0
  private handshakeResult: Promise<boolean> | null = null
  private resolveHandshake: ((ready: boolean) => void) | null = null
  private roundTimer: unknown
  private helloTimer: unknown
  private retryTimer: unknown
  private probeTimer: unknown
  private probeAllowed = true
  private queue: Entry[] = []
  private inFlight: Entry | null = null
  private bytes = 0
  private pumping = false
  private pages = new PageStore()
  private readonly pageIds = new Set<string>()
  private current: Observation | null = null
  private unavailableCurrent: string | null = null
  private entryReferral: string | null = null
  private profile: AutoTrackCapabilityProfile | null = null
  private readonly dispatcher = new AutoTrackDispatcher()
  private ignoredKeyWarned = false

  public constructor(private readonly deps: UniMPDependencies) {}
  public registerPlugins(...plugins: GioBuiltinPlugin[]): boolean { return this.registry.register(...plugins).ok }
  public registeredPluginNames(): readonly string[] { return this.registry.plugins().map(plugin => plugin.name) }
  public init(value: unknown): boolean {
    if (this.config !== null || this.phase === 'disposed') return false
    const config = normalizeUniMPConfig(value)
    const plugin = this.registry.plugins().find(plugin => plugin.name === 'gioHybridAdapter')
    if (config === null || plugin?.name !== 'gioHybridAdapter' || this.registry.plugins().some(plugin => plugin.name === 'gioNativeIdentifiers')) return false
    let instanceId: string
    try { instanceId = this.deps.instanceIdFactory() } catch { return false }
    if (!asciiId(instanceId)) return false
    this.config = config; this.options = plugin.options ?? {}; this.instanceId = instanceId
    this.registry.closeRegistration()
    return true
  }
  public ready(): boolean { return this.phase === 'connected' }
  public failed(): boolean { return this.phase === 'suspended' || this.phase === 'incompatible' }
  public whenReady(): Promise<boolean> { return this.phase === 'connecting' ? this.handshakeResult! : Promise.resolve(this.ready()) }
  public queuedEvents(): readonly ProtocolEvent[] { return [] }
  public getGioInfo(): string | null { return null }
  public identify(_value: unknown): boolean { return false }

  public track(eventName: unknown, properties?: unknown): boolean {
    if (!this.canCollect() || !this.usablePage() || !isValidCustomEventName(eventName)) return false
    try {
      const attributes = Object.fromEntries(normalizeAttributes(properties).attributes)
      return this.event('CUSTOM', { eventName, ...(Object.keys(attributes).length === 0 ? {} : { attributes }) }, this.current?.delivery)
    } catch { return false }
  }
  public setUserAttributes(properties: unknown): boolean {
    if (!this.canCollect() || !this.canWriteIdentity()) return false
    try {
      const attributes = Object.fromEntries(normalizeAttributes(properties).attributes)
      return Object.keys(attributes).length !== 0 && this.event('LOGIN_USER_ATTRIBUTES', { attributes })
    } catch { return false }
  }
  public setUserId(userId: unknown, userKey?: unknown): boolean {
    if (!this.baseGate() || !this.canWriteIdentity()) return false
    const update = updateIdentity({ deviceId: 'native-owned', userId: null, userKey: null }, userId, userKey, this.config!.idMapping)
    if (!update.ok) return false
    if (update.userKeyIgnored && !this.ignoredKeyWarned) { this.ignoredKeyWarned = true; this.warn('userKey_ignored') }
    const identity = update.identity
    return this.enqueue(identity.userId === null ? { method: 'clearUserId', payload: {} }
      : { method: 'setUserId', payload: { userId: identity.userId, ...(identity.userKey === null ? {} : { userKey: identity.userKey }) } })
  }
  public clearUserId(): boolean { return this.setUserId('') }
  public setOptions(value: unknown): boolean {
    const input = record(value)
    return input !== null && Object.keys(input).length === 1 && Object.prototype.hasOwnProperty.call(input, 'dataCollect') && this.setDataCollect(input.dataCollect)
  }
  public setDataCollect(value: unknown): boolean {
    if (this.config === null || this.phase === 'disposed' || typeof value !== 'boolean') return false
    const changed = this.config.dataCollect !== value
    this.config = { ...this.config, dataCollect: value }
    if (!value && changed) this.reset('local_collection_disabled', this.phase === 'incompatible' ? 'incompatible' : 'dormant')
    else if (value && this.foreground && (this.phase === 'dormant' || this.phase === 'suspended' || this.phase === 'connected' && !this.hostOpen())) this.connect()
    return true
  }
  public setLocation(_latitude: unknown, _longitude: unknown): boolean { return this.locationUnavailable() }
  public clearLocation(): boolean { return this.locationUnavailable() }
  private locationUnavailable(): boolean {
    if (this.config !== null && this.phase !== 'disposed') this.error({ code: 'location_owned_by_host', phase: 'queue', outcome: 'not_sent' })
    return false
  }

  public autoTrack(call: AutoTrackCall, nativeEvent?: unknown): boolean {
    if (!this.canCollect() || !this.usablePage() || this.current === null || !this.registeredPluginNames().includes('gioEventAutoTracking')) return false
    try {
      const probe = record(call); const profile = this.profile
      if (probe === null || profile === null) return false
      const allowed = probe.source === 'tabbar' ? profile.tabBar : probe.kind === 'click' ? profile.autoClick
        : typeof probe.elementType === 'string' && Object.prototype.hasOwnProperty.call(profile.autoChange, probe.elementType) && profile.autoChange[probe.elementType as ChangeElement]
      if (!allowed) return false
      return this.dispatcher.dispatch(call, nativeEvent, this.current.page.pageKey, normalized => this.event(normalized.kind === 'click' ? 'VIEW_CLICK' : 'VIEW_CHANGE', {
        xpath: normalized.xpath, ...(normalized.textValue === null ? {} : { textValue: normalized.textValue }),
        ...(normalized.kind === 'click' ? { ...(normalized.index === null ? {} : { index: normalized.index }), ...(normalized.hyperlink === null ? {} : { hyperlink: normalized.hyperlink }) } : {}),
      }, this.current!.delivery))
    } catch { return false }
  }

  public onAppLaunch(entry: AppEntrySnapshot): boolean {
    if (this.config === null || this.phase === 'disposed') return false
    // 入口只用于页面来源；不缓存 query / extraData，也不发送给 hello。
    this.entryReferral = typeof entry.referralPage === 'string' && wireBytes(JSON.stringify(entry.referralPage)) <= 16000 ? entry.referralPage : null
    return true
  }
  public onAppShow(_entry: AppEntrySnapshot): boolean {
    if (this.config === null || this.phase === 'disposed') return false
    if (this.foreground) return true
    if (this.epoch >= Number.MAX_SAFE_INTEGER) { this.exhausted(); return false }
    this.epoch++; this.foreground = true
    if (this.config.dataCollect) this.connect()
    return true
  }
  public onAppHide(): boolean {
    if (this.config === null || this.phase === 'disposed') return false
    this.foreground = false
    if (this.current !== null) this.current.epoch = -1
    this.reset('local_background', this.phase === 'incompatible' ? 'incompatible' : 'dormant')
    return true
  }
  public onPageLoad(input: PageLoadInput): boolean {
    if (this.config === null || this.phase === 'disposed' || this.pageIds.size >= 50 && !this.pageIds.has(input.instanceId)) return false
    if (typeof input.route !== 'string' || typeof input.query !== 'string' || typeof input.instanceId !== 'string' || input.instanceId.length > 512) return false
    const snapshot = this.pages.onLoad(input, this.entryReferral)
    if (snapshot === null || this.boundPageMetadata(input.instanceId, snapshot) === null) return false
    this.pageIds.add(input.instanceId)
    return true
  }
  public onPageShow(instanceId: string, title: string | null): boolean {
    if (this.config === null || this.phase === 'disposed' || typeof title !== 'string' && title !== null) return false
    if (title !== null && wireBytes(JSON.stringify(title)) > 8 * 1024) { this.metadataTooLarge(); title = null }
    const timestamp = this.now()
    if (timestamp === null) return this.unavailableObservation(instanceId)
    const page = this.pages.onShow(instanceId, timestamp, title, this.entryReferral)
    if (page === null) return this.unavailableObservation(instanceId)
    const bounded = this.boundPageMetadata(instanceId, page)
    if (bounded === null) return this.unavailableObservation(instanceId)
    this.unavailableCurrent = null
    this.current = { instanceId, page: bounded, epoch: this.foreground ? this.epoch : -1, delivery: null }
    this.dispatcher.reset()
    if (this.collecting()) this.schedulePage()
    return true
  }
  public onPageHide(instanceId: string): boolean {
    if (this.config === null || this.phase === 'disposed') return false
    this.pages.onHide(instanceId)
    if (this.unavailableCurrent === instanceId) this.unavailableCurrent = null
    if (this.current?.instanceId === instanceId) { this.current = null; this.dispatcher.reset() }
    return true
  }
  public onPageUnload(instanceId: string): boolean {
    if (!this.onPageHide(instanceId)) return false
    this.pages.onUnload(instanceId); this.pageIds.delete(instanceId)
    return true
  }
  public onPageTitleChanged(instanceId: string, title: string): boolean {
    if (this.config === null || this.phase === 'disposed' || typeof title !== 'string') return false
    if (wireBytes(JSON.stringify(title)) > 8 * 1024) { this.metadataTooLarge(); return false }
    const page = this.pages.snapshot(instanceId)
    if (page === null) return false
    if (wireBytes(JSON.stringify({ ...page, title })) > 16 * 1024) { this.metadataTooLarge(); return false }
    const updated = this.pages.replaceMetadata(instanceId, { query: page.query, title, referralPage: page.referralPage })!
    if (this.current?.instanceId === instanceId) this.current.page = updated
    return true
  }

  /** 内部释放点；页面卸载不会调用它，gdp 不公开 destroy 命令。 */
  public dispose(): void {
    if (this.phase === 'disposed') return
    this.phase = 'disposed'; this.clearTimers(); this.clearQueue(); this.current = null
    this.unavailableCurrent = null
    this.pages = new PageStore(); this.pageIds.clear(); this.entryReferral = null; this.options = {}
    this.connectionId = null; this.pendingHello = null; this.deps.port.dispose()
  }

  private now(): number | null {
    try { const now = this.deps.clock.now(); return Number.isSafeInteger(now) && now >= 0 ? now : null } catch { return null }
  }
  private hostOpen(): boolean { return this.host.dataCollect && this.host.containerVisible }
  private collecting(): boolean { return this.baseGate() && !this.identityBlocked }
  private baseGate(): boolean { return this.phase === 'connected' && this.config?.dataCollect === true && this.foreground && this.hostOpen() }
  private canCollect(): boolean {
    if (this.collecting()) return true
    if (this.phase === 'connected' && this.config?.dataCollect === true && this.foreground && !this.hostOpen() && this.probeAllowed) this.connect()
    return false
  }
  private canWriteIdentity(): boolean { return this.options.penetrateHybrid !== false && this.identityWrite }
  private usablePage(): boolean {
    return this.unavailableCurrent === null && (this.current === null || this.current.epoch === this.epoch && this.current.delivery !== null && this.current.delivery.status !== 'unavailable')
  }
  private unavailableObservation(instanceId: string): false {
    this.unavailableCurrent = typeof instanceId === 'string' && instanceId.length <= 512 ? instanceId : ''
    this.current = null; this.dispatcher.reset(); return false
  }
  /** PageStore 已补齐自动来源后再执行预算，裁剪必须写回以保护隐藏及未显示页面。 */
  private boundPageMetadata(instanceId: string, page: PageSnapshot): PageSnapshot | null {
    if (wireBytes(JSON.stringify(page)) <= 16 * 1024) return page
    this.metadataTooLarge()
    const bounded = this.pages.replaceMetadata(instanceId, { query: '', title: null, referralPage: null })!
    if (wireBytes(JSON.stringify(bounded)) <= 16 * 1024) return bounded
    this.pages.onUnload(instanceId); this.pageIds.delete(instanceId)
    if (this.current?.instanceId === instanceId) this.unavailableObservation(instanceId)
    return null
  }
  private metadataTooLarge(): void { this.error({ code: 'metadata_too_large', phase: 'queue', outcome: 'not_sent' }) }
  private exhausted(): void {
    this.reset('counter_exhausted', 'incompatible')
    this.error({ code: 'counter_exhausted', phase: 'queue', outcome: 'not_sent' })
  }

  private connect(): void {
    if (this.phase === 'connecting' || this.phase === 'incompatible' || this.phase === 'disposed' || !this.foreground || this.config?.dataCollect !== true) return
    this.reset('connection_reset', 'connecting')
    this.handshakeResult = new Promise(resolve => { this.resolveHandshake = resolve })
    this.helloAttempt = 0
    const round = ++this.round
    this.probeAllowed = false
    this.cancel(this.probeTimer)
    this.probeTimer = this.deps.scheduler.setTimeout(() => { this.probeAllowed = true }, 5000)
    this.roundTimer = this.deps.scheduler.setTimeout(() => { if (this.phase === 'connecting' && round === this.round) this.handshakeFailed('handshake_timeout') }, 5000)
    this.hello()
  }
  private header(): { version: 1; instanceId: string; generation: number; requestId: number } | null {
    if (this.requestCounter >= Number.MAX_SAFE_INTEGER) { this.exhausted(); return null }
    return { version: 1, instanceId: this.instanceId, generation: this.generation, requestId: ++this.requestCounter }
  }
  private hello(): void {
    if (this.phase !== 'connecting' || this.config === null) return
    if (this.generation >= Number.MAX_SAFE_INTEGER) { this.exhausted(); return }
    this.generation++; this.helloAttempt++
    const header = this.header(); if (header === null) return
    const { appId, accountId, dataSourceId, idMapping } = this.config
    const request: UniMPRequest = { ...header, method: 'hello', payload: { appId, accountId, dataSourceId, idMapping, sdkVersion: this.deps.sdkVersion ?? SDK_VERSION } }
    this.pendingHello = request
    this.helloTimer = this.deps.scheduler.setTimeout(() => { if (this.pendingHello === request) this.retryHello('handshake_timeout') }, 1000)
    try {
      this.deps.port.request(request, reply => { void Promise.resolve().then(() => this.helloReply(request, reply)) })
    } catch (error) { this.handshakeFailed(error instanceof HybridPortFailure ? error.code : 'invoke_error') }
  }
  private retryHello(code: HybridErrorCode): void {
    this.cancel(this.helloTimer); this.pendingHello = null
    if (this.helloAttempt >= 5) { this.handshakeFailed(code); return }
    const delays = [250, 500, 1000, 1500]
    this.retryTimer = this.deps.scheduler.setTimeout(() => this.hello(), delays[this.helloAttempt - 1]!)
  }
  private handshakeFailed(code: HybridErrorCode): void {
    this.clearHandshake(); this.phase = INCOMPATIBLE.includes(code) ? 'incompatible' : 'suspended'
    this.error({ code, phase: 'handshake', method: 'hello', outcome: 'not_sent' })
  }
  private helloReply(request: UniMPRequest, raw: unknown): void {
    if (this.phase !== 'connecting' || this.pendingHello !== request) return
    let result: ReturnType<typeof validateReply>
    try { result = validateReply(raw, request, this.config!) } catch { result = { kind: 'invalid' } }
    if (result.kind === 'unrelated') return
    if (result.kind === 'invalid') { this.retryHello('invalid_reply'); return }
    const reply = result.reply
    if (reply.status === 'rejected') {
      if (reply.code === 'host_not_ready') this.retryHello(reply.code)
      else this.handshakeFailed(reply.code)
      return
    }
    const success = reply as Extract<UniMPReply, { payload: HelloPayload }>
    this.clearHandshake(true)
    this.connectionId = success.connectionId; this.host = success.payload.host; this.identityWrite = success.payload.identityWrite
    this.profile = this.deps.autoTrackProfile ?? appCapabilityProfile(success.payload.platform, typeof __GIO_AUTOTRACK_VERIFICATION__ !== 'undefined' && __GIO_AUTOTRACK_VERIFICATION__ === true)
    this.phase = 'connected'
    if (this.collecting()) this.schedulePage()
    const generation = this.generation
    void Promise.resolve().then(() => {
      if (this.phase !== 'connected' || this.generation !== generation) return
      try { this.options.onReady?.({ collecting: this.collecting(), identityBlocked: this.identityBlocked, canWriteIdentity: this.canWriteIdentity() }) }
      catch { this.warn('callback_error') }
    })
  }

  private schedulePage(): void {
    const current = this.current
    if (!this.collecting() || current === null || current.epoch !== this.epoch || current.delivery !== null) return
    if (this.pageCounter >= Number.MAX_SAFE_INTEGER) { this.exhausted(); return }
    const delivery: Delivery = { id: `${this.instanceId.slice(0, 80)}:v${++this.pageCounter}`, status: 'pending', page: current.page }
    current.delivery = delivery
    const { route: path, query, title, referralPage } = current.page
    if (!this.event('PAGE', { path, ...(query === '' ? {} : { query }), ...(title ? { title } : {}), ...(referralPage ? { referralPage } : {}) }, delivery)) delivery.status = 'unavailable'
  }
  private event(eventType: EventDraft['eventType'], fields: Record<string, unknown>, page?: Delivery | null): boolean {
    const timestamp = this.now(); if (timestamp === null) return false
    const association = page != null && eventType !== 'PAGE' ? { path: page.page.route, ...(page.page.query === '' ? {} : { query: page.page.query }) } : {}
    return this.enqueue({ method: 'dispatchEvent', payload: { event: { eventType, timestamp, ...fields, ...association }, ...(page == null ? {} : { pageViewId: page.id }) } }, page ?? undefined)
  }
  private enqueue(operation: Operation, page?: Delivery): boolean {
    if (this.connectionId === null) return false
    if (this.requestCounter >= Number.MAX_SAFE_INTEGER) { this.exhausted(); return false }
    const request: UniMPRequest = { version: 1, instanceId: this.instanceId, generation: this.generation, requestId: this.requestCounter + 1, connectionId: this.connectionId, ...operation }
    const wire = JSON.stringify(request); const bytes = wireBytes(wire)
    const identity = operation.method !== 'dispatchEvent'
    if (bytes > HYBRID_MAX_BYTES || this.queue.length + (this.inFlight === null ? 0 : 1) >= 50 || bytes + this.bytes > HYBRID_MAX_BYTES) {
      const code = bytes > HYBRID_MAX_BYTES ? 'payload_too_large' : 'local_queue_full'
      if (identity) { this.identityBlocked = true; this.reset(code, 'suspended') }
      this.error({ code, phase: 'queue', method: operation.method, outcome: 'not_sent' })
      return false
    }
    this.requestCounter++
    const entry: Entry = { wire, bytes, requestId: request.requestId, method: operation.method, ...(page === undefined ? {} : { page }),
      ...(operation.method === 'dispatchEvent' ? { eventType: operation.payload.event.eventType } : {}), timer: undefined }
    entry.timer = this.deps.scheduler.setTimeout(() => this.expire(entry), 5000)
    this.queue.push(entry); this.bytes += bytes; this.pumpSoon()
    return true
  }
  private pumpSoon(): void {
    if (this.pumping) return
    this.pumping = true
    void Promise.resolve().then(() => { this.pumping = false; this.pump() })
  }
  private pump(): void {
    if (!this.baseGate() || this.inFlight !== null) return
    const entry = this.queue.shift(); if (entry === undefined) return
    if (entry.page !== undefined && entry.eventType !== 'PAGE' && entry.page.status !== 'accepted') {
      this.release(entry); this.operationError(entry, 'page_unavailable', 'queue', 'not_sent'); this.pumpSoon(); return
    }
    this.cancel(entry.timer); this.inFlight = entry
    entry.timer = this.deps.scheduler.setTimeout(() => { if (this.inFlight === entry) this.unknown(entry, 'response_timeout') }, 1000)
    const request = JSON.parse(entry.wire) as UniMPRequest
    try { this.deps.port.request(request, raw => { void Promise.resolve().then(() => this.operationReply(entry, request, raw)) }) }
    catch { this.unknown(entry, 'invoke_error') }
  }
  private operationReply(entry: Entry, request: UniMPRequest, raw: unknown): void {
    if (this.phase !== 'connected' || this.inFlight !== entry) return
    let result: ReturnType<typeof validateReply>
    try { result = validateReply(raw, request, this.config!) } catch { result = { kind: 'invalid' } }
    if (result.kind === 'unrelated') return
    if (result.kind === 'invalid') { this.unknown(entry, 'invalid_reply'); return }
    const reply = result.reply
    if (reply.status === 'unknown' || reply.status === 'rejected' && reply.code === 'duplicate_request') { this.unknown(entry, reply.code); return }
    this.inFlight = null; this.release(entry)
    if (reply.status === 'rejected') {
      if (reply.code === 'identity_not_allowed') this.identityWrite = false
      if (entry.method !== 'dispatchEvent' || INCOMPATIBLE.includes(reply.code) || DISCONNECT.includes(reply.code)) {
        if (entry.method !== 'dispatchEvent') this.identityBlocked = true
        this.operationError(entry, reply.code, 'dispatch', 'rejected')
        this.reset(reply.code, INCOMPATIBLE.includes(reply.code) ? 'incompatible' : 'suspended')
        return
      }
      if (entry.eventType === 'PAGE') this.unavailable(entry.page!)
      this.operationError(entry, reply.code, 'dispatch', 'rejected')
    } else {
      if (entry.eventType === 'PAGE') entry.page!.status = 'accepted'
      if (entry.method !== 'dispatchEvent' && this.identityBlocked) {
        this.identityBlocked = false
        if (this.current !== null) this.current.delivery = null
      }
    }
    if ('host' in reply && reply.host !== undefined) this.host = reply.host
    if (!this.hostOpen()) {
      this.dropPending('collection_disabled')
      if (this.current !== null) this.current.delivery = null
      this.dispatcher.reset()
    } else {
      if (entry.method !== 'dispatchEvent' && this.collecting()) this.schedulePage()
      this.pumpSoon()
    }
  }
  private expire(entry: Entry): void {
    const index = this.queue.indexOf(entry); if (index < 0) return
    if (entry.method !== 'dispatchEvent') { this.identityBlocked = true; this.reset('queue_expired', 'suspended'); return }
    this.queue.splice(index, 1); this.release(entry)
    if (entry.eventType === 'PAGE') this.unavailable(entry.page!)
    this.operationError(entry, 'queue_expired', 'queue', 'not_sent'); this.pumpSoon()
  }
  private unavailable(page: Delivery): void {
    page.status = 'unavailable'
    const dependents = this.queue.filter(entry => entry.page === page && entry.eventType !== 'PAGE')
    this.queue = this.queue.filter(entry => !dependents.includes(entry))
    for (const entry of dependents) { this.release(entry); this.operationError(entry, 'page_unavailable', 'queue', 'not_sent') }
  }
  private unknown(entry: Entry, code: HybridErrorCode): void {
    if (this.inFlight !== entry) return
    this.inFlight = null; this.release(entry)
    if (entry.method !== 'dispatchEvent') this.identityBlocked = true
    this.operationError(entry, code, 'dispatch', 'unknown'); this.reset(code, 'suspended')
  }
  private release(entry: Entry): void { this.cancel(entry.timer); this.bytes -= entry.bytes }
  private dropPending(code: HybridErrorCode): void {
    const pending = this.queue
    this.queue = []
    const identity = pending.find(entry => entry.method !== 'dispatchEvent')
    if (identity !== undefined) this.identityBlocked = true
    for (const entry of pending) { if (entry.eventType === 'PAGE') entry.page!.status = 'unavailable'; this.release(entry) }
    const selected = identity ?? pending[0]
    if (selected !== undefined) this.operationError(selected, code, 'queue', 'not_sent', pending.length)
    if (identity !== undefined && this.phase === 'connected') {
      this.phase = 'suspended'; this.connectionId = null; this.host = CLOSED_HOST
    }
  }
  private reset(code: HybridErrorCode, phase: Phase): void {
    this.clearHandshake()
    this.cancel(this.probeTimer); this.probeTimer = undefined; this.probeAllowed = true
    const current = this.inFlight
    this.inFlight = null
    if (current !== null) {
      if (current.method !== 'dispatchEvent') this.identityBlocked = true
      this.release(current); this.operationError(current, code, 'dispatch', 'unknown')
    }
    this.dropPending(code)
    this.phase = phase; this.host = CLOSED_HOST; this.connectionId = null; this.identityWrite = false
    if (this.current !== null) this.current.delivery = null
    this.dispatcher.reset()
  }
  private clearQueue(): void {
    for (const entry of this.queue) this.cancel(entry.timer)
    if (this.inFlight !== null) this.cancel(this.inFlight.timer)
    this.queue = []; this.inFlight = null; this.bytes = 0
  }
  private clearHandshake(ready = false): void {
    this.cancel(this.roundTimer); this.cancel(this.helloTimer); this.cancel(this.retryTimer)
    this.roundTimer = this.helloTimer = this.retryTimer = undefined; this.pendingHello = null
    this.resolveHandshake?.(ready); this.resolveHandshake = null; this.handshakeResult = null
  }
  private clearTimers(): void { this.clearHandshake(); this.cancel(this.probeTimer) }
  private cancel(handle: unknown): void { if (handle !== undefined) this.deps.scheduler.clearTimeout(handle) }
  private operationError(entry: Entry, code: HybridErrorCode, phase: HybridError['phase'], outcome: HybridError['outcome'], droppedCount?: number): void {
    this.error({ code, phase, method: entry.method, requestId: entry.requestId, outcome, ...(entry.eventType === undefined ? {} : { eventType: entry.eventType }), ...(droppedCount === undefined ? {} : { droppedCount }) })
  }
  private error(error: HybridError): void {
    void Promise.resolve().then(() => {
      if (this.phase === 'disposed') return
      try { this.options.onError?.(error) } catch { this.warn('callback_error') }
    })
  }
  private warn(code: string): void { try { this.deps.warn?.(`[GrowingIO]: ${code}`) } catch { /* 日志不得改变队列。 */ } }
}
