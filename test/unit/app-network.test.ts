import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppNetworkPort, normalizeAppNetworkState } from '../../src/platform/network.js'

describe('AppNetworkPort', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('查询、Native 回退、订阅和取消订阅抛错时保持可用', async () => {
    vi.stubGlobal('plus', { networkinfo: { getCurrentType: () => { throw new Error('native failed') } } })
    const port = new AppNetworkPort({
      getNetworkType: () => { throw new Error('query failed') },
      onNetworkStatusChange: () => { throw new Error('subscribe failed') },
    })
    expect(await port.current()).toBe('UNKNOWN')
    expect(port.isConnected()).toBeNull()
    expect(() => port.subscribe(() => undefined)()).not.toThrow()
    const removable = new AppNetworkPort({ getNetworkType: () => undefined, onNetworkStatusChange: () => undefined,
      offNetworkStatusChange: () => { throw new Error('unsubscribe failed') } })
    expect(() => removable.subscribe(() => undefined)()).not.toThrow()
  })

  it('明确断网与类型未知分别保留，未知代际也可以明确联网', async () => {
    let listener!: (result: { networkType?: unknown; isConnected?: unknown }) => void
    const port = new AppNetworkPort({ getNetworkType: options => options.success({ networkType: 'none' }), onNetworkStatusChange: next => { listener = next } })
    expect(port.isConnected()).toBeNull()
    await expect(port.current()).resolves.toBe('UNKNOWN')
    expect(port.isConnected()).toBe(false)
    port.subscribe(() => undefined)
    listener({ networkType: 'unknown', isConnected: true })
    expect(port.isConnected()).toBe(true)
    listener({ networkType: 'wifi', isConnected: false })
    expect(port.isConnected()).toBe(false)
  })

  it('迟到的联网查询不能覆盖新的断网通知，查询超时也不能解除断网', async () => {
    vi.useFakeTimers()
    let reply!: (result: { networkType: string }) => void
    let listener!: (result: { networkType: string; isConnected: boolean }) => void
    const port = new AppNetworkPort({ getNetworkType: options => { reply = options.success }, onNetworkStatusChange: next => { listener = next } })
    port.subscribe(() => undefined)
    const reading = port.current()
    listener({ networkType: 'none', isConnected: false })
    reply({ networkType: 'wifi' })
    await expect(reading).resolves.toBe('UNKNOWN')
    expect(port.isConnected()).toBe(false)
    const timedOut = port.current()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(timedOut).resolves.toBe('UNKNOWN')
    expect(port.isConnected()).toBe(false)
  })

  it('Native.js 明确断网的回退读数会阻止上传', async () => {
    vi.stubGlobal('plus', { networkinfo: { CONNECTION_NONE: 1, getCurrentType: () => 1 } })
    const port = new AppNetworkPort({ getNetworkType: options => options.fail() })
    await expect(port.current()).resolves.toBe('UNKNOWN')
    expect(port.isConnected()).toBe(false)
  })

  it('normalizes only documented generations and keeps offline, cellular and failures UNKNOWN', () => {
    expect(normalizeAppNetworkState('wifi')).toBe('WIFI')
    expect(normalizeAppNetworkState('5g')).toBe('5G')
    expect(normalizeAppNetworkState('cellular')).toBe('UNKNOWN')
    expect(normalizeAppNetworkState('wifi', false)).toBe('UNKNOWN')
  })

  it('uses UNKNOWN for host failure and forwards later subscription changes', async () => {
    const host = { listener: null as ((result: Readonly<{ networkType?: unknown; isConnected?: unknown }>) => void) | null }
    const port = new AppNetworkPort({
      getNetworkType: (options) => { options.fail() },
      onNetworkStatusChange: (next) => { host.listener = next },
      offNetworkStatusChange: (next) => { if (host.listener === next) host.listener = null },
    })
    await expect(port.current()).resolves.toBe('UNKNOWN')
    const received: string[] = []
    const stop = port.subscribe((state) => received.push(state))
    host.listener?.({ networkType: '4g', isConnected: true })
    host.listener?.({ networkType: 'wifi', isConnected: false })
    stop()
    expect(received).toStrictEqual(['4G', 'UNKNOWN'])
    expect(host.listener).toBeNull()
  })

  it('uses an explicit plus.networkinfo reading when uni.getNetworkType fails', async () => {
    const scope = globalThis as Record<string, unknown>
    const original = scope.plus
    scope.plus = { networkinfo: { CONNECTION_WIFI: 3, getCurrentType: () => 3 } }
    try {
      const port = new AppNetworkPort({ getNetworkType: (options) => { options.fail() } })
      await expect(port.current()).resolves.toBe('WIFI')
    } finally {
      if (original === undefined) delete scope.plus
      else scope.plus = original
    }
  })
})
