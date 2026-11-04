import { describe, expect, it, vi } from 'vitest'

import type { AppPlatform } from '../../src/types/index.js'
import { appSystem, runtimeFixture } from '../support/runtime-fixture.js'

const logger = () => ({ info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })

describe('App 平台能力诊断', () => {
  it.each<AppPlatform>(['HarmonyOS', 'Android', 'iOS'])('%s 读不到包名时提示事件将省略 domain', async platform => {
    const log = logger()
    const { tracker } = runtimeFixture({ logger: log, systemContext: { load: async () => ({ ...appSystem, platform, domain: '' }) } })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    expect(await tracker.whenReady()).toBe(true)
    expect(log.warn).toHaveBeenCalledWith(`[GrowingIO]: app domain unavailable on ${platform}, events will omit domain`)
  })

  it('读到包名时不提示', async () => {
    const log = logger()
    const { tracker } = runtimeFixture({ logger: log })
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await tracker.whenReady()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it.each<[AppPlatform, string[], boolean]>([
    ['HarmonyOS', ['oaid', 'idfa'], true],
    ['Android', ['idfa', 'idfv'], true],
    ['iOS', ['oaid'], true],
    ['Android', ['oaid', 'idfa'], false],
  ])('%s 注册 gioNativeIdentifiers(%j) 时，没有可读字段才提示：%s', async (platform, fields, warned) => {
    const log = logger()
    const { tracker } = runtimeFixture({ logger: log, nativeIdentifiers: { read: async () => ({}) },
      systemContext: { load: async () => ({ ...appSystem, platform }) } })
    expect(tracker.registerPlugins({ name: 'gioNativeIdentifiers', options: { fields: fields as never } })).toBe(true)
    tracker.init({ accountId: 'account', dataSourceId: 'source' })
    await tracker.whenReady()
    const message = `[GrowingIO]: gioNativeIdentifiers has no readable fields on ${platform}`
    if (warned) expect(log.warn).toHaveBeenCalledWith(message)
    else expect(log.warn).not.toHaveBeenCalledWith(message)
  })
})
