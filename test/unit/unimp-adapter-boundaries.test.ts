import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installUniAppLifecycle } from '../../src/adapters/uniapp.js'
import { hybridFixture, hybridFlush } from '../support/unimp-host.js'

type Instance = Record<string, unknown>
type Hooks = {
  onLaunch(this: Instance, entry: unknown): void
  onShow(this: Instance, entry?: unknown): void
  onLoad(this: Instance, query: unknown): void
  onHide(this: Instance): void
  onUnload(this: Instance): void
}
type TitleArgs = { title: string; success?: (...args: unknown[]) => unknown }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function fixture() {
  const f = hybridFixture()
  let hooks!: Hooks
  let interceptor!: { invoke(options: TitleArgs): void }
  installUniAppLifecycle({ mixin: value => { hooks = value as Hooks } }, f.runtime, {
    unimp: true,
    host: { addInterceptor: (_name: string, value: typeof interceptor) => { interceptor = value } },
  })
  const app = { $mpType: 'app' }
  const page = { $mpType: 'page', $page: { route: 'pages/home' } } as Instance
  const connect = async (entry: unknown = {}, query: unknown = {}) => {
    hooks.onLaunch.call(app, entry); hooks.onShow.call(app, entry)
    hooks.onLoad.call(page, query); hooks.onShow.call(page)
    f.native.reply(); await hybridFlush(); f.native.reply(); await hybridFlush()
  }
  return { ...f, hooks, interceptor, app, page, connect }
}

