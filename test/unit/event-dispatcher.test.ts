import { describe, expect, it } from 'vitest'

import { normalizeInitOptions } from '../../src/constants/config.js'
import { EventComposer } from '../../src/core/dataStore/index.js'
import { EventDispatcher } from '../../src/core/dataStore/index.js'
import { EventSequence } from '../../src/core/dataStore/index.js'
import { LocationState } from '../../src/core/userStore.js'
import { PageStore } from '../../src/core/dataStore/page.js'
import type { AppSystemContext } from '../../src/types/index.js'
import { EventQueue } from '../../src/core/queue.js'
import { SessionManager } from '../../src/core/userStore.js'

const normalized = normalizeInitOptions({ accountId: 'account', dataSourceId: 'source' })
if (normalized.ok === false) throw new Error('fixture_config_invalid')
const config = normalized.config
const system: AppSystemContext = {
  platform: 'HarmonyOS', platformVersion: '5', domain: 'com.example.app', appState: 'FOREGROUND', appName: 'Example',
  networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920, deviceBrand: 'Example', deviceModel: 'Example One',
  deviceType: 'PHONE', appVersion: '1.0.0', language: 'zh-CN', sdkVersion: '0.1.0',
}

/** 创建事件分发器及其真实组装和队列依赖，以核对最终报文。 */
function createDispatcher() {
  const sessions = new SessionManager(config.sessionPolicy, () => 'session-1')
  sessions.resume(0)
  const queue = new EventQueue()
  const sequence = new EventSequence()
  const pages = new PageStore()
  pages.onLoad({ instanceId: 'detail#1', route: 'pages/detail/index', query: 'id=42', referralPage: null })
  pages.onShow('detail#1', 99, 'Detail')
  const dispatcher = new EventDispatcher(
    new EventComposer(
      config, system, () => ({ deviceId: 'device-1', userId: 'user-1', userKey: null }), sessions,
      sequence, queue, { now: () => 100 }, { getOffsetMinutes: () => -480 }, new LocationState(),
    ),
    () => pages.current(),
  )
  return { dispatcher, queue, sequence }
}

describe('EventDispatcher', () => {
  it('normalizes custom attributes and carries only the allowed current page context', () => {
    const { dispatcher, queue } = createDispatcher()
    expect(dispatcher.track({ eventName: 'product_view', properties: { count: 0, enabled: false, tags: ['a', 'b'], nested: { no: true } } })).toBe(true)

    expect(queue.snapshot()[0]?.event).toStrictEqual(expect.objectContaining({
      eventType: 'CUSTOM', eventName: 'product_view', eventSequenceId: 1,
      path: 'pages/detail/index', query: 'id=42',
      attributes: { count: '0', enabled: 'false', tags: 'a||b' },
    }))
    expect(queue.snapshot()[0]?.event).not.toHaveProperty('title')
    expect(queue.snapshot()[0]?.event).not.toHaveProperty('referralPage')
    expect(queue.snapshot()[0]?.event).not.toHaveProperty('pageShowTimestamp')
  })

  it('refuses an invalid name without advancing the shared event sequence', () => {
    const { dispatcher, sequence } = createDispatcher()
    expect(dispatcher.track({ eventName: 'invalid name', properties: {} })).toBe(false)
    expect(sequence.current()).toStrictEqual({ eventSequenceId: 0 })
  })

  it('sends user attributes without a page or sequence dependency', () => {
    const { dispatcher, queue, sequence } = createDispatcher()
    expect(dispatcher.setUserAttributes({ plan: 'pro' })).toBe(true)

    expect(queue.snapshot()[0]?.event).toMatchObject({
      eventType: 'LOGIN_USER_ATTRIBUTES', userId: 'user-1', attributes: { plan: 'pro' },
    })
    expect(queue.snapshot()[0]?.event).not.toHaveProperty('eventSequenceId')
    expect(sequence.current()).toStrictEqual({ eventSequenceId: 0 })
  })

  it('builds VIEW events from normalized calls and excludes click-only fields from change', () => {
    const { dispatcher, queue } = createDispatcher()
    expect(dispatcher.autoTrack({ kind: 'click', xpath: 'buy#save', textValue: 'Buy', index: 1, hyperlink: '/buy' })).toBe(true)
    expect(dispatcher.autoTrack({ kind: 'change', xpath: '#search', textValue: 'false' })).toBe(true)
    expect(queue.snapshot().map((entry) => entry.event)).toMatchObject([
      { eventType: 'VIEW_CLICK', eventSequenceId: 1, path: 'pages/detail/index', xpath: 'buy#save', index: 1, hyperlink: '/buy' },
      { eventType: 'VIEW_CHANGE', eventSequenceId: 2, xpath: '#search', textValue: 'false' },
    ])
    expect(queue.snapshot()[1]?.event).not.toHaveProperty('index')
    expect(queue.snapshot()[1]?.event).not.toHaveProperty('hyperlink')
    expect(queue.snapshot()[1]?.event).not.toHaveProperty('eventName')
    for (const { event } of queue.snapshot()) expect(event).not.toHaveProperty('pageShowTimestamp')
  })
})
