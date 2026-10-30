import type { AppPlatform, AppSystemContext } from './ports.js'

type AppContextVector = Readonly<{
  name: string
  platform: AppPlatform | 'unsupported'
  expected: Partial<AppSystemContext> | Readonly<{ initError: 'unsupported_platform' }>
}>

export const SYSTEM_CONTEXT_VECTORS: readonly AppContextVector[] = [
  {
    name: 'Android 保留标准系统值',
    platform: 'Android',
    expected: {
      platform: 'Android',
      platformVersion: '14',
      domain: 'com.example.android',
      screenWidth: 1080,
      screenHeight: 2400,
      language: 'zh-CN',
    },
  },
  {
    name: 'iOS 映射为 PAD，屏幕固定短边和长边',
    platform: 'iOS',
    expected: {
      platform: 'iOS',
      deviceType: 'PAD',
      screenWidth: 1668,
      screenHeight: 2388,
    },
  },
  {
    name: 'HarmonyOS 缺失系统字段使用明确降级值但不阻塞',
    platform: 'HarmonyOS',
    expected: {
      platform: 'HarmonyOS',
      platformVersion: 'UNKNOWN',
      domain: '',
      screenWidth: 0,
      screenHeight: 0,
      deviceBrand: 'UNKNOWN',
      deviceModel: 'UNKNOWN',
      deviceType: 'UNKNOWN',
      appName: '',
      appVersion: '',
      language: 'und',
      networkState: 'UNKNOWN',
    },
  },
  {
    name: 'H5 或小程序不属于一期 App profile',
    platform: 'unsupported',
    expected: { initError: 'unsupported_platform' },
  },
]

export const DYNAMIC_CONTEXT_VECTORS = [
  { name: '中国时区', timezoneOffset: '-480' },
  { name: 'UTC', timezoneOffset: '0' },
  { name: '未知网络仍允许入队', networkState: 'UNKNOWN' },
  { name: '后台关闭事件固定状态', appState: 'BACKGROUND' },
] as const
