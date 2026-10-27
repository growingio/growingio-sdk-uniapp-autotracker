import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appEntrySnapshot, installUniAppLifecycle } from '../../src/adapters/uniapp.js'
import { resolveRuntimeTarget } from '../../src/platform/resolve.js'
import type { AppRequestApi } from '../../src/platform/uni.js'
import { miniHost, miniTargets } from '../support/miniprogram-host.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe.each(miniTargets)('%s review boundaries', target => {
  it('clears the previous background timestamp when a scene change resumes a long-hidden app', async () => {
    const f = miniHost(target); f.init(); await f.tracker.whenReady(); f.show()
    f.tracker.onAppHide()
    vi.setSystemTime(Date.now() + 300001)
    f.tracker.onAppShow({ path: 'pages/home', query: 'new=1', scene: '1002' })
    const current = f.tracker.queuedEvents()[0]!.sessionId
    f.tracker.onAppShow({ path: 'pages/home', query: 'new=1', scene: '1002' })
    const visits = [...f.sent, ...f.tracker.queuedEvents()].filter(event => event.eventType === 'VISIT')
    expect(visits).toHaveLength(2)
    expect(visits.at(-1)!.sessionId).toBe(current)
  })

  it('emits the current PAGE when consent opens between a pending page show and the first app show', async () => {
    const f = miniHost(target); f.init({ dataCollect: false }); await f.tracker.whenReady()
    f.tracker.onPageLoad({ instanceId: 'home', route: 'pages/home', query: 'page=1', referralPage: null })
    f.tracker.onPageShow('home', '首页')
    f.tracker.setDataCollect(true)
    f.tracker.onAppShow({ path: 'pages/home', query: 'entry=1', scene: '1001' })
    expect(f.tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(f.tracker.queuedEvents()[1]).toMatchObject({ path: 'pages/home', query: 'page=1' })
  })

  it('does not deduplicate the next native page show when a replay was rejected by a full queue', async () => {
    const f = miniHost(target)
    const pending: Array<Parameters<AppRequestApi['request']>[0]> = []
    f.host.request.mockImplementation(options => { pending.push(options) })
    f.init(); await f.tracker.whenReady(); f.show()
    for (let index = 0; index < 198; index++) expect(f.tracker.track('fill', { index })).toBe(true)
    expect(f.tracker.queuedEvents()).toHaveLength(200)
    f.tracker.onAppHide()
    vi.setSystemTime(Date.now() + 300001)
    f.tracker.onAppShow({ path: 'pages/home', query: '', scene: '1002' })
    for (const request of pending) request.success({ statusCode: 204 })
    expect(f.tracker.queuedEvents()).toHaveLength(0)
    f.tracker.onPageShow('home-1', '首页')
    expect(f.tracker.queuedEvents().map(event => event.eventType)).toEqual(['PAGE'])
  })

  it('does not let source extraData replace a present but unsupported query field', () => {
    const query = { source: { invalid: true }, missing: undefined, get broken() { throw new Error('unavailable') }, good: 'page' }
    const entry = appEntrySnapshot({ path: 'pages/home', query, referrerInfo: { extraData: { source: 'external', missing: 'external', broken: 'external', good: 'external', added: 'ok' } } }, target)
    expect(entry.query).toBe('good=page&added=ok')
  })

  it.each([Infinity, {}, ' ', undefined, null])('ignores an invalid shopping scene override %s without discarding the native scene', override => {
    expect(appEntrySnapshot({ path: 'pages/home', scene: 1001, query: { good: 1, wxShoppingListScene: override } }, target))
      .toMatchObject({ scene: '1001', query: 'good=1' })
  })

  it('isolates a throwing shopping scene getter and reads overrides from supported string queries', () => {
    expect(appEntrySnapshot({ path: 'pages/home', scene: 1001, query: { good: 1, get wxShoppingListScene() { throw new Error('unavailable') } } }, target))
      .toMatchObject({ scene: '1001', query: 'good=1' })
    expect(appEntrySnapshot({ path: 'pages/home', scene: 1001, query: 'good=1&wxShoppingListScene=1007' }, target))
      .toMatchObject({ scene: '1007', query: 'good=1' })
  })

  it('keeps the current replay deduplication when a different page unloads after app show', async () => {
    const f = miniHost(target); f.init(); await f.tracker.whenReady(); f.show()
    f.tracker.onPageLoad({ instanceId: 'detail', route: 'pages/detail', query: '', referralPage: null })
    f.tracker.onPageShow('detail', null)
    f.tracker.onPageHide('detail')
    f.tracker.onPageShow('home-1', '首页')
    f.tracker.onAppHide()
    vi.setSystemTime(Date.now() + 300001)
    f.tracker.onAppShow({ path: 'pages/home', query: '', scene: '1001' })
    const replay = f.tracker.queuedEvents().at(-1)!
    f.tracker.onPageUnload('detail')
    vi.setSystemTime(Date.now() + 1)
    f.tracker.onPageShow('home-1', '首页')
    expect(f.tracker.queuedEvents().filter(event => event.eventType === 'PAGE')).toHaveLength(1)
    expect(f.tracker.queuedEvents().at(-1)).toEqual(replay)
  })
})

it('preserves the legacy App system adapter normalization for an OS value with surrounding whitespace', () => {
  const host = { getDeviceInfo: () => ({ platform: ' Android ' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({}) }
  expect(resolveRuntimeTarget(host, undefined, {})).toBe('app')
})

it('keeps App page forwarding independent of mini-program-only scope metadata', () => {
  const mixin = vi.fn()
  const target = {
    onAppLaunch: () => true, onAppShow: () => true, onAppHide: () => true,
    onPageLoad: vi.fn(() => true), onPageShow: vi.fn(() => true), onPageHide: () => true, onPageUnload: () => true,
  }
  installUniAppLifecycle({ mixin }, target)
  const hooks = mixin.mock.calls[0]![0] as Record<string, (this: unknown, options?: unknown) => void>
  const page = { $mpType: 'page', $page: { route: 'pages/home' }, get $scope() { throw new Error('App has no mini scope') } }
  hooks.onLoad!.call(page, { p: 1 }); hooks.onShow!.call(page)
  expect(target.onPageLoad).toHaveBeenCalledWith({ instanceId: 'pages/home-1', route: 'pages/home', query: 'p=1', referralPage: null })
  expect(target.onPageShow).toHaveBeenCalledWith('pages/home-1', null)
})
