import { normalizeInitOptions, type GioInitOptions, type ResolvedGioConfig } from '../constants/config.js'
import type { EventSequenceSnapshot } from './dataStore/index.js'
import type { IdentityHydration, QueueHydration, SessionHydration } from './storage/index.js'
import type { SystemContext } from '../types/index.js'

export type GioBuiltinPlugin = Readonly<{
  name: 'gioEventAutoTracking'
  options?: Readonly<Record<string, never>>
}>

export type PluginRegistrationCode = 'plugin_invalid' | 'plugin_duplicate' | 'plugin_registration_closed'
export type PluginRegistrationResult = Readonly<{ ok: true } | { ok: false; code: PluginRegistrationCode }>

/** 只接受已交付插件名称及空选项对象，避免虚假能力声明。 */
function isBuiltinPlugin(value: unknown): value is GioBuiltinPlugin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, unknown>>
  if (record.name !== 'gioEventAutoTracking') return false
  return record.options === undefined
    || (typeof record.options === 'object' && record.options !== null && !Array.isArray(record.options) && Object.keys(record.options).length === 0)
}

/** 只登记插件声明，实际安装由首次有效初始化后的运行时负责。 */
export class BuiltinPluginRegistry {
  private readonly registered = new Map<string, GioBuiltinPlugin>()
  private registrationOpen = true

  /** 整批校验后才登记插件；非法、重复或已关闭的注册不产生部分写入。 */
  public register(...plugins: unknown[]): PluginRegistrationResult {
    if (!this.registrationOpen) return { ok: false, code: 'plugin_registration_closed' }
    const names = new Set<string>()
    for (const plugin of plugins) {
      if (!isBuiltinPlugin(plugin)) return { ok: false, code: 'plugin_invalid' }
      if (names.has(plugin.name) || this.registered.has(plugin.name)) return { ok: false, code: 'plugin_duplicate' }
      names.add(plugin.name)
    }
    for (const plugin of plugins as GioBuiltinPlugin[]) this.registered.set(plugin.name, plugin)
    return { ok: true }
  }

  /** 仅在配置校验成功后关闭注册；初始化参数失败时保持注册窗口开放。 */
  public closeRegistration(): void {
    this.registrationOpen = false
  }

  /** 返回按注册顺序排列的插件声明列表副本。 */
  public plugins(): readonly GioBuiltinPlugin[] {
    return [...this.registered.values()]
  }
}

export type TrackerStatus = 'new' | 'initializing' | 'ready'
export type TrackerInitResult =
  | Readonly<{ ok: true; config: ResolvedGioConfig }>
  | Readonly<{ ok: false; code: 'invalid_config' | 'already_initialized' }>

export type DataCollectTransition = Readonly<{
  ok: boolean
  changed: boolean
  sessionRenewalRequired: boolean
}>

/** 只管理公开初始化和插件注册的顺序。存储与系统上下文就绪后，由运行时完成恢复，事件不能绕过启动门控。 */
export class TrackerLifecycle {
  private statusValue: TrackerStatus = 'new'
  private configValue: ResolvedGioConfig | null = null
  private readonly plugins = new BuiltinPluginRegistry()

  public constructor(private readonly target?: import('../types/index.js').MiniProgramTarget) {}

  /** 通过注册表校验初始化前的内置插件声明。 */
  public registerPlugins(...plugins: GioBuiltinPlugin[]): boolean {
    return this.plugins.register(...plugins).ok
  }

  /** 仅允许首次有效初始化；配置通过后冻结插件注册并进入恢复阶段。 */
  public init(options: GioInitOptions): TrackerInitResult {
    if (this.statusValue !== 'new') return { ok: false, code: 'already_initialized' }
    const normalized = normalizeInitOptions(options, this.target)
    if (!normalized.ok) return { ok: false, code: 'invalid_config' }
    this.configValue = normalized.config
    this.statusValue = 'initializing'
    this.plugins.closeRegistration()
    return { ok: true, config: normalized.config }
  }

  /** 只允许从 initializing 转为 ready，防止重复释放暂存调用。 */
  public markReady(): boolean {
    if (this.statusValue !== 'initializing') return false
    this.statusValue = 'ready'
    return true
  }

