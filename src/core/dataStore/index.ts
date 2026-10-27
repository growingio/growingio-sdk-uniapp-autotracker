import { type AppEventType, buildAppEvent, type ProtocolEvent, normalizeAttributes } from './protocol.js'
import type { ResolvedGioConfig } from '../../constants/config.js'
import { type Identity, LocationState, SessionManager } from '../userStore.js'
import type { AppSystemContext, ClockPort, NetworkState, TimezonePort } from '../../types/index.js'
import { EventQueue } from '../queue.js'
import type { PageSnapshot } from './page.js'
import type { NormalizedAutoTrackCall } from '../../plugins/gioEventAutoTracking/contract.js'

const SEQUENCED_EVENT_TYPES = new Set<AppEventType>([
  'VISIT',
  'PAGE',
  'CUSTOM',
  'VIEW_CLICK',
  'VIEW_CHANGE',
])

export type EventSequenceSnapshot = Readonly<{ eventSequenceId: number }>

/** 所有需要序号的事件共用一个单调递增计数器，存储模块独立持久化该计数，避免身份或会话故障影响它。 */
export class EventSequence {
  private currentValue: number

  /** 从合法非负安全整数恢复全局序号；损坏值按零处理。 */
  public constructor(initialValue: number | null | undefined = 0) {
    this.currentValue = typeof initialValue === 'number' && Number.isSafeInteger(initialValue) && initialValue >= 0 ? initialValue : 0
  }

  /** 返回当前事件序号快照，供独立持久化使用。 */
  public current(): EventSequenceSnapshot {
    return { eventSequenceId: this.currentValue }
  }

  /** 仅为需要序号的事件提交下一个编号；达到安全整数上限时拒绝增长。 */
  public next(eventType: AppEventType): number | null {
    const next = this.peek(eventType)
    if (next !== null) this.currentValue = next
    return next
  }

  /** 预读下一序号，允许组装器先校验并入队，再提交计数。 */
  public peek(eventType: AppEventType): number | null {
    if (!SEQUENCED_EVENT_TYPES.has(eventType)) return null
    if (this.currentValue >= Number.MAX_SAFE_INTEGER) throw new Error('event_sequence_overflow')
    return this.currentValue + 1
  }
}

export type EventComposeInput = Readonly<{
  eventType: AppEventType
  /** 事件专属协议字段；公共字段由可信运行时上下文补齐。 */
  fields?: Readonly<Record<string, unknown>>
  /** 由可信生命周期路由捕获，保证事件与页面上下文共用同一时间戳。 */
  timestamp?: number
  appState?: AppSystemContext['appState']
}>

export type EventComposeResult =
  | Readonly<{ ok: true; event: ProtocolEvent; requestId: string }>
  | Readonly<{
    ok: false
    code: 'missing_session' | 'invalid_timestamp' | 'invalid_event_type' | 'missing_required_field'
      | 'invalid_custom_event_name' | 'invalid_field_value' | 'event_not_serializable' | 'event_too_large' | 'queue_full'
  }>

/** 读取并规范时区偏移分钟数；宿主不可用时使用零偏移。 */
function timezoneOffset(timezone: TimezonePort): string {
  try {
    const value = timezone.getOffsetMinutes()
    return Number.isFinite(value) ? String(Math.trunc(value)) : '0'
  } catch {
    return '0'
  }
}

/** 结合稳定系统上下文和当前可变状态组装事件。先用占位序号校验，再在成功入队后递增，避免拒绝事件留下序号缺口。 */
export class EventComposer {
  private appState: AppSystemContext['appState'] = 'FOREGROUND'
  /** 注入事件所需的稳定配置、动态状态和宿主端口，不提前生成事件。 */
  public constructor(
    private readonly config: ResolvedGioConfig,
    private readonly system: AppSystemContext,
    private readonly identity: () => Identity,
    private readonly sessions: SessionManager,
    private readonly sequence: EventSequence,
    private readonly queue: EventQueue,
    private readonly clock: ClockPort,
    private readonly timezone: TimezonePort,
    private readonly location: LocationState,
    private readonly network: (() => NetworkState) | undefined = undefined,
  ) {}

  /** 更新后续事件采用的前后台状态。 */
  public setAppState(value: AppSystemContext['appState']): void { this.appState = value }

