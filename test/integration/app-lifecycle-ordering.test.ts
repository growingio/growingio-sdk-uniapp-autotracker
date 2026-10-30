import { describe, expect, it } from 'vitest'

import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import { SessionPersistence, storageKeys } from '../../src/core/storage/index.js'
import { appSystem, RuntimeStorage, runtimeFixture } from '../support/runtime-fixture.js'

const config = { accountId: 'account', dataSourceId: 'source' }
const entry = { path: 'pages/home', query: 'entry=1' }
const home = { instanceId: 'home', route: 'pages/home', query: 'page=1', referralPage: null }

describe.each(['Android', 'iOS', 'HarmonyOS'] as const)('%s App lifecycle ordering', platform => {
  it.each([
    ['hydrating', false], ['hydrating', true], ['ready', false], ['ready', true],
  ] as const)('waits for the cold-start VISIT before emitting an early PAGE: %s, restored session=%s', async (phase, restored) => {
    const storage = new RuntimeStorage()
    if (restored) await new SessionPersistence(storage, storageKeys('source').session).persist({ sessionId: 'previous-session', lastCloseTime: null })
    const { tracker } = runtimeFixture({ storage, systemContext: { load: async () => ({ ...appSystem, platform }) } })
    tracker.init(config)
    if (phase === 'ready') await tracker.whenReady()
    tracker.onAppLaunch(entry)
    tracker.onPageLoad(home)
    tracker.onPageShow('home', 'Home')
    await tracker.whenReady()

    expect(tracker.queuedEvents()).toEqual([])
    tracker.onAppShow(entry)
    expect(tracker.queuedEvents()).toMatchObject([
      { eventType: 'VISIT', sessionId: 'session-1', path: 'pages/home', query: 'entry=1' },
      { eventType: 'PAGE', sessionId: 'session-1', path: 'pages/home', query: 'page=1', title: 'Home' },
    ])
    expect(tracker.queuedEvents()).toHaveLength(2)
  })

  it.each(['hydrating', 'ready'] as const)('keeps title updates received while an early PAGE waits for App show: %s', async phase => {
    const { tracker } = runtimeFixture({ systemContext: { load: async () => ({ ...appSystem, platform }) } })
    tracker.init(config)
    if (phase === 'ready') await tracker.whenReady()
    tracker.onAppLaunch(entry)
    tracker.onPageLoad(home)
    tracker.onPageLoad({ ...home, instanceId: 'other', route: 'pages/other' })
    tracker.onPageShow('home', 'Initial')
    tracker.onPageTitleChanged('home', 'Updated')
    tracker.onPageTitleChanged('other', 'Other page')
    await tracker.whenReady()

    expect(tracker.queuedEvents()).toEqual([])
    tracker.onAppShow(entry)
    expect(tracker.queuedEvents()).toMatchObject([
      { eventType: 'VISIT', sessionId: 'session-1' },
      { eventType: 'PAGE', sessionId: 'session-1', path: 'pages/home', title: 'Updated' },
    ])
    expect(tracker.queuedEvents()).toHaveLength(2)
  })

  it.each([[30_100, false], [30_101, true]] as const)('waits for App resume before emitting an early PAGE: time=%i, renewed=%s', async (now, renewed) => {
    const { tracker, setNow } = runtimeFixture({ systemContext: { load: async () => ({ ...appSystem, platform }) } })
    tracker.init(config)
    tracker.onAppLaunch(entry)
    tracker.onAppShow(entry)
    tracker.onPageLoad(home)
    tracker.onPageShow('home', 'Home')
    await tracker.whenReady()
    tracker.onPageHide('home')
    tracker.onAppHide()
    const beforeResume = tracker.queuedEvents()

    setNow(now)
    tracker.onPageShow('home', 'Resumed')
    expect(tracker.queuedEvents()).toEqual(beforeResume)
    tracker.onAppShow(entry)
    const resumed = tracker.queuedEvents().slice(beforeResume.length)
    expect(resumed.map(event => event.eventType)).toEqual(renewed ? ['VISIT', 'PAGE'] : ['PAGE'])
    expect(resumed.every(event => event.sessionId === (renewed ? 'session-2' : 'session-1'))).toBe(true)
    expect(resumed.at(-1)).toMatchObject({ timestamp: now, title: 'Resumed', query: 'page=1' })
  })

  it.each(['page-hide', 'page-unload', 'app-hide'] as const)('cancels a pending PAGE when it is no longer visible: %s', async cancellation => {
    const { tracker } = runtimeFixture({ systemContext: { load: async () => ({ ...appSystem, platform }) } })
    tracker.init(config)
    await tracker.whenReady()
    tracker.onAppLaunch(entry)
    tracker.onPageLoad(home)
    tracker.onPageShow('home', 'Home')
    if (cancellation === 'page-hide') tracker.onPageHide('home')
    else if (cancellation === 'page-unload') tracker.onPageUnload('home')
    else tracker.onAppHide()
    tracker.onAppShow(entry)
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT'])
  })

  it('uses consent at App show when collection opens after an early page show', async () => {
    const { tracker } = runtimeFixture({ systemContext: { load: async () => ({ ...appSystem, platform }) } })
    tracker.init({ ...config, dataCollect: false })
    await tracker.whenReady()
    tracker.onAppLaunch(entry)
    tracker.onPageLoad(home)
    tracker.onPageShow('home', 'Home')
    tracker.setDataCollect(true)
    tracker.onAppShow(entry)
    expect(tracker.queuedEvents().map(event => event.eventType)).toEqual(['VISIT', 'PAGE'])
    expect(tracker.queuedEvents().every(event => event.sessionId === 'session-1')).toBe(true)
  })
})

it('keeps an uploaded historical PAGE in its original session when a new VISIT follows', async () => {
  const first = runtimeFixture().tracker
  first.init(config)
  first.onAppShow(entry)
  first.onPageLoad(home)
  first.onPageShow('home', 'Cached')
  await first.whenReady()
  const cachedPage = first.queuedEvents()[1]!
  const storage = new RuntimeStorage()
  storage.values.set(storageKeys('source').queue, JSON.stringify({
    version: 1, revision: 1, entries: [{ requestId: 'q2', event: cachedPage, retryCount: 0 }],
  }))
  const received: ProtocolEvent[] = []
  const { tracker, setNow } = runtimeFixture({
    storage,
    sessionIdFactory: () => 'new-process-session',
    upload: {
      transport: { dispatch: (request, done) => { received.push(...JSON.parse(request.body)); done({ kind: 'success', status: 204 }) } },
      runtime: { now: () => 22_500, random: () => 0.5, setTimeout: () => 1, clearTimeout: () => undefined },
    },
  })
  setNow(22_500)
  tracker.init(config)
  tracker.onAppLaunch(entry)
  await tracker.whenReady()
  expect(received).toEqual([cachedPage])
  tracker.onAppShow(entry)
  expect(received).toMatchObject([
    { eventType: 'PAGE', sessionId: 'session-1', timestamp: 100, eventSequenceId: 2 },
    { eventType: 'VISIT', sessionId: 'new-process-session', timestamp: 22_500, eventSequenceId: 3 },
  ])
  expect(received).toHaveLength(2)
})
