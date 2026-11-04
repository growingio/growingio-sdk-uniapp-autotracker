import { describe, expect, it, vi } from 'vitest'

import type { AppRuntimeHost } from '../../src/platform/index.js'

describe('public API', () => {
  it('keeps build-time Vite integration out of the App runtime entry', async () => {
    const runtimeApi = await import('../../index.js')
    expect(runtimeApi).not.toHaveProperty('gioUniappAutoTrack')
    const compilerApi = await import('../../vite.js')
    expect(compilerApi.gioUniappAutoTrack().name).toBe('gio-uniapp-autotrack')
  })

  it('exposes only the mini-program-style command entry, not host or identity factories', async () => {
    const runtimeApi = await import('../../index.js')
    expect(runtimeApi).not.toHaveProperty('createAppTracker')
    expect(runtimeApi).not.toHaveProperty('createGioTracker')
    expect(runtimeApi).not.toHaveProperty('installGioUniApp')
    expect(runtimeApi).not.toHaveProperty('dispatchAutoTrack')
    expect(runtimeApi).not.toHaveProperty('TrackerRuntime')
    expect(runtimeApi).toHaveProperty('gdp')
    expect(runtimeApi).toHaveProperty('default')
  })

  it('异步恢复失败后可再次 init，复用已安装的生命周期，失败期间拒绝业务事件', async () => {
    vi.resetModules()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const originalUni = (globalThis as Record<string, unknown>).uni
    const app = { mixin: vi.fn() }
    // 首次同步宿主检查通过，随后异步读取系统信息失败，模拟启动期宿主能力暂不可用。
    let deviceReads = 0
    const platform = 'android'
    const writes: string[] = []
    const host: AppRuntimeHost = {
      getStorageSync: () => undefined,
      setStorageSync: (_key, value) => { writes.push(value) },
      removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: ++deviceReads === 2 ? 'unsupported' : platform }),
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: () => ({}),
      getNetworkType: (options) => { options.success({}) },
      request: () => undefined,
    }
    ;(globalThis as Record<string, unknown>).uni = host
    try {
      const { gdp } = await import('../../index.js')
      expect(gdp('init', 'account', 'source', { uniVue: app })).toBe(true)
      await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
      expect(gdp('track', 'while_failed')).toBe(false)
      expect(gdp('init', 'account', 'source', { uniVue: app })).toBe(true)
      expect(app.mixin).toHaveBeenCalledOnce()
      await vi.waitFor(() => expect(gdp('track', 'after_retry')).toBe(true))
      expect(gdp('init', 'account', 'source', { uniVue: app })).toBe(false)
    } finally {
      vi.restoreAllMocks()
      if (originalUni === undefined) delete (globalThis as Record<string, unknown>).uni
      else (globalThis as Record<string, unknown>).uni = originalUni
    }
  })

  it('initializes from the global uni host without caller-provided device or session factories', async () => {
    vi.resetModules()
    const originalUni = (globalThis as Record<string, unknown>).uni
    const app = {
      config: { globalProperties: {} as Record<string, unknown> },
      mixin: vi.fn(),
      use: vi.fn(),
    }
    const host: AppRuntimeHost = {
      getStorageSync: () => undefined,
      setStorageSync: () => undefined,
      removeStorageSync: () => undefined,
      getDeviceInfo: () => ({ platform: 'android' }),
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: () => ({}),
      getNetworkType: (options) => { options.success({}) },
      request: () => undefined,
    }
    ;(globalThis as Record<string, unknown>).uni = host

    try {
      const { gdp } = await import('../../index.js')
      expect(gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }])).toBe(true)
      const install = vi.fn()
      expect(gdp('registerPlugins', [{ name: 'customer-plugin', install }])).toBe(true)
      expect(gdp('init', '', 'source', { uniVue: app, dataCollect: false })).toBe(false)
      expect(gdp('init', 'account', 'source', { uniVue: app, dataCollect: false })).toBe(true)
      expect(app.use).not.toHaveBeenCalled()
      expect(app.mixin).toHaveBeenCalledOnce()
      expect(app.config.globalProperties.$gio).toBeUndefined()
      expect(install).toHaveBeenCalledOnce()
      expect(install.mock.calls[0]?.[0]).toMatchObject({ track: expect.any(Function) })
    } finally {
      if (originalUni === undefined) delete (globalThis as Record<string, unknown>).uni
      else (globalThis as Record<string, unknown>).uni = originalUni
    }
  })
})
