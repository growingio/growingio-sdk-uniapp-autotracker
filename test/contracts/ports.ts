/**
 * 阶段 0 只定义跨层边界。具体核心逻辑与 `uni.*` 适配器分别在阶段 1、2 实现。
 */
export type AppPlatform = 'Android' | 'iOS' | 'HarmonyOS'

export type AppSystemContext = Readonly<{
  platform: AppPlatform
  platformVersion: string
  domain: string
  appState: 'FOREGROUND' | 'BACKGROUND'
  appName: string
  networkState: '2G' | '3G' | '4G' | '5G' | 'WIFI' | 'UNKNOWN'
  screenWidth: number
  screenHeight: number
  deviceBrand: string
  deviceModel: string
  deviceType: 'PHONE' | 'PAD' | 'FOLD' | 'UNKNOWN'
  appVersion: string
  language: string
  sdkVersion: string
}>

/** 仅加载稳定 App 上下文，每条事件的时区由 TimezonePort 提供。 */
export interface SystemContextPort {
  load(): Promise<AppSystemContext>
}

/** 事件时间使用当前设备的 Unix 毫秒时间戳，不强制修正为单调递增。 */
export interface ClockPort {
  now(): number
}

/** 时区变化只影响变化后创建的事件。 */
export interface TimezonePort {
  getOffsetMinutes(): number
}
