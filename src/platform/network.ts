import type { NetworkPort, NetworkState } from '../types/index.js'

export interface AppNetworkApi {
  /** 查询当前网络类型，允许宿主通过 success 或 fail 异步返回。 */
  getNetworkType(options: Readonly<{
    /** 返回原始网络类型，由端口转换为协议枚举。 */
    success: (result: Readonly<{ networkType?: unknown }>) => void
    /** 查询失败时由端口决定 Native.js 兜底。 */
    fail: () => void
  }>): void
  /** 可选网络通知能力，连接布尔值与网络名称分别解释。 */
  onNetworkStatusChange?(listener: (result: Readonly<{ networkType?: unknown; isConnected?: unknown }>) => void): void
  /** 可选取消订阅能力，仅移除传入监听器。 */
  offNetworkStatusChange?(listener: (result: Readonly<{ networkType?: unknown; isConnected?: unknown }>) => void): void
}

/** 将宿主网络名称转换为协议枚举；明确离线或未知值使用 UNKNOWN。 */
export function normalizeAppNetworkState(value: unknown, isConnected: unknown = true): NetworkState {
  if (isConnected === false || typeof value !== 'string') return 'UNKNOWN'
  const state = value.trim().toLowerCase()
  if (state === 'wifi') return 'WIFI'
  if (state === '2g') return '2G'
  if (state === '3g') return '3G'
  if (state === '4g') return '4G'
  if (state === '5g') return '5G'
  return 'UNKNOWN'
}

type NetworkSnapshot = Readonly<{ state: NetworkState; connected: boolean | null }>
/** 分别解析协议网络类型和实际连接状态，避免把 UNKNOWN 直接视作离线。 */
function snapshot(value?: unknown, isConnected?: unknown): NetworkSnapshot {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : ''
  const connected = isConnected === false || type === 'none' ? false
    : isConnected === true || ['wifi', '2g', '3g', '4g', '5g', 'cellular', 'ethernet'].includes(type) ? true : null
  return { state: normalizeAppNetworkState(value, connected !== false), connected }
}

/** 在标准查询不可用时读取 Native.js 网络信息，不可确认时保持未知。 */
function plusNetworkState(): NetworkSnapshot {
  const plus = (globalThis as Readonly<Record<string, unknown>>).plus
  if (typeof plus !== 'object' || plus === null || Array.isArray(plus)) return snapshot()
  const networkInfo = (plus as Readonly<Record<string, unknown>>).networkinfo
  if (typeof networkInfo !== 'object' || networkInfo === null || Array.isArray(networkInfo)) return snapshot()
  const source = networkInfo as Readonly<Record<string, unknown>>
  if (typeof source.getCurrentType !== 'function') return snapshot()
  try {
    const current = (source.getCurrentType as () => unknown)()
    for (const type of ['none', 'wifi', '2g', '3g', '4g', '5g', 'cellular', 'ethernet']) {
      const constant = source[`CONNECTION_${type.toUpperCase()}`]
      if (constant !== undefined && current === constant) return snapshot(type)
    }
    return snapshot(current)
  } catch {
    return snapshot()
  }
}

/** 封装 App 的网络查询与通知，无法识别时安全回退 UNKNOWN。 */
export class AppNetworkPort implements NetworkPort {
  private state: NetworkState = 'UNKNOWN'
  private connected: boolean | null = null
  private revision = 0
  private reading: Promise<NetworkState> | null = null
  /** 保存网络宿主 API，查询与通知订阅按需执行。 */
  public constructor(private readonly api: AppNetworkApi) {}

  /** 返回最近可确认的连接状态；null 表示尚未确认。 */
  public isConnected(): boolean | null { return this.connected }
  /** 读取当前最佳缓存值，不等待异步宿主回调。 */
  public cached(): NetworkState { return this.state }

  /** 更新网络类型，但未知连接结果不能解除此前已确认的断网状态。 */
  private update(value: NetworkSnapshot): void {
    this.state = value.state
    // 查询超时/失败不代表已经联网，不能解除此前明确的断网状态。
    if (value.connected !== null) this.connected = value.connected
  }

  /** 合并并发查询并设定兜底期限，迟到结果不能覆盖更新的宿主通知。 */
  public current(): Promise<NetworkState> {
    if (this.reading !== null) return this.reading
    if (this.revision === 0) this.update(plusNetworkState())
    const revision = ++this.revision
    const reading = new Promise<NetworkState>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof globalThis.setTimeout> | null = null
      /** 一次性结束本次查询，清理超时并按版本决定是否采纳结果。 */
      const finish = (value: NetworkSnapshot): void => {
        if (settled) return
        settled = true
        if (timeout !== null) globalThis.clearTimeout(timeout)
        // 查询过程中到达的网络通知优先，迟到的查询不能覆盖更新的断网状态。
        if (revision === this.revision) this.update(value)
        resolve(this.state)
      }
      timeout = globalThis.setTimeout(() => finish(plusNetworkState()), 1000)
      try {
        this.api.getNetworkType({
          /** 将标准网络查询结果转换为类型与连接状态快照。 */
          success: (result) => finish(snapshot(result.networkType)),
          /** 标准查询失败时使用 Native.js 兜底，不直接假定已连接。 */
          fail: () => finish(plusNetworkState())
        })
      } catch {
        finish(plusNetworkState())
      }
    })
    this.reading = reading
    /** 只释放仍属于本次查询的缓存 Promise，避免清理后续读取。 */
    const clearReading = (): void => { if (this.reading === reading) this.reading = null }
    void reading.then(clearReading, clearReading)
    return reading
  }

  /** 转发宿主网络通知并返回安全取消订阅方法；缺失能力时使用空取消函数。 */
  public subscribe(listener: (state: NetworkState) => void): () => void {
    if (typeof this.api.onNetworkStatusChange !== 'function') return () => undefined
    /** 以新修订号应用网络通知，使旧查询结果失效。 */
    const hostListener = (result: Readonly<{ networkType?: unknown; isConnected?: unknown }>): void => {
      this.revision++
      this.update(snapshot(result.networkType, result.isConnected))
      listener(this.state)
    }
    try {
      this.api.onNetworkStatusChange(hostListener)
    } catch {
      return () => undefined
    }
    return () => {
      try {
        this.api.offNetworkStatusChange?.(hostListener)
      } catch {
        // 取消订阅仅尽力执行，一期没有公开的销毁生命周期。
      }
    }
  }
}