  /** 唯一可变的初始化选项，后续 VISIT 和 PAGE 补发由生命周期路由负责。 */
  public setDataCollect(value: unknown): DataCollectTransition {
    if (this.configValue === null || typeof value !== 'boolean') return { ok: false, changed: false, sessionRenewalRequired: false }
    if (this.configValue.dataCollect === value) return { ok: true, changed: false, sessionRenewalRequired: false }
    const wasEnabled = this.configValue.dataCollect
    this.configValue = { ...this.configValue, dataCollect: value }
    return { ok: true, changed: true, sessionRenewalRequired: !wasEnabled && value }
  }

  /** 读取初始化状态机当前阶段。 */
  public status(): TrackerStatus {
    return this.statusValue
  }

  /** 读取已归一化配置；首次有效初始化前返回 null。 */
  public config(): ResolvedGioConfig | null {
    return this.configValue
  }

  /** 取得已通过校验的插件声明，供运行时能力门控使用。 */
  public registeredPlugins(): readonly GioBuiltinPlugin[] {
    return this.plugins.plugins()
  }
}

export const MAX_BOOTSTRAP_BUFFER_ITEMS = 50
export const MAX_BOOTSTRAP_BUFFER_BYTES = 256 * 1024

export type BootstrapBufferLimits = Readonly<{ maxItems: number; maxBytes: number }>

const DEFAULT_LIMITS: BootstrapBufferLimits = {
  maxItems: MAX_BOOTSTRAP_BUFFER_ITEMS,
  maxBytes: MAX_BOOTSTRAP_BUFFER_BYTES,
}

/** 计算 JSON 快照的 UTF-8 字节数，合法代理对按四字节计。 */
function utf8ByteLength(value: string): number {
  let size = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit <= 0x7f) size += 1
    else if (unit <= 0x7ff) size += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      size += 4
      index += 1
    } else size += 3
  }
  return size
}

/** 状态和系统上下文恢复前保存有界 JSON 快照，不驱逐先前意图。 */
export class BootstrapBuffer {
  private readonly serialized: string[] = []

  /** 注入初始化暂存的条数和字节上限。 */
  public constructor(private readonly limits: BootstrapBufferLimits = DEFAULT_LIMITS) {}

  /** 将意图冻结为 JSON；不可序列化或超限时拒绝新意图，不驱逐旧记录。 */
  public push(intent: unknown): boolean {
    let value: string | undefined
    try {
      value = JSON.stringify(intent)
    } catch {
      return false
    }
    if (value === undefined || this.serialized.length >= this.limits.maxItems) return false
    const candidate = `[${this.serialized.concat(value).join(',')}]`
    if (utf8ByteLength(candidate) > this.limits.maxBytes) return false
    this.serialized.push(value)
    return true
  }

  /** 按原顺序取出并清空暂存意图，返回独立解析后的快照。 */
  public drain(): readonly unknown[] {
    const values = JSON.parse(`[${this.serialized.join(',')}]`) as unknown[]
    this.serialized.splice(0, this.serialized.length)
    return values
  }

  /** 读取当前暂存的意图条数。 */
  public size(): number {
    return this.serialized.length
  }
}

export type TrackerIntent = Readonly<{ kind: string; payload: Readonly<Record<string, unknown>>; collecting?: boolean; observedAt?: number }>
type BufferedIntent = Readonly<{ order: number; intent: TrackerIntent }>
const lifecycleKinds = new Set(['app-launch', 'app-show', 'app-hide', 'page-load', 'page-show', 'page-hide', 'page-unload', 'page-title', 'collection-resume'])

/** 约束公开调用顺序，禁止初始化期间的事件绕过状态恢复。 */
export class TrackerEventGate {
  private nextOrder = 0
  // 生命周期独立保留相同的条数/字节上限，业务突发不能阻止首屏建立会话。
  private readonly lifecycleBuffer = new BootstrapBuffer()
  /** 绑定初始化状态，并为生命周期和业务调用保留独立暂存容量。 */
  public constructor(
    private readonly lifecycle: TrackerLifecycle,
    private readonly buffer: BootstrapBuffer = new BootstrapBuffer(),
  ) {}