  /** 补齐可信公共字段并验证协议，入队成功后才提交序号。成功仅表示本地接纳，不表示服务端收数。 */
  public compose(input: EventComposeInput): EventComposeResult {
    const session = this.sessions.current()
    if (session === null) return { ok: false, code: 'missing_session' }

    let timestamp: number
    try {
      timestamp = input.timestamp ?? this.clock.now()
    } catch {
      return { ok: false, code: 'invalid_timestamp' }
    }
    if (!Number.isFinite(timestamp) || timestamp < 0) return { ok: false, code: 'invalid_timestamp' }

    const identity = this.identity()
    const base = {
      ...this.system,
      ...input.fields,
      deviceId: identity.deviceId,
      userId: identity.userId,
      userKey: identity.userKey,
      sessionId: session.sessionId,
      dataSourceId: this.config.dataSourceId,
      timestamp,
      appState: input.appState ?? this.appState,
      appChannel: this.config.appChannel,
      networkState: this.networkState(),
      timezoneOffset: timezoneOffset(this.timezone),
      ...(this.location.current() ?? {}),
    }

    // buildAppEvent 是纯函数，占位序号校验不会改变运行时状态。
    const preview = buildAppEvent(input.eventType, { ...base, eventSequenceId: 1 })
    if (!preview.ok) return preview

    const eventSequenceId = this.sequence.peek(input.eventType)
    const built = eventSequenceId === null
      ? preview
      : buildAppEvent(input.eventType, { ...base, eventSequenceId })
    if (!built.ok) return built

    const enqueued = this.queue.enqueue(built.event)
    if (!enqueued.ok) return enqueued
    if (eventSequenceId !== null) this.sequence.next(input.eventType)
    return { ok: true, event: built.event, requestId: enqueued.requestId }
  }

  /** 优先采用最新有效网络类型，读取失败时退回初始系统上下文。 */
  private networkState(): NetworkState {
    try {
      const state = this.network?.()
      return state === '2G' || state === '3G' || state === '4G' || state === '5G' || state === 'WIFI' || state === 'UNKNOWN'
        ? state : this.system.networkState
    } catch {
      return this.system.networkState
    }
  }
}

export type TrackIntent = Readonly<{
  eventName: unknown
  properties?: unknown
}>

/** 将手动事件、用户属性和自动采集意图转换为协议事件；就绪和采集门控由调用方负责，不接受任意原始报文。 */
export class EventDispatcher {
  /** 绑定事件组装器和当前页面读取器，统一业务意图到协议事件的转换。 */
  public constructor(
    private readonly composer: EventComposer,
    private readonly currentPage: () => PageSnapshot | null,
  ) {}

  /** 生成 CUSTOM，规范属性并附加当前页面的路由和 query。 */
  public track(intent: TrackIntent): boolean {
    const page = this.currentPage()
    const attributes = Object.fromEntries(this.attributes(intent.properties))
    return this.composer.compose({
      eventType: 'CUSTOM',
      fields: {
        eventName: intent.eventName,
        attributes,
        ...(page === null ? {} : {
          path: page.route,
          query: page.query,
        }),
      },
    }).ok
  }

  /** 用户属性独立于当前页面，不分配事件序号。 */
  public setUserAttributes(properties: unknown): boolean {
    return this.composer.compose({
      eventType: 'LOGIN_USER_ATTRIBUTES',
      fields: { attributes: Object.fromEntries(this.attributes(properties)) },
    }).ok
  }

  /** VIEW 事件必须关联当前已显示页面，宿主组件对象不能进入事件组装器。 */
  public autoTrack(normalized: NormalizedAutoTrackCall): boolean {
    const page = this.currentPage()
    if (page === null || page.shownAt === null) return false
    return this.composer.compose({
      eventType: normalized.kind === 'click' ? 'VIEW_CLICK' : 'VIEW_CHANGE',
      fields: {
        path: page.route,
        query: page.query,
        xpath: normalized.xpath,
        textValue: normalized.textValue,
        ...(normalized.kind === 'click' ? { index: normalized.index, hyperlink: normalized.hyperlink } : {}),
      },
    }).ok
  }

  /** 复用协议层属性规则，输出仅含字符串值的属性集合。 */
  private attributes(properties: unknown): ReadonlyMap<string, string> {
    return normalizeAttributes(properties).attributes
  }
}
