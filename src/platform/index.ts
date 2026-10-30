import type { ResolvedGioConfig } from '../constants/config.js'
import type { DeviceIdFactory } from '../core/storage/index.js'
import type { SessionIdFactory } from '../core/userStore.js'
import { OrientationResolver, type PageOrientation } from '../core/dataStore/page.js'
import { TrackerRuntime } from '../core/growingIO.js'
import { installAutoTrackDispatcher } from '../plugins/gioEventAutoTracking/index.js'
import { AppRequestPort, type AppRequestApi, AppStoragePort, type AppStorageApi } from './uni.js'
import { AppNetworkPort, type AppNetworkApi } from './network.js'
import { AppSystemContextPort, type AppSystemApi } from './system.js'
import type { MiniProgramTarget, SystemContextPort } from '../types/index.js'
import { AppNativeIdentifiersPort, type NativePluginHost } from './native-identifiers.js'

export type AppRuntimeHost = AppStorageApi & AppRequestApi & AppSystemApi & AppNetworkApi
export type UniRuntimeHost = AppStorageApi & AppRequestApi & AppNetworkApi & Partial<AppSystemApi>

export type AppRuntimeOptions = Readonly<{
  sdkVersion: string
  deviceIdFactory: DeviceIdFactory
  sessionIdFactory: SessionIdFactory
}>

/** 读取窗口方向并复用最近有效方向，宿主失败时由方向解析器安全兜底。 */
function orientationReader(host: Partial<AppSystemApi>): () => PageOrientation {
  const resolver = new OrientationResolver()
  return () => {
    try {
      const value = host.getSystemInfoSync?.()
      const system = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {}
      return resolver.resolve({
        deviceOrientation: system.deviceOrientation,
        windowWidth: system.windowWidth,
        windowHeight: system.windowHeight,
      })
    } catch {
      return resolver.resolve({})
    }
  }
}

/** 从真实 uni 宿主装配 App 运行时，核心通过端口使用能力，不接收 uni 对象。 */
export function createAppTracker(host: AppRuntimeHost, options: AppRuntimeOptions): TrackerRuntime {
  return createUniTracker(host, options, config => new AppSystemContextPort(host, options.sdkVersion, config.appVersionFallback))
}

/** uni 的存储、网络、请求与调度共用同一装配，系统字段和运行策略由目标提供。 */
export function createUniTracker(host: UniRuntimeHost, options: AppRuntimeOptions, context: (config: ResolvedGioConfig) => SystemContextPort, target?: MiniProgramTarget): TrackerRuntime {
  const storage = new AppStoragePort(host, target === undefined)
  const network = new AppNetworkPort(host)
  const tracker = new TrackerRuntime({
    target,
    storage,
    ...(target === undefined ? { nativeIdentifiers: new AppNativeIdentifiersPort(host as NativePluginHost) } : {}),
    ...(target === undefined ? {} : { legacyIdentity: { read: (key: string) => host.getStorageSync(key) } }),
    /** 按当前配置创建系统读取端口，显式应用版本由初始化参数提供。 */
    systemContext: (config: ResolvedGioConfig) => ({
      /** 读取基础系统信息并后台刷新网络，避免慢网络回调阻塞首批事件。 */
      load: async () => {
        const system = await context(config).load()
        // 网络元数据在后台刷新，不能因宿主慢回调阻塞 App 首批事件。
        void network.current()
        return { ...system, networkState: network.cached() }
      },
    }),
    clock: {
      /** 提供毫秒级当前时间，供事件时间与上传调度使用。 */
      now: () => Date.now()
    },
    timezone: {
      /** 读取当前本地时区相对 UTC 的偏移分钟数。 */
      getOffsetMinutes: () => new Date().getTimezoneOffset()
    },
    deviceIdFactory: options.deviceIdFactory,
    sessionIdFactory: options.sessionIdFactory,
    orientation: orientationReader(host),
    logger: {
      /** 向宿主控制台输出普通初始化信息。 */
      info: (message) => globalThis.console?.info(message),
      /** 向宿主控制台输出初始化完成信息。 */
      success: (message) => globalThis.console?.info(message),
      /** 向宿主控制台输出固定警告。 */
      warn: (message) => globalThis.console?.warn(message),
      /** 向宿主控制台输出运行失败诊断。 */
      error: (message) => globalThis.console?.error(message),
      /** App 调试基座会转义字符串中的换行，逐行输出以保留 JSON 缩进。 */
      debug: (message, data) => {
        if (data !== undefined) {
          globalThis.console?.log(message, data)
          return
        }
        for (const line of message.split('\n')) globalThis.console?.log(line)
      },
    },
    network,
    upload: {
      transport: new AppRequestPort(host),
      runtime: {
        /** 提供毫秒级当前时间，供事件时间与上传调度使用。 */
        now: () => Date.now(),
        /** 提供退避抖动所需的随机值。 */
        random: () => Math.random(),
        /** 使用宿主定时器安排上传超时或重试。 */
        setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
        /** 取消 SDK 已持有的上传或重试定时器。 */
        clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      },
    },
  })
  installAutoTrackDispatcher(tracker)
  return tracker
}
