import { describe, expect, it } from 'vitest'

import { normalizeInitOptions } from '../../src/constants/config.js'
import { EventComposer } from '../../src/core/dataStore/index.js'
import { EventSequence } from '../../src/core/dataStore/index.js'
import { LocationState } from '../../src/core/userStore.js'
import { PageStore } from '../../src/core/dataStore/page.js'
import type { AppSystemContext } from '../../src/types/index.js'
import { EventQueue } from '../../src/core/queue.js'
import { SessionManager } from '../../src/core/userStore.js'
import { PageLifecycle } from '../../src/core/dataStore/page.js'

const normalized = normalizeInitOptions({ accountId: 'account', dataSourceId: 'source' })
if (normalized.ok === false) throw new Error('fixture_config_invalid')
const config = normalized.config
const system: AppSystemContext = {
  platform: 'Android', platformVersion: '14', domain: 'com.example.app', appState: 'FOREGROUND', appName: 'Example',
  networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920, deviceBrand: 'Google', deviceModel: 'Pixel',
  deviceType: 'PHONE', appVersion: '1.0.0', language: 'zh-CN', sdkVersion: '0.1.0',
}

/** 装配真实页面、会话和事件组件，以验证 PAGE 上下文与采集门控。 */
function createLifecycle(initialCollection = true, tickingClock = false) {
  let now = 100
  let collect = initialCollection
  const sessions = new SessionManager(config.sessionPolicy, () => 'session-1')
  sessions.resume(0)
  const queue = new EventQueue()
  const clock = { now: () => tickingClock ? now++ : now }
  const pages = new PageStore()
  const lifecycle = new PageLifecycle({
    pages,
    composer: new EventComposer(
      config, system, () => ({ deviceId: 'device-1', userId: null, userKey: null }), sessions,
      new EventSequence(), queue, clock, { getOffsetMinutes: () => 0 }, new LocationState(),
    ),
    clock, orientation: () => 'PORTRAIT', canCollect: () => collect,
  })
  return { lifecycle, pages, queue, setNow: (value: number) => { now = value }, setCollection: (value: boolean) => { collect = value } }
}

describe('PageLifecycle', () => {
  it('uses the captured shown time for PAGE even when separate clock reads cross a millisecond', () => {
    const { lifecycle, queue } = createLifecycle(true, true)
    lifecycle.onLoad({ instanceId: 'home', route: 'pages/home', query: '', referralPage: null })
    const result = lifecycle.onShow('home', 'Home')
    expect(result.page?.shownAt).toBe(100)
    expect(queue.snapshot()[0]?.event.timestamp).toBe(result.page?.shownAt)
  })

  it('refreshes current shown time on consent replay without changing route, query, title or referral', () => {
    const { lifecycle, pages, queue, setNow, setCollection } = createLifecycle(false, true)
    lifecycle.onLoad({ instanceId: 'home', route: 'pages/home', query: 'id=1', referralPage: 'pages/entry' })
    lifecycle.onShow('home', 'Home')
    expect(pages.current()?.shownAt).toBe(100)
    setNow(200)
    expect(lifecycle.replayCurrentPage()).toBe(false)
    expect(pages.current()?.shownAt).toBe(100)
    setCollection(true)
    expect(lifecycle.replayCurrentPage()).toBe(true)
    expect(queue.snapshot()[0]?.event).toMatchObject({ timestamp: 200, path: 'pages/home', query: 'id=1', title: 'Home', referralPage: 'pages/entry' })
    expect(pages.current()?.shownAt).toBe(200)
  })
  it('freezes onLoad fields and emits PAGE for each true onShow with the refreshed title', () => {
    const { lifecycle, queue, setNow } = createLifecycle()
    lifecycle.onLoad({ instanceId: 'detail#1', route: 'pages/detail/index', query: 'id=42', referralPage: 'pages/home/index' })
    lifecycle.onLoad({ instanceId: 'detail#1', route: 'changed', query: 'id=99', referralPage: null })

    expect(lifecycle.onShow('detail#1', 'First title')).toMatchObject({ page: { pageKey: 'page-1', shownAt: 100 }, pageQueued: true })
    setNow(200)
    expect(lifecycle.onShow('detail#1', 'Updated title')).toMatchObject({ pageQueued: true })
    expect(queue.snapshot().map((entry) => entry.event)).toMatchObject([
      { eventType: 'PAGE', eventSequenceId: 1, path: 'pages/detail/index', query: 'id=42', title: 'First title', referralPage: 'pages/home/index', orientation: 'PORTRAIT' },
      { eventType: 'PAGE', eventSequenceId: 2, title: 'Updated title' },
    ])
  })

  it('does not turn page hide into APP_CLOSED and removes hidden context until another page shows', () => {
    const { lifecycle, queue } = createLifecycle()
    lifecycle.onLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
    lifecycle.onShow('home#1', null)
    lifecycle.onHide('home#1')

    expect(lifecycle.replayCurrentPage()).toBe(false)
    expect(queue.snapshot().map((entry) => entry.event.eventType)).toStrictEqual(['PAGE'])
  })

  it('keeps current page context while collection is disabled and emits only its explicit resume replay', () => {
    const { lifecycle, queue, setCollection } = createLifecycle(false)
    lifecycle.onLoad({ instanceId: 'privacy#1', route: 'pages/privacy/index', query: '', referralPage: null })
    expect(lifecycle.onShow('privacy#1', null)).toMatchObject({ pageQueued: false })
    setCollection(true)
    expect(lifecycle.replayCurrentPage()).toBe(true)
    expect(queue.snapshot().map((entry) => entry.event.eventType)).toStrictEqual(['PAGE'])
  })
})
