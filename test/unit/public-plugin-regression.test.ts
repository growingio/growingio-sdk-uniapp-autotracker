import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GioPlugin, GioPluginRuntime } from '../../index.js'
import type { NativeIdentifierField } from '../../src/plugins/gioNativeIdentifiers/index.js'

beforeEach(() => { vi.resetModules(); vi.spyOn(console, 'info').mockImplementation(() => undefined) })
afterEach(() => vi.unstubAllGlobals())

function host() {
  const uni = {
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    getNetworkType: (options: { success: (value: unknown) => void }) => options.success({ networkType: 'wifi' }),
    request: vi.fn(),
    getDeviceInfo: () => ({ platform: 'android' }),
    getSystemInfoSync: () => ({}),
    getAppBaseInfo: () => ({}),
  }
  vi.stubGlobal('uni', uni)
  return uni
}

describe('public plugin registration compatibility', () => {
  it('keeps a valid customer install sharing the existing builtin name across failed init and retry', async () => {
    host()
    const { gdp } = await import('../../index.js')
    let runtime: GioPluginRuntime | undefined
    const install = vi.fn((tracker: GioPluginRuntime) => { runtime = tracker })
    const plugin: GioPlugin = { name: 'gioEventAutoTracking', install }
    const options = { uniVue: { mixin: vi.fn() }, dataCollect: false }
    expect(gdp('registerPlugins', [plugin])).toBe(true)
    expect(gdp('init', '', 'source', options)).toBe(false)
    expect(install).not.toHaveBeenCalled()
    expect(gdp('init', 'account', 'source', options)).toBe(true)
    expect(install).toHaveBeenCalledExactlyOnceWith(runtime)
    expect(runtime!.registeredPluginNames()).toEqual(['gioEventAutoTracking'])
    expect(await runtime!.whenReady()).toBe(true)
    expect(gdp('init', 'account', 'source', options)).toBe(false)
    expect(install).toHaveBeenCalledOnce()
  })

  it('preserves class install context while protecting builtin field options from later mutation', async () => {
    const uni = host()
    const fields: NativeIdentifierField[] = ['oaid']
    const getIdentifiers = vi.fn((request: unknown, done: (reply: unknown) => void) => {
      done({ version: 1, identifiers: { oaid: 'native-oaid' } })
    })
    vi.stubGlobal('uni', { ...uni, requireNativePlugin: () => ({ getIdentifiers }) })
    const { gdp } = await import('../../index.js')
    class IdentifierPlugin implements GioPlugin {
      public readonly name = 'gioNativeIdentifiers'
      public readonly options = { fields }
      public installs = 0
      public tracker: GioPluginRuntime | null = null
      public install(tracker: GioPluginRuntime): void {
        this.installs++
        this.tracker = tracker
        expect(this).toBe(plugin)
      }
    }
    const plugin = new IdentifierPlugin()
    expect(gdp('registerPlugins', [plugin])).toBe(true)
    fields.push('androidId')
    expect(gdp('init', 'account', 'source', { uniVue: { mixin() {} } })).toBe(true)
    expect(plugin.installs).toBe(1)
    expect(await plugin.tracker!.whenReady()).toBe(true)
    expect(getIdentifiers).toHaveBeenCalledExactlyOnceWith({ version: 1, fields: ['oaid'] }, expect.any(Function))
    expect(plugin.options.fields).toEqual(['oaid', 'androidId'])
  })

  it('keeps the object install context and a frozen builtin role when caller options become invalid', async () => {
    host()
    const { gdp } = await import('../../index.js')
    const plugin = {
      name: 'gioEventAutoTracking',
      options: {} as Record<string, unknown>,
      installs: 0,
      tracker: null as GioPluginRuntime | null,
      install(tracker: GioPluginRuntime) { this.installs++; this.tracker = tracker },
    }
    expect(gdp('registerPlugins', [plugin])).toBe(true)
    plugin.options.unexpected = true
    expect(gdp('init', 'account', 'source', { uniVue: { mixin() {} }, dataCollect: false })).toBe(true)
    expect(plugin.installs).toBe(1)
    expect(plugin.tracker!.registeredPluginNames()).toEqual(['gioEventAutoTracking'])
    expect(await plugin.tracker!.whenReady()).toBe(true)
  })

  it('isolates a throwing dual-role installer and still installs later ordinary plugins', async () => {
    host()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { gdp } = await import('../../index.js')
    const order: string[] = []
    const plugin = {
      name: 'gioEventAutoTracking',
      installs: 0,
      install() { this.installs++; order.push('builtin-customer'); throw Error('installer failed') },
    }
    let runtime!: GioPluginRuntime
    expect(gdp('registerPlugins', [plugin, { name: 'ordinary', install: tracker => { order.push('ordinary'); runtime = tracker } }])).toBe(true)
    expect(gdp('init', 'account', 'source', { uniVue: { mixin() {} }, dataCollect: false })).toBe(true)
    expect(plugin.installs).toBe(1)
    expect(order).toEqual(['builtin-customer', 'ordinary'])
    expect(runtime.registeredPluginNames()).toEqual(['gioEventAutoTracking'])
    expect(warning).toHaveBeenCalledWith('[GrowingIO]: custom plugin install failed (gioEventAutoTracking)')
    expect(await runtime.whenReady()).toBe(true)
  })

  it('preserves ordinary customer object semantics, including an installer changed before init', async () => {
    host()
    const { gdp } = await import('../../index.js')
    class OrdinaryPlugin implements GioPlugin {
      public readonly name = 'ordinary'
      public count = 0
      public tracker: GioPluginRuntime | null = null
      public install(tracker: GioPluginRuntime): void { this.count++; this.tracker = tracker }
    }
    const plugin = new OrdinaryPlugin()
    expect(gdp('registerPlugins', [plugin])).toBe(true)
    plugin.install = function(this: OrdinaryPlugin, tracker: GioPluginRuntime) {
      expect(this).toBe(plugin)
      this.count += 3; this.tracker = tracker
    }
    expect(gdp('init', 'account', 'source', { uniVue: { mixin() {} }, dataCollect: false })).toBe(true)
    expect(plugin.count).toBe(3)
    expect(plugin.tracker!.registeredPluginNames()).toEqual([])
    expect(await plugin.tracker!.whenReady()).toBe(true)
  })
})
