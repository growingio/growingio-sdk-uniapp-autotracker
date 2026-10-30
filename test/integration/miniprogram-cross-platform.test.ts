import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appEntrySnapshot, installUniAppLifecycle } from '../../src/adapters/uniapp.js'
import { MINI_PROGRAM_TARGETS } from '../../src/constants/platform.js'
import { buildMiniProgramEvent } from '../../src/core/dataStore/protocol.js'
import { storageKeys } from '../../src/core/storage/index.js'
import { createMiniProgramTracker } from '../../src/platform/miniprogram.js'
import { resolveRuntimeTarget } from '../../src/platform/resolve.js'
import { miniCases, miniHost, miniTargets } from '../support/miniprogram-host.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); vi.spyOn(console, 'info').mockImplementation(() => undefined) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe.each(miniTargets)('%s platform boundaries', target => {
  const expected = miniCases[target]

  it('selects its unique native global but rejects ambiguous hosts and conflicting metadata', () => {
    expect(resolveRuntimeTarget({}, undefined, { [expected.global]: { request() {} } })).toBe(target)
    expect(resolveRuntimeTarget({}, undefined, { [expected.global]: { request: true } })).toBeNull()
    for (const other of miniTargets.filter(value => value !== target)) {
      expect(resolveRuntimeTarget({}, undefined, { [expected.global]: { request() {} }, [miniCases[other].global]: { request() {} } })).toBeNull()
      expect(resolveRuntimeTarget({ getSystemInfoSync: () => ({ uniPlatform: other, platform: 'ios' }) }, target, {})).toBeNull()
    }
    // An explicit build target is authoritative even if a business dependency exposes another global.
    expect(resolveRuntimeTarget({}, target, { wx: { request() {} }, my: { request() {} } })).toBe(target)
  })

  it('runs without optional account or entry APIs, using explicit appId and version', async () => {
    const f = miniHost(target)
    const host = { ...f.host, getAccountInfoSync: undefined, getLaunchOptionsSync: undefined, getEnterOptionsSync: undefined }
    const tracker = createMiniProgramTracker(host, target, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    expect(tracker.init({ accountId: 'account', dataSourceId: 'source', appId: f.appId, appVersion: '2.0' })).toBe(true)
    expect(await tracker.whenReady()).toBe(true)
    const mixin = vi.fn(); installUniAppLifecycle({ mixin }, tracker, { host, miniprogram: target })
    const hooks = mixin.mock.calls[0]![0] as Record<string, (this: unknown, value?: unknown) => void>
    const app = { $mpType: 'app' }, page = { $options: { mpType: 'page' }, route: 'pages/home' }
    hooks.onLaunch!.call(app, { path: 'pages/home', query: { cold: true }, scene: '001' })
    hooks.onShow!.call(app, {}); hooks.onLoad!.call(page, { p: 1 }); hooks.onShow!.call(page)
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(tracker.queuedEvents()[0]).toMatchObject({ platform: expected.platform, appVersion: '2.0', path: 'pages/home', query: 'cold=true', appChannel: 'scn:001' })
    hooks.onHide!.call(page); hooks.onHide!.call(app)
    hooks.onShow!.call(app, { path: 'pages/detail', query: { hot: true }, scene: '002' })
    expect(tracker.queuedEvents()[0]).toMatchObject({ path: 'pages/detail', query: 'hot=true', appChannel: 'scn:002' })
  })

  it('rejects a different platform name in device metadata and preserves its own scene prefix', async () => {
    const f = miniHost(target); f.init(); await f.tracker.whenReady()
    f.tracker.onAppShow({ path: 'pages/home', query: '', scene: '001' })
    f.tracker.onPageLoad({ instanceId: 'home', route: 'pages/home', query: '', referralPage: null })
    f.tracker.onPageShow('home', null)
    const event = f.tracker.queuedEvents()[0]!
    expect(f.tracker.queuedEvents()[1]!.referralPage).toBe(`scn:${expected.prefix}001`)
    for (const other of miniTargets.filter(value => value !== target)) {
      const deviceType = `${miniCases[other].name}-Android`
      expect(buildMiniProgramEvent('VISIT', { ...event, deviceType, operatingSystem: deviceType }).ok).toBe(false)
    }
    expect(buildMiniProgramEvent('VISIT', { ...event, deviceType: `${expected.name}-`, operatingSystem: `${expected.name}-` }).ok).toBe(false)
  })

  it('preserves instance queries across a return stack, same-route instances and a subpackage page', async () => {
    const f = miniHost(target); f.init(); await f.tracker.whenReady(); f.show()
    const session = f.tracker.queuedEvents()[0]!.sessionId
    f.tracker.onPageHide('home-1')
    f.tracker.onPageLoad({ instanceId: 'detail-1', route: 'pages/detail', query: 'sku=1', referralPage: null })
    f.tracker.onPageShow('detail-1', '商品一')
    f.tracker.onPageHide('detail-1')
    f.tracker.onPageLoad({ instanceId: 'detail-2', route: 'pages/detail', query: 'sku=2', referralPage: null })
    f.tracker.onPageShow('detail-2', '商品二')
    f.tracker.onPageUnload('detail-2'); f.tracker.onPageShow('detail-1', '商品一')
    f.tracker.onPageUnload('detail-1'); f.tracker.onPageShow('home-1', '首页')
    f.tracker.track('returned_home')
    expect(f.tracker.queuedEvents().at(-1)).toMatchObject({ path: 'pages/home', query: 'page=1', sessionId: session })
    f.tracker.onPageHide('home-1')
    f.tracker.onPageLoad({ instanceId: 'sub', route: 'subpackage/detail', query: 'sub=1', referralPage: null })
    f.tracker.onPageShow('sub', '分包')
    const pages = f.tracker.queuedEvents().filter(event => event.eventType === 'PAGE')
    expect(pages.map(event => event.query)).toEqual(['page=1', 'sku=1', 'sku=2', 'sku=1', 'page=1', 'sub=1'])
    expect(pages.at(-1)).toMatchObject({ path: 'subpackage/detail', referralPage: 'pages/home' })
    expect(f.tracker.queuedEvents().every(event => event.sessionId === session)).toBe(true)
    expect(f.tracker.queuedEvents().filter(event => event.eventType === 'VISIT')).toHaveLength(1)
    expect(f.tracker.queuedEvents().some(event => event.eventType === 'APP_CLOSED')).toBe(false)
  })
})