  /** 仅接纳同意采集后的业务意图；初始化期间暂存，就绪后隔离异常执行。 */
  public submit(intent: TrackerIntent, emit: (intent: TrackerIntent) => boolean): boolean {
    const config = this.lifecycle.config()
    if (config === null || !config.dataCollect) return false
    intent = { ...intent, collecting: config.dataCollect }
    if (this.lifecycle.status() === 'initializing') return this.buffer.push({ order: this.nextOrder++, intent })
    if (this.lifecycle.status() !== 'ready') return false
    try {
      return emit(intent)
    } catch {
      return false
    }
  }

  /** 关闭采集时仍需回放必要生命周期状态，行为事件由各生命周期路由抑制。 */
  public submitLifecycle(intent: TrackerIntent, emit: (intent: TrackerIntent) => boolean): boolean {
    if (this.lifecycle.config() === null) return false
    intent = { ...intent, collecting: this.lifecycle.config()?.dataCollect }
    if (this.lifecycle.status() === 'initializing') {
      const buffer = lifecycleKinds.has(intent.kind) ? this.lifecycleBuffer : this.buffer
      return buffer.push({ order: this.nextOrder++, intent })
    }
    if (this.lifecycle.status() !== 'ready') return false
    try {
      return emit(intent)
    } catch {
      return false
    }
  }

  /** 全部恢复依赖就绪后，按原调用顺序释放有界 JSON 快照。 */
  public release(emit: (intent: TrackerIntent) => boolean): boolean {
    if (!this.lifecycle.markReady()) return false
    const buffered = [...this.buffer.drain(), ...this.lifecycleBuffer.drain()].filter(isBufferedIntent)
    for (const value of buffered.sort((a, b) => a.order - b.order)) {
      try {
        emit(value.intent)
      } catch {
        // 单个意图失败不能阻塞后续暂存的生命周期或业务调用。
      }
    }
    return true
  }

  /** 返回业务与生命周期两个暂存区的合计条数。 */
  public bufferedCount(): number {
    return this.buffer.size() + this.lifecycleBuffer.size()
  }
}

/** 校验暂存记录的顺序号和意图结构，过滤损坏快照。 */
function isBufferedIntent(value: unknown): value is BufferedIntent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Readonly<Record<string, unknown>>
  return Number.isSafeInteger(record.order) && isIntent(record.intent)
}

/** 确认内部意图包含字符串种类及非数组对象载荷。 */
function isIntent(value: unknown): value is TrackerIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, unknown>>
  return typeof record.kind === 'string' && typeof record.payload === 'object' && record.payload !== null && !Array.isArray(record.payload)
}

export type HydratedTrackerState = Readonly<{
  identity: IdentityHydration
  session: SessionHydration
  meta: Readonly<{ snapshot: EventSequenceSnapshot; source: string }>
  queue: QueueHydration
  systemContext: SystemContext
}>

export type HydrationDependencies = Readonly<{
  /** 独立恢复设备与登录身份记录。 */
  hydrateIdentity: () => Promise<IdentityHydration>
  /** 独立恢复会话快照及其读取来源。 */
  hydrateSession: () => Promise<SessionHydration>
  /** 独立恢复全局事件序号及其读取来源。 */
  hydrateMeta: () => Promise<Readonly<{ snapshot: EventSequenceSnapshot; source: string }>>
  /** 恢复并验证持久化队列。 */
  hydrateQueue: () => Promise<QueueHydration>
  /** 加载可用于构建协议事件的系统上下文。 */
  loadSystemContext: () => Promise<SystemContext>
}>

export type HydrationResult =
  | Readonly<{ ok: true; state: HydratedTrackerState }>
  | Readonly<{ ok: false; code: 'system_context_unavailable' }>

/** 统一就绪门槛：所有状态记录和系统上下文恢复后才释放暂存事件。 */
export async function hydrateTrackerState(dependencies: HydrationDependencies): Promise<HydrationResult> {
  try {
    const [identity, session, meta, queue, systemContext] = await Promise.all([
      dependencies.hydrateIdentity(),
      dependencies.hydrateSession(),
      dependencies.hydrateMeta(),
      dependencies.hydrateQueue(),
      dependencies.loadSystemContext(),
    ])
    return { ok: true, state: { identity, session, meta, queue, systemContext } }
  } catch {
    return { ok: false, code: 'system_context_unavailable' }
  }
}
