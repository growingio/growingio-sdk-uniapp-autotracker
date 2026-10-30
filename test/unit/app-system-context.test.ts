import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppSystemContextPort } from '../../src/platform/system.js'

describe('AppSystemContextPort', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses modern system devicePixelRatio when device info omits it and legacy pixelRatio is absent', async () => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'harmonyos' }),
      getSystemInfoSync: () => ({ screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ screenWidth: 1170, screenHeight: 2532 })
  })

  it.each(['android', 'ios', 'harmonyos'])('reports physical pixels for %s and keeps Android tablet classification in logical pixels', async (platform) => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform, devicePixelRatio: 3, deviceType: 'phone' }),
      getSystemInfoSync: () => ({ screenWidth: 390, screenHeight: 844, pixelRatio: 3 }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ screenWidth: 1170, screenHeight: 2532, deviceType: 'PHONE' })
  })

  it('rounds scaled dimensions, normalizes orientation and falls back to a valid system pixel ratio', async () => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'android', devicePixelRatio: Number.NaN }),
      getSystemInfoSync: () => ({ screenWidth: 853, screenHeight: 393, pixelRatio: 2.75 }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ screenWidth: 1081, screenHeight: 2346, deviceType: 'PHONE' })
  })

  it.each(['android', 'ios', 'harmonyos'])('preserves fractional logical screen dimensions for %s before converting to physical pixels', async (platform) => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform, deviceType: 'phone' }),
      getSystemInfoSync: () => ({ screenWidth: 1080 / 2.75, screenHeight: 2340 / 2.75, pixelRatio: 2.75 }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ screenWidth: 1080, screenHeight: 2340, deviceType: 'PHONE' })
  })

  it.each(['android', 'ios', 'harmonyos'])('未配置应用版本时使用 %s 的真实版本和宿主包字段，不能把引擎版本当应用版本', async (platform) => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform, osVersion: '18.1', platformVersion: 'incorrect' }),
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: () => ({ appVersion: '2.3.4', version: 'engine', hostPackageName: 'com.gio.host' }),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ platformVersion: '18.1', appVersion: '2.3.4', domain: 'com.gio.host' })
  })

  it.each([
    [' 1.0.0 ', '0.1.0', '0.0.9', '1.0.0'],
    ['1.0.0', undefined, undefined, '1.0.0'],
    [null, ' 0.1.0 ', '0.0.9', '0.1.0'],
    [null, '   ', ' 0.0.9 ', '0.0.9'],
    [null, 42, '0.0.9', '0.0.9'],
    [null, undefined, undefined, ''],
    [null, '   ', 42, ''],
  ] as const)('按显式配置 %j、应用信息 %j、系统信息 %j 的顺序解析 appVersion', async (configured, appVersion, systemVersion, expected) => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'harmonyos' }),
      getSystemInfoSync: () => ({ appVersion: systemVersion }),
      getAppBaseInfo: () => ({ appVersion }),
    }, 'sdk-version', configured)
    await expect(port.load()).resolves.toMatchObject({ appVersion: expected, sdkVersion: 'sdk-version' })
  })

  it('HarmonyOS 与原生 SDK 一致，使用产品显示版本而非纯数字系统版本', async () => {
    const displayVersion = 'ALN-AL00 6.1.0.135(SPC00E120R4P11)'
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'harmonyos', osVersion: '6.1.1.120', osHarmonyDisplayVersion: displayVersion }),
      getSystemInfoSync: () => ({ osHarmonyDisplayVersion: 'older system snapshot' }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ platform: 'HarmonyOS', platformVersion: displayVersion })
  })

  it.each([undefined, '   ', 42])('HarmonyOS 设备显示版本为 %j 时回退到同步系统信息的完整版本', async (osHarmonyDisplayVersion) => {
    const displayVersion = 'ALN-AL00 6.1.0.135(SPC00E120R4P11)'
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'harmony', osVersion: '6.1.1.120', osHarmonyDisplayVersion }),
      getSystemInfoSync: () => ({ osHarmonyDisplayVersion: displayVersion }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ platformVersion: displayVersion })
  })

  it.each(['android', 'ios'])('%s 忽略鸿蒙专属显示版本，继续使用自身系统版本', async (platform) => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform, osVersion: '18.1', osHarmonyDisplayVersion: 'harmony-only' }),
      getSystemInfoSync: () => ({ osHarmonyDisplayVersion: 'harmony-only' }),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ platformVersion: '18.1' })
  })

  it('Android 包信息缺失时使用 Native.js，仍保留显式配置的应用版本', async () => {
    const activity = {}
    const invoke = vi.fn((value, method) => value === activity && method === 'getPackageName' ? 'com.native.android' : '')
    vi.stubGlobal('plus', { android: { runtimeMainActivity: () => activity, invoke } })
    const port = new AppSystemContextPort({ getDeviceInfo: () => ({ platform: 'android' }), getSystemInfoSync: () => ({ system: 'Android 14' }), getAppBaseInfo: () => ({ version: 'engine' }) }, '0.1.0', 'fallback')
    await expect(port.load()).resolves.toMatchObject({ domain: 'com.native.android', appVersion: 'fallback', platformVersion: '14' })
  })

  it('iOS Native.js 读取失败仍释放对象，且不会用 DCloud appid 冒充包名', async () => {
    const bundle = {}
    const deleteObject = vi.fn()
    vi.stubGlobal('plus', { ios: { invoke: (_value: unknown, method: string) => { if (method === 'mainBundle') return bundle; throw new Error('unavailable') }, deleteObject } })
    const port = new AppSystemContextPort({ getDeviceInfo: () => ({ platform: 'ios' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({ appId: '__UNI__123' }) }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ domain: '' })
    expect(deleteObject).toHaveBeenCalledWith(bundle)
  })

  it('maps Android host data to stable protocol context and normalizes screen orientation', async () => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'android', platformVersion: '14', screenWidth: 360, screenHeight: 640, brand: 'Google', model: 'Pixel', deviceType: 'PHONE' }),
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: () => ({ packageName: 'com.example', appName: 'Example', appVersion: '2.0', version: 'engine', appLanguage: 'zh_hans_cn' }),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({
      platform: 'Android', domain: 'com.example', screenWidth: 360, screenHeight: 640, deviceType: 'PHONE', language: 'zh-Hans-CN', appVersion: '2.0', networkState: 'UNKNOWN',
    })
  })

  it('classifies Android device type from the standard 600dp shortest-edge threshold', async () => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'android', deviceType: 'unknown', screenWidth: 800, screenHeight: 1280 }),
      getSystemInfoSync: () => ({ deviceType: 'phone' }),
      getAppBaseInfo: () => ({ packageName: 'com.example' }),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({ platform: 'Android', deviceType: 'PAD' })
  })

  it('uses documented fallbacks for optional fields and rejects non-App platforms', async () => {
    const fallback = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'ios' }),
      getSystemInfoSync: () => ({ screenWidth: 0, screenHeight: 10 }),
      getAppBaseInfo: () => ({ bundleId: '', language: 'not a language' }),
    }, '0.1.0', 'fallback')
    await expect(fallback.load()).resolves.toMatchObject({
      platform: 'iOS', platformVersion: 'UNKNOWN', domain: '', screenWidth: 0, screenHeight: 0, deviceBrand: 'UNKNOWN', appVersion: 'fallback', language: 'und',
    })
    const unsupported = new AppSystemContextPort({ getDeviceInfo: () => ({ platform: 'devtools' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}) }, '0.1.0', null)
    await expect(unsupported.load()).rejects.toThrow('unsupported_platform')
  })

  it('reads HarmonyOS device field names emitted by uni.getDeviceInfo', async () => {
    const port = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform: 'harmonyos', platformVersion: '6.1', deviceBrand: 'huawei', deviceModel: 'BRA-AL00', deviceType: 'PHONE' }),
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: () => ({ bundleName: 'com.example.harmony' }),
    }, '0.1.0', null)
    await expect(port.load()).resolves.toMatchObject({
      platform: 'HarmonyOS', deviceBrand: 'huawei', deviceModel: 'BRA-AL00',
    })
  })
})
