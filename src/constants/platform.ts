import { CHANGE_ELEMENTS, type ChangeElement } from '../plugins/gioEventAutoTracking/contract.js'
import type { AppPlatform, MiniProgramTarget, MiniProgramPlatform } from '../types/index.js'
import { MINI_PROGRAM_PROFILES } from './miniprogram.js'
export { MINI_PROGRAM_PROFILES, MINI_PROGRAM_TARGETS } from './miniprogram.js'

export type AppCapabilityProfile = Readonly<{
  platform: AppPlatform
  appLifecycle: boolean
  pageLifecycle: boolean
  autoClick: boolean
  autoChange: Readonly<Record<ChangeElement, boolean>>
  changeInput: boolean
  changePicker: boolean
  tabBar: boolean
  appClosedBestEffort: boolean
}>

export type AutoTrackCapabilityProfile = Omit<AppCapabilityProfile, 'platform'> & Readonly<{ platform: AppPlatform | MiniProgramPlatform }>

/** 小程序能力与 App 分开验收；验证构建不修改生产矩阵。 */
export function miniProgramCapabilityProfile(target: MiniProgramTarget, verificationBuild = false): AutoTrackCapabilityProfile {
  return { ...appProfile('Android', verificationBuild), platform: MINI_PROGRAM_PROFILES[target].platform }
}

/** 构造平台的自动交互开关，生产配置和验证构建使用相同的组件范围。 */
const appProfile = (platform: AppPlatform, automaticInteractions = false): AppCapabilityProfile => ({
  platform,
  appLifecycle: false,
  pageLifecycle: false,
  autoClick: automaticInteractions,
  autoChange: Object.fromEntries(CHANGE_ELEMENTS.map(element => [element, automaticInteractions])) as Record<ChangeElement, boolean>,
  changeInput: automaticInteractions,
  changePicker: automaticInteractions,
  tabBar: automaticInteractions,
  appClosedBestEffort: false,
})

const profiles: Readonly<Record<AppPlatform, AppCapabilityProfile>> = {
  Android: appProfile('Android'),
  iOS: appProfile('iOS'),
  HarmonyOS: appProfile('HarmonyOS', true),
}

/** 按系统选择生产能力。验证构建也可开放其他 App 的自动交互。 */
export function appCapabilityProfile(platform: unknown, verificationBuild = false): AppCapabilityProfile | null {
  const profile = typeof platform === 'string' && Object.prototype.hasOwnProperty.call(profiles, platform) ? profiles[platform as AppPlatform] : null
  return profile === null || !verificationBuild ? profile : appProfile(profile.platform, true)
}

/** 列出各 App 平台的生产能力配置。 */
export function allAppCapabilityProfiles(): readonly AppCapabilityProfile[] {
  return Object.values(profiles)
}
