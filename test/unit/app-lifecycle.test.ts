import { describe, expect, it } from 'vitest'

import { normalizeInitOptions } from '../../src/constants/config.js'
import { EventComposer } from '../../src/core/dataStore/index.js'
import { EventSequence } from '../../src/core/dataStore/index.js'
import { LocationState } from '../../src/core/userStore.js'
import { PageStore } from '../../src/core/dataStore/page.js'
import type { AppSystemContext } from '../../src/types/index.js'
import { EventQueue } from '../../src/core/queue.js'
import { SessionManager } from '../../src/core/userStore.js'
import { AppLifecycle, type AppLifecycleDependencies } from '../../src/core/dataStore/app.js'

const normalized = normalizeInitOptions({ accountId: 'account', dataSourceId: 'source' })
if (normalized.ok === false) throw new Error('fixture_config_invalid')
const config = normalized.config

const system: AppSystemContext = {
  platform: 'iOS', platformVersion: '18', domain: 'com.example.app', appState: 'FOREGROUND', appName: 'Example',
  networkState: 'WIFI', screenWidth: 390, screenHeight: 844, deviceBrand: 'Apple', deviceModel: 'iPhone',
  deviceType: 'PHONE', appVersion: '1.0.0', language: 'en-US', sdkVersion: '0.1.0',
}

/** 装配可控制时间、采集开关和刷新顺序的 App 生命周期测试对象。 */
function createLifecycle(initialCollection = true, initialSession: Readonly<{ sessionId: string; lastCloseTime: number | null }> | null = null,
  overrides: Partial<AppLifecycleDependencies> = {}) {
  let now = 0
  let collect = initialCollection
  let persisted = 0
  let flushed = 0
  const sessions = new SessionManager(config.sessionPolicy, (() => {
    let index = 0
    return () => `session-${++index}`
  })(), initialSession)
  const queue = new EventQueue()
  const pages = new PageStore()
  const lifecycle = new AppLifecycle({
    sessions,
    composer: new EventComposer(
      config, system, () => ({ deviceId: 'device-1', userId: null, userKey: null }), sessions,
      new EventSequence(), queue, { now: () => now }, { getOffsetMinutes: () => 0 }, new LocationState(),
    ),
    clock: { now: () => now },
    canCollect: () => collect,
    currentPage: () => pages.current(),
    persistSession: () => { persisted += 1 },
    forceFlush: () => { flushed += 1 },
    ...overrides,
  })
  return {
    lifecycle, queue, sessions, pages,
    setNow: (value: number) => { now = value },
    setCollection: (value: boolean) => { collect = value },
    calls: () => ({ persisted, flushed }),
  }
}