describe('cross-platform contracts', () => {
  it('covers exactly the intended eight targets and isolates storage even when all identifiers match', () => {
    expect([...MINI_PROGRAM_TARGETS].sort()).toEqual([...miniTargets].sort())
    const keys = miniTargets.map(target => storageKeys('source', { target, appId: 'same', accountId: 'account' }).identity)
    expect(new Set([...keys, storageKeys('source').identity]).size).toBe(9)
  })

  it.each([undefined, {}])('accepts native Douyin refererInfo when standard referrerInfo is %j', referrerInfo => {
    expect(appEntrySnapshot({ path: '/pages/home', scene: '011009', query: { a: 1 }, referrerInfo,
      refererInfo: { appId: 'native-source', extraData: { a: 'blocked', b: false } } }, 'mp-toutiao'))
      .toEqual({ path: 'pages/home', scene: '011009', query: 'a=1&b=false', referralPage: 'native-source' })
  })

  it('preserves standard referrer precedence and confines the native alias to Douyin', () => {
    const input = { path: 'pages/home', referrerInfo: { appId: 'standard', extraData: { good: 1 } }, refererInfo: { appId: 'native', extraData: { bad: 1 } } }
    expect(appEntrySnapshot(input, 'mp-toutiao')).toMatchObject({ referralPage: 'standard', query: 'good=1' })
    for (const target of miniTargets.filter(value => value !== 'mp-toutiao')) expect(appEntrySnapshot({ refererInfo: input.refererInfo }, target)).toMatchObject({ referralPage: null, query: '' })
  })

  it('keeps native Douyin source data through a missing-path hot-entry fallback', async () => {
    const f = miniHost('mp-toutiao'); f.init(); await f.tracker.whenReady()
    const host = { ...f.host, getEnterOptionsSync: () => ({ path: 'pages/native', query: {}, scene: '011010', refererInfo: { appId: 'native', extraData: { extra: true } } }) }
    const mixin = vi.fn(); installUniAppLifecycle({ mixin }, f.tracker, { host, miniprogram: 'mp-toutiao' })
    const hooks = mixin.mock.calls[0]![0] as Record<string, (this: unknown, value?: unknown) => void>
    hooks.onShow!.call({ $mpType: 'app' }, { query: { p: 1 } })
    expect(f.tracker.queuedEvents()[0]).toMatchObject({ path: 'pages/native', query: 'p=1&extra=true', referralPage: 'native', appChannel: 'scn:011010' })
  })
})
