import { describe, expect, it } from 'vitest'

import { PageStore } from '../../src/core/dataStore/page.js'

describe('PageStore', () => {
  it('同一路由不同实例返回时更新来源，同一实例后台恢复保留来源', () => {
    const pages = new PageStore()
    const load = (instanceId: string, route: string) => pages.onLoad({ instanceId, route, query: '', referralPage: null })
    load('home', 'pages/home')
    pages.onShow('home', 1, null)
    load('detail-a', 'pages/detail')
    expect(pages.onShow('detail-a', 2, null)?.referralPage).toBe('pages/home')
    pages.onHide('detail-a')
    load('detail-b', 'pages/detail')
    expect(pages.onShow('detail-b', 3, null)?.referralPage).toBe('pages/detail')
    pages.onUnload('detail-b')
    expect(pages.onShow('detail-a', 4, null)?.referralPage).toBe('pages/detail')
    pages.onHide('detail-a')
    expect(pages.onShow('detail-a', 5, null)?.referralPage).toBe('pages/detail')
  })

  it('自动来源覆盖进入、返回、替换及 tab 切换，同页恢复不会成为自己的来源', () => {
    const pages = new PageStore()
    const load = (id: string) => pages.onLoad({ instanceId: id, route: `pages/${id}`, query: '', referralPage: null })
    load('home')
    expect(pages.onShow('home', 1, null)?.referralPage).toBeNull()
    pages.onHide('home')
    load('detail')
    expect(pages.onShow('detail', 2, null)?.referralPage).toBe('pages/home')
    pages.onUnload('detail')
    expect(pages.onShow('home', 3, null)?.referralPage).toBe('pages/detail')
    pages.onHide('home')
    expect(pages.onShow('home', 4, null)?.referralPage).toBe('pages/detail')
    pages.onUnload('home')
    load('replacement')
    expect(pages.onShow('replacement', 5, null)?.referralPage).toBe('pages/home')
    load('tab')
    expect(pages.onShow('tab', 6, null)?.referralPage).toBe('pages/replacement')
    expect(pages.onShow('replacement', 7, null)?.referralPage).toBe('pages/tab')
  })

  it('freezes onLoad query/referral while each onShow refreshes title and shown time', () => {
    const pages = new PageStore()
    expect(pages.onLoad({ instanceId: 'detail#1', route: 'pages/detail/index', query: 'id=42', referralPage: 'pages/home/index' })).toMatchObject({
      pageKey: 'page-1', query: 'id=42', referralPage: 'pages/home/index', shownAt: null,
    })
    expect(pages.onLoad({ instanceId: 'detail#1', route: 'changed', query: 'id=99', referralPage: null })).toMatchObject({
      route: 'pages/detail/index', query: 'id=42', referralPage: 'pages/home/index',
    })
    expect(pages.onShow('detail#1', 100, '详情')).toMatchObject({ query: 'id=42', title: '详情', shownAt: 100 })
    expect(pages.onShow('detail#1', 200, '详情（已更新）')).toMatchObject({ query: 'id=42', title: '详情（已更新）', shownAt: 200 })
  })

  it('keeps same-route instances distinct and follows the current shown page', () => {
    const pages = new PageStore()
    pages.onLoad({ instanceId: 'detail#1', route: 'pages/detail/index', query: 'id=1', referralPage: null })
    pages.onLoad({ instanceId: 'detail#2', route: 'pages/detail/index', query: 'id=2', referralPage: 'pages/detail/index' })
    pages.onShow('detail#1', 1, null)
    expect(pages.onShow('detail#2', 2, null)).toMatchObject({ pageKey: 'page-2', query: 'id=2' })
    expect(pages.current()).toMatchObject({ pageKey: 'page-2', route: 'pages/detail/index' })
  })

  it('does not retain lifecycle instances after unload or accept an unbound show', () => {
    const pages = new PageStore()
    expect(pages.onShow('missing', 1, null)).toBeNull()
    pages.onLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
    pages.onShow('home#1', 1, null)
    pages.onUnload('home#1')
    expect(pages.current()).toBeNull()
  })
})