describe('AppLifecycle', () => {
  it('首个会话之前进入后台不产生 APP_CLOSED，存储和强制上传异常被隔离', () => {
    const { lifecycle, queue } = createLifecycle(true, null, {
      persistSession: () => { throw new Error('storage failed') },
      forceFlush: () => { throw new Error('flush failed') },
    })
    expect(lifecycle.onHide()).toEqual({ session: null, appClosedQueued: false })
    expect(lifecycle.onShow({ path: '', query: null }).visitQueued).toBe(true)
    expect(lifecycle.onHide().appClosedQueued).toBe(true)
    expect(queue.snapshot().map(entry => entry.event.eventType)).toEqual(['VISIT', 'APP_CLOSED'])
    expect(lifecycle.entry().current).toEqual({ path: null, query: null })
  })

  it('无入口上下文时恢复采集和切换用户安全生成 VISIT，关闭采集时不生成', () => {
    const { lifecycle, queue, setCollection } = createLifecycle(false)
    expect(lifecycle.onUserChanged()).toBe(false)
    expect(lifecycle.onCollectionResumed().visitQueued).toBe(false)
    expect(lifecycle.onHide().appClosedQueued).toBe(false)
    expect(queue.snapshot()).toEqual([])
    setCollection(true)
    expect(lifecycle.onCollectionResumed().visitQueued).toBe(true)
    expect(lifecycle.onUserChanged()).toBe(true)
    expect(queue.snapshot().map(entry => entry.event.eventType)).toEqual(['VISIT', 'VISIT'])
  })
  it('records launch without a duplicate VISIT, then sends the onShow entry', () => {
    const { lifecycle, queue } = createLifecycle()
    lifecycle.onLaunch({ path: '/launch', query: 'from=launch' })
    expect(queue.snapshot()).toHaveLength(0)

    expect(lifecycle.onShow({ path: '/home', query: 'tab=feed' })).toMatchObject({
      session: { startedNew: true, reason: 'initial' }, visitQueued: true,
    })
    expect(queue.snapshot()[0]?.event).toMatchObject({ eventType: 'VISIT', path: '/home', query: 'tab=feed' })
    expect(lifecycle.entry()).toStrictEqual({
      launch: { path: '/launch', query: 'from=launch' }, current: { path: '/home', query: 'tab=feed' },
    })
  })

  it('continues a hot session without VISIT, while onHide queues APP_CLOSED then persists and flushes', () => {
    const { lifecycle, queue, pages, setNow, calls } = createLifecycle()
    lifecycle.onShow({ path: '/home', query: '' })
    pages.onLoad({ instanceId: 'home#1', route: 'pages/home/index', query: 'tab=feed', referralPage: null })
    pages.onShow('home#1', 1, null)
    setNow(10)
    expect(lifecycle.onHide()).toMatchObject({ appClosedQueued: true, session: { lastCloseTime: 10 } })
    setNow(30_010)
    expect(lifecycle.onShow({ path: '/home', query: '' })).toMatchObject({
      session: { startedNew: false }, visitQueued: false,
    })
    expect(queue.snapshot().map((entry) => entry.event.eventType)).toStrictEqual(['VISIT', 'APP_CLOSED'])
    expect(queue.snapshot()[1]?.event).toMatchObject({ appState: 'BACKGROUND', path: 'pages/home/index', query: 'tab=feed' })
    expect(calls()).toStrictEqual({ persisted: 3, flushed: 1 })
  })

  it('starts a new session and sends VISIT after a cold process launch, even within the background timeout', () => {
    const { lifecycle, queue } = createLifecycle(true, { sessionId: 'persisted-session', lastCloseTime: 10 })
    lifecycle.onLaunch({ path: '/launch', query: 'source=restart' })

    expect(lifecycle.onShow({ path: '/home', query: '' })).toMatchObject({
      session: { startedNew: true, reason: 'cold_start', snapshot: { sessionId: 'session-1', lastCloseTime: null } },
      visitQueued: true,
    })
    expect(queue.snapshot()).toMatchObject([{ event: { eventType: 'VISIT', sessionId: 'session-1', path: '/home' } }])
  })

  it('starts a new session and VISIT strictly after the 30 second default timeout', () => {
    const { lifecycle, queue, setNow } = createLifecycle()
    lifecycle.onShow({ path: '/home', query: '' })
    lifecycle.onHide()
    setNow(30_001)

    expect(lifecycle.onShow({ path: '/return', query: 'source=push' })).toMatchObject({
      session: { startedNew: true, reason: 'timeout', snapshot: { sessionId: 'session-2' } }, visitQueued: true,
    })
    expect(queue.snapshot().filter((entry) => entry.event.eventType === 'VISIT')).toHaveLength(2)
  })

  it('keeps state while collection is disabled and explicitly renews before replaying VISIT after consent', () => {
    const { lifecycle, queue, sessions, setCollection, calls } = createLifecycle(false)
    expect(lifecycle.onShow({ path: '/privacy', query: '' })).toMatchObject({ visitQueued: false })
    expect(sessions.current()).toMatchObject({ sessionId: 'session-1' })
    setCollection(true)
    expect(lifecycle.onCollectionResumed()).toMatchObject({
      session: { startedNew: true, reason: 'collection_resumed', snapshot: { sessionId: 'session-2' } }, visitQueued: true,
    })
    expect(queue.snapshot().map((entry) => entry.event.eventType)).toStrictEqual(['VISIT'])
    expect(calls()).toStrictEqual({ persisted: 2, flushed: 0 })
  })
})
