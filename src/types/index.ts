export type AppPlatform = 'Android' | 'iOS' | 'HarmonyOS'
export type MiniProgramTarget = 'mp-weixin' | 'mp-alipay'
export type MiniProgramPlatform = 'MinP' | 'alip'
export type NetworkState = '2G' | '3G' | '4G' | '5G' | 'WIFI' | 'UNKNOWN'

export type AppSystemContext = Readonly<{
  platform: AppPlatform
  platformVersion: string
  domain: string
  appState: 'FOREGROUND' | 'BACKGROUND'
  appName: string
  networkState: NetworkState
  screenWidth: number
  screenHeight: number
  deviceBrand: string
  deviceModel: string
  deviceType: 'PHONE' | 'PAD' | 'FOLD' | 'UNKNOWN'
  appVersion: string
  language: string
  sdkVersion: string
}>

/** 小程序只携带自己的协议字段，不以 App 的操作系统枚举代替宿主。 */
export type MiniProgramSystemContext = Readonly<Omit<AppSystemContext, 'platform' | 'appState' | 'appName' | 'deviceType'> & {
  platform: MiniProgramPlatform
  deviceType: string
  operatingSystem: string
}>
export type SystemContext = AppSystemContext | MiniProgramSystemContext

export interface SystemContextPort {
  /** 加载已归一化的 App 系统上下文，不向核心返回原始宿主对象。 */
  load(): Promise<SystemContext>
}

export interface ClockPort {
  /** 返回当前毫秒时间戳，用于事件生成和生命周期观察。 */
  now(): number
}

export interface TimezonePort {
  /** 返回本地相对 UTC 的偏移分钟数，沿用 Date.getTimezoneOffset 的符号。 */
  getOffsetMinutes(): number
}

/** 核心通过本端口输出固定诊断与即将派发的协议事件 JSON。 */
export interface LoggerPort {
  /** 输出普通运行状态，不携带原始业务对象。 */
  info(message: string): void
  /** 输出初始化等阶段完成信息。 */
  success(message: string): void
  /** 输出固定警告或降级原因。 */
  warn(message: string): void
  /** 输出初始化或运行失败诊断。 */
  error(message: string): void
  /** 输出操作标签或已清理的协议事件，仅由调试门控调用。 */
  debug(message: string, data?: unknown): void
}

/** 协议网络类型与连接状态分开；UNKNOWN 不能直接当成断网。 */
export interface NetworkPort {
  /** 异步读取网络类型，未知类型不能自行推断为断网。 */
  current(): Promise<NetworkState>
  /** 返回最近可确认的连接状态，null 表示尚未确认。 */
  isConnected(): boolean | null
  /** 监听网络状态并返回只释放本订阅的取消函数。 */
  subscribe(listener: (state: NetworkState) => void): () => void
}

export type StorageArea = 'state' | 'queue'
export type StorageRead =
  | Readonly<{ kind: 'value'; value: string }>
  | Readonly<{ kind: 'missing' | 'unavailable' | 'corrupt'; message?: string }>
export type StorageWrite =
  | Readonly<{ kind: 'ok' }>
  | Readonly<{ kind: 'unavailable' | 'quota' | 'failed'; message?: string }>

/** 平台适配器负责宿主存储调用，核心负责记录编码和校验。 */
export interface StoragePort {
  readonly persistentQueue: boolean
  /** 按 SDK 命名空间键读取记录，明确区分缺失、损坏和不可用。 */
  read(area: StorageArea, key: string): Promise<StorageRead>
  /** 写入已编码的字符串；核心仅以 ok 作为持久化成功依据。 */
  write(area: StorageArea, key: string, value: string): Promise<StorageWrite>
  /** 只删除指定键，不能清空宿主存储或其他 SDK 数据。 */
  remove(area: StorageArea, key: string): Promise<StorageWrite>
}

export type TransportRequest = Readonly<{
  url: string
  method: 'POST'
  headers: Readonly<Record<string, string>>
  body: string
  timeoutMs: number
}>

export type TransportResult =
  | Readonly<{ kind: 'success'; status: number }>
  | Readonly<{ kind: 'http'; status: number; responseText?: string }>
  | Readonly<{ kind: 'network' | 'timeout' | 'aborted' | 'unsupported'; message?: string }>

export type TransportHandle = Readonly<{
  /** 尽力中止当前请求；结果是否结算仍由上层请求结算器决定。 */
  abort?: () => void
}>

export interface TransportPort {
  /** 派发单批请求并回调标准结果，不在宿主层实现批次或重试策略。 */
  dispatch(request: TransportRequest, done: (result: TransportResult) => void): TransportHandle | void
}
