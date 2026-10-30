import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PageStore, type PageSnapshot } from '../../src/core/dataStore/page.js'
import { hybridFixture, hybridFlush } from '../support/unimp-host.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const storeOf = (runtime: unknown) => Reflect.get(runtime as object, 'pages') as PageStore

describe('uniMP stored page metadata budget', () => {
  it('checks title updates for loaded pages before their first onShow', () => {
    const f = hybridFixture()
    f.runtime.onPageLoad({ instanceId: 'next', route: 'pages/next', query: `q=${'x'.repeat(15000)}`, referralPage: null })
    expect(f.runtime.onPageTitleChanged('next', 't'.repeat(7000))).toBe(false)
    const snapshot = storeOf(f.runtime).snapshot('next')!
    expect(snapshot.title).toBeNull(); expect(snapshot.query).toHaveLength(15002)
    expect(bytes(snapshot)).toBeLessThanOrEqual(16 * 1024)
    expect(f.runtime.onPageTitleChanged('missing', 'title')).toBe(false)
    f.runtime.dispose()
  })

  it('rejects oversized combined title updates for hidden pages while retaining the original metadata', async () => {
    const f = hybridFixture(); await f.connect(false)
    f.page('large', 'pages/large', `q=${'x'.repeat(15000)}`); await hybridFlush(); await f.accept()
    f.runtime.onPageHide('large')
    expect(f.runtime.onPageTitleChanged('large', 't'.repeat(7000))).toBe(false)
    const snapshot = storeOf(f.runtime).snapshot('large')!
    expect(snapshot.title).toBe('Home'); expect(snapshot.query).toHaveLength(15002)
    expect(bytes(snapshot)).toBeLessThanOrEqual(16 * 1024)
    f.runtime.onPageShow('large', null); await hybridFlush(); await f.accept()
    expect(f.native.events.at(-1)?.query).toHaveLength(15002)
    f.runtime.dispose()
  })

  it('bounds the stored snapshot after onLoad adds an entry source', () => {
    const f = hybridFixture()
    f.runtime.onAppLaunch({ path: null, query: null, referralPage: 'r'.repeat(15998) })
    expect(f.runtime.onPageLoad({ instanceId: 'home', route: 'pages/home', query: 'q'.repeat(4000), referralPage: null })).toBe(true)
    const snapshot = storeOf(f.runtime).snapshot('home')!
    expect(snapshot).toMatchObject({ route: 'pages/home', query: '', title: null, referralPage: null })
    expect(bytes(snapshot)).toBeLessThanOrEqual(16 * 1024)
    expect(f.runtime.onPageShow('home', 't'.repeat(5000))).toBe(true)
    expect(storeOf(f.runtime).snapshot('home')).toMatchObject({ query: '', title: null, referralPage: null })
    f.runtime.dispose()
  })

  it('writes the bounded result back after automatic previous-page source is recomputed at onShow', () => {
    const f = hybridFixture()
    const previous = '中'.repeat(4000)
    expect(f.runtime.onPageLoad({ instanceId: 'prev', route: previous, query: '', referralPage: null })).toBe(true)
    f.runtime.onPageShow('prev', null)
    expect(f.runtime.onPageLoad({ instanceId: 'next', route: 'pages/next', query: 'q'.repeat(6000), referralPage: null })).toBe(true)
    const loaded = storeOf(f.runtime).snapshot('next')!
    expect(loaded).toMatchObject({ route: 'pages/next', query: '', referralPage: null })
    expect(bytes(loaded)).toBeLessThanOrEqual(16 * 1024)
    f.runtime.onPageShow('next', 't'.repeat(5000))
    const shown = storeOf(f.runtime).snapshot('next')!
    expect(shown).toMatchObject({ route: 'pages/next', query: '', title: null, referralPage: null })
    expect(bytes(shown)).toBeLessThanOrEqual(16 * 1024)
    f.runtime.dispose()
  })

  it('unloads a page when its required path itself exceeds the budget and rejects association to the previous page', async () => {
    const f = hybridFixture(); await f.connect(); await f.accept()
    expect(f.runtime.onPageLoad({ instanceId: 'invalid', route: '中'.repeat(6000), query: '', referralPage: null })).toBe(false)
    expect(storeOf(f.runtime).snapshot('invalid')).toBeNull()
    expect(f.runtime.onPageShow('invalid', null)).toBe(false)
    const read = vi.fn(() => 'secret')
    expect(f.runtime.track('invalid_page', Object.defineProperty({}, 'secret', { enumerable: true, get: read }))).toBe(false)
    expect(read).not.toHaveBeenCalled()
    f.runtime.dispose()
  })

  it('rechecks required metadata when the shown timestamp grows across the exact boundary', async () => {
    const f = hybridFixture(); await f.connect(false)
    f.runtime.onPageLoad({ instanceId: 'probe', route: 'x', query: '', referralPage: null })
    const overhead = bytes(storeOf(f.runtime).snapshot('probe')) - 1
    f.runtime.onPageUnload('probe')
    const route = 'x'.repeat(16 * 1024 - overhead)
    expect(f.runtime.onPageLoad({ instanceId: 'tight', route, query: '', referralPage: null })).toBe(true)
    expect(bytes(storeOf(f.runtime).snapshot('tight'))).toBe(16 * 1024)
    f.setWall(1_000_000_000_000_000)
    expect(f.runtime.onPageShow('tight', null)).toBe(false)
    expect(storeOf(f.runtime).snapshot('tight')).toBeNull()
    f.runtime.dispose()
  })
})

describe('PageStore selective metadata access', () => {
  it('returns independent snapshots and only replaces the three permitted optional fields', () => {
    const pages = new PageStore()
    pages.onLoad({ instanceId: 'home', route: 'pages/home', query: 'original=1', referralPage: null })
    pages.onShow('home', 100, 'Original')
    const snapshot = pages.snapshot('home')!
    Object.assign(snapshot, { query: 'mutated=1' })
    expect(pages.snapshot('home')?.query).toBe('original=1')
    const metadata = { query: '', title: null, referralPage: 'source', route: 'forged', pageKey: 'forged', shownAt: -1 }
    const updated = pages.replaceMetadata('home', metadata)!
    expect(updated).toMatchObject({ route: 'pages/home', pageKey: 'page-1', shownAt: 100, query: '', title: null, referralPage: 'source' })
    expect(pages.current()).toEqual(updated)
    expect(pages.snapshot('missing')).toBeNull()
    expect(pages.replaceMetadata('missing', metadata)).toBeNull()
    for (const change of [{ query: null }, { title: 1 }, { referralPage: {} }]) {
      expect(pages.replaceMetadata('home', { ...metadata, ...change } as unknown as Pick<PageSnapshot, 'query' | 'title' | 'referralPage'>)).toBeNull()
    }
    expect(pages.current()).toEqual(updated)
  })
})