describe('uniMP lifecycle adapter metadata boundaries', () => {
  it('does not read or cache unused launch path/query and preserves an explicit source through the public hook', async () => {
    const f = fixture()
    const launched = vi.spyOn(f.runtime, 'onAppLaunch')
    const shown = vi.spyOn(f.runtime, 'onAppShow')
    const path = vi.fn(() => { throw Error('must not inspect unused path') })
    const query = vi.fn(() => ({ huge: 'x'.repeat(100_000) }))
    const entry = { referralPage: 'explicit-source', referrerInfo: { appId: 'fallback-source' } }
    Object.defineProperties(entry, { path: { get: path }, query: { get: query } })
    await f.connect(entry)
    expect(path).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled()
    expect(launched).toHaveBeenCalledExactlyOnceWith({ path: null, query: null, referralPage: 'explicit-source' })
    expect(shown).toHaveBeenCalledWith({ path: null, query: null, referralPage: 'explicit-source' })
    expect(f.native.events[0]).toMatchObject({ eventType: 'PAGE', referralPage: 'explicit-source' })
    f.runtime.dispose()
  })

  it.each([
    ['referrer source', { referrerInfo: { appId: 'source-app' } }, 'source-app'],
    ['empty explicit source', { referralPage: '', referrerInfo: { appId: 'source-app' } }, 'source-app'],
    ['blank explicit source', { referralPage: ' ', referrerInfo: { appId: 'source-app' } }, 'source-app'],
    ['UTF-8 overflow', { referralPage: '中'.repeat(6000), referrerInfo: { appId: 'bounded-source' } }, 'bounded-source'],
    ['long explicit source', { referralPage: 'x'.repeat(16001), referrerInfo: { appId: 'bounded-source' } }, 'bounded-source'],
    ['exact byte boundary', { referralPage: 'x'.repeat(15998) }, 'x'.repeat(15998)],
    ['oversized fallback source', { referrerInfo: { appId: 'x'.repeat(16001), extraData: { private: 'ignored' } } }, undefined],
  ])('keeps source priority and byte limits for %s', async (_name, entry, expected) => {
    const f = fixture(); await f.connect(entry)
    expect(f.native.events[0]?.referralPage).toBe(expected)
    f.runtime.dispose()
  })

  it('ignores a broken source field while retaining other valid metadata and the foreground hook', async () => {
    const f = fixture()
    const entry = { get referralPage() { throw Error('broken field') }, referrerInfo: { appId: 'fallback-source' } }
    await f.connect(entry)
    expect(f.runtime.ready()).toBe(true)
    expect(f.native.events[0]?.referralPage).toBe('fallback-source')
    f.runtime.dispose()
  })

  it('bounds a custom or configured onShow title before it reaches the core', async () => {
    const f = fixture()
    f.page.gioPageTitle = '中'.repeat(3000)
    const shown = vi.spyOn(f.runtime, 'onPageShow')
    await f.connect()
    expect(shown).toHaveBeenCalledWith('unimp-page-1', null)
    expect(f.native.events[0]).not.toHaveProperty('title')
    delete f.page.gioPageTitle
    f.page.$page = { route: 'pages/home', meta: { navigationBar: { titleText: 'y'.repeat(9000) } } }
    f.hooks.onShow.call(f.page)
    expect(shown).toHaveBeenLastCalledWith('unimp-page-1', null)
    f.runtime.dispose()
  })

  it('does not retain or replay oversized titles, including reused success callback options', async () => {
    const f = fixture(); await f.connect()
    const changed = vi.spyOn(f.runtime, 'onPageTitleChanged')
    const receiver = {}; const business = vi.fn(function(this: unknown, value: unknown) { expect(this).toBe(receiver); return value })
    const args: TitleArgs = { title: 'safe-title', success: business }
    f.interceptor.invoke(args)
    expect(args.success!.call(receiver, 'first')).toBe('first')
    expect(changed).toHaveBeenLastCalledWith('unimp-page-1', 'safe-title')
    changed.mockClear()
    args.title = '中'.repeat(3000)
    f.interceptor.invoke(args)
    expect(args.success).toBe(business)
    expect(args.success!.call(receiver, 'second')).toBe('second')
    expect(changed).not.toHaveBeenCalled()
    f.hooks.onShow.call(f.page); await hybridFlush(); f.native.reply(); await hybridFlush()
    expect(f.native.events.at(-1)).toMatchObject({ eventType: 'PAGE', title: 'safe-title' })
    expect(business).toHaveBeenCalledTimes(2)
    f.runtime.dispose()
  })

  it('caches a title only when the core accepts the whole page within its 16KiB metadata budget', async () => {
    const f = fixture(); await f.connect({}, `q=${'x'.repeat(15000)}`)
    const changed = vi.spyOn(f.runtime, 'onPageTitleChanged')
    const business = vi.fn()
    const args: TitleArgs = { title: 't'.repeat(7000), success: business }
    f.interceptor.invoke(args); args.success!({})
    expect(changed).toHaveReturnedWith(false)
    expect(business).toHaveBeenCalledOnce()
    const shown = vi.spyOn(f.runtime, 'onPageShow')
    f.hooks.onShow.call(f.page); await hybridFlush(); f.native.reply(); await hybridFlush()
    expect(shown).toHaveBeenLastCalledWith('unimp-page-1', null)
    expect(f.native.events.at(-1)).not.toHaveProperty('title')
    expect(f.native.events.at(-1)?.query).toHaveLength(15002)
    f.runtime.dispose()
  })

  it('does not cache a navigation title through an oversized manual override and still calls business success', async () => {
    const f = fixture(); await f.connect()
    f.page.gioPageTitle = 'x'.repeat(9000)
    const changed = vi.spyOn(f.runtime, 'onPageTitleChanged')
    const business = vi.fn()
    const args: TitleArgs = { title: 'navigation-title', success: business }
    f.interceptor.invoke(args); args.success!()
    expect(changed).not.toHaveBeenCalled(); expect(business).toHaveBeenCalledOnce()
    delete f.page.gioPageTitle
    const shown = vi.spyOn(f.runtime, 'onPageShow')
    f.hooks.onShow.call(f.page)
    expect(shown).toHaveBeenLastCalledWith('unimp-page-1', null)
    f.runtime.dispose()
  })

  it('preserves the existing default App entry and title forwarding behavior', () => {
    let hooks!: Hooks; let interceptor!: { invoke(options: TitleArgs): void }
    const target = { onAppLaunch: vi.fn((_entry: unknown) => true), onAppShow: () => true, onAppHide: () => true, onPageLoad: () => true,
      onPageShow: vi.fn(() => true), onPageHide: () => true, onPageUnload: () => true, onPageTitleChanged: vi.fn(() => true) }
    installUniAppLifecycle({ mixin: value => { hooks = value as Hooks } }, target, { host: { addInterceptor: (_: unknown, value: typeof interceptor) => { interceptor = value } } })
    hooks.onLaunch.call({}, { path: 'pages/home', query: { payload: 'x'.repeat(20000) } })
    expect(target.onAppLaunch.mock.calls[0]?.[0]).toEqual({ path: 'pages/home', query: `payload=${'x'.repeat(20000)}` })
    const page = { $mpType: 'page', $page: { route: 'pages/home' } }
    hooks.onLoad.call(page, {}); const args: TitleArgs = { title: 't'.repeat(10000) }
    interceptor.invoke(args); args.success!(); hooks.onShow.call(page)
    expect(target.onPageShow).toHaveBeenCalledWith('pages/home-1', args.title)
  })
})
