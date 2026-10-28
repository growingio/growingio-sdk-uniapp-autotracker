import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_QUEUE_RETENTION_MS } from '../../src/core/queue.js'
import { storageKeys } from '../../src/core/storage/index.js'
import type { AppPlatform, NetworkState } from '../../src/types/index.js'
import { APP_EVENT_FIXTURES } from '../contracts/app-protocol.fixture.js'
import { appSystem, runtimeFixture, RuntimeStorage } from '../support/runtime-fixture.js'
import { miniHost } from '../support/miniprogram-host.js'

const config = { accountId: 'account', dataSourceId: 'source' }
const entry = { path: 'pages/home', query: '' }
const keys = storageKeys('source')

/** 等待已有的队列写入合并完成，再核对本地快照。 */
async function settleStorage(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

describe.each<AppPlatform>(['Android', 'iOS', 'HarmonyOS'])('%s App 缓存保留 7 天', platform => {
  it.each([-1, 0, 1])('按原事件时间恢复旧格式缓存：距到期 %s 毫秒', async remaining => {
    const now = 1_800_000_000_000
    const storage = new RuntimeStorage()
    const cached = { ...APP_EVENT_FIXTURES.CUSTOM, eventSequenceId: 90, timestamp: now - APP_QUEUE_RETENTION_MS + remaining }
    const record = { version: 1, revision: 7, entries: [{ requestId: 'q1', event: cached, retryCount: 1 }] }
    storage.values.set(keys.queue, JSON.stringify(record))
    const { tracker } = runtimeFixture({ storage, clock: { now: () => now }, systemContext: { load: async () => ({ ...appSystem, platform }) } })
    tracker.init(config)
    expect(await tracker.whenReady()).toBe(true)
    const expected = remaining > 0 ? [cached] : []
    expect(tracker.queuedEvents()).toEqual(expected)
    await settleStorage()
    const persisted = JSON.parse(storage.values.get(keys.queue)!)
    expect(persisted.entries).toEqual(remaining > 0 ? record.entries : [])
    expect(persisted.revision).toBe(remaining > 0 ? 7 : 8)
    let active = tracker
    if (remaining <= 0) {
      // 清理后未产生新事件就再次退出，也须保存过期事件已经使用的序号。
      active = runtimeFixture({ storage, clock: { now: () => now }, systemContext: { load: async () => ({ ...appSystem, platform }) } }).tracker
      active.init(config); await active.whenReady()
    }
    active.onAppShow(entry)
    expect(active.queuedEvents().at(-1)).toMatchObject({ eventType: 'VISIT', eventSequenceId: 91, platform })
  })
})

describe('App 缓存过期的运行时调度', () => {
  it('无法判定年龄的旧缓存被清理，有时间戳的有效事件及已使用序号仍保留', async () => {
    const now = 1_800_000_000_000
    const storage = new RuntimeStorage()
    const { timestamp: _timestamp, ...undated } = APP_EVENT_FIXTURES.CUSTOM
    const retained = { ...APP_EVENT_FIXTURES.CUSTOM, timestamp: now, eventSequenceId: 80 }
    storage.values.set(keys.queue, JSON.stringify({ version: 1, revision: 7, entries: [
      { requestId: 'q1', event: { ...undated, eventSequenceId: 90 }, retryCount: 0 },
      { requestId: 'q2', event: retained, retryCount: 1 },
    ] }))
    const { tracker } = runtimeFixture({ storage, clock: { now: () => now } })
    tracker.init(config)
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.queuedEvents()).toEqual([retained])
    await settleStorage()
    expect(JSON.parse(storage.values.get(keys.queue)!).entries).toEqual([{ requestId: 'q2', event: retained, retryCount: 1 }])
    tracker.onAppShow(entry)
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ eventType: 'VISIT', eventSequenceId: 91 })
  })

  it('重启和缓存重写不延长有效期，到期后只补发新事件', async () => {
    let now = 100
    let connected = false
    let notify: (state: NetworkState) => void = () => undefined
    const storage = new RuntimeStorage()
    const sent: unknown[] = []
    const create = () => runtimeFixture({
      storage, clock: { now: () => now },
      network: {
        isConnected: () => connected, current: async () => connected ? 'WIFI' : 'UNKNOWN',
        subscribe: listener => { notify = listener; return () => undefined },
      },
      upload: {
        transport: { dispatch: (request, done) => { sent.push(...JSON.parse(request.body)); done({ kind: 'success', status: 204 }) } },
        runtime: { now: () => now, random: () => 0.5, setTimeout: () => 1, clearTimeout: () => undefined },
      },
    }).tracker
    const first = create()
    first.init(config); first.onAppLaunch(entry); first.onAppShow(entry); await first.whenReady()
    first.track('cached')
    const original = first.queuedEvents()
    await settleStorage()

    now += APP_QUEUE_RETENTION_MS - 1
    const second = create()
    second.init(config)
    await second.whenReady()
    expect(second.queuedEvents()).toEqual(original)
    second.onAppLaunch(entry); second.onAppShow(entry)
    second.track('fresh_before_expiry')
    await settleStorage()
    expect(JSON.parse(storage.values.get(keys.queue)!).entries).toHaveLength(4)

    now++
    connected = true
    notify('WIFI')
    expect(sent).toMatchObject([{ eventType: 'VISIT', timestamp: now - 1 }, { eventName: 'fresh_before_expiry', timestamp: now - 1 }])
    expect(sent).toHaveLength(2)
    expect(second.queuedEvents()).toEqual([])
    await settleStorage()
    expect(JSON.parse(storage.values.get(keys.queue)!).entries).toEqual([])
  })

  it('离线满队列到期后，新的事件仍可接纳并保存', async () => {
    const { tracker, storage, setNow } = runtimeFixture()
    tracker.init(config); tracker.onAppShow(entry); await tracker.whenReady()
    for (let index = 0; index < 199; index++) expect(tracker.track('cached', { index })).toBe(true)
    expect(tracker.track('overflow')).toBe(false)
    setNow(100 + APP_QUEUE_RETENTION_MS)
    expect(tracker.track('fresh')).toBe(true)
    expect(tracker.queuedEvents()).toMatchObject([{ eventName: 'fresh', eventSequenceId: 201 }])
    expect(tracker.queuedEvents()).toHaveLength(1)
    await settleStorage()
    expect(JSON.parse(storage.values.get(keys.queue)!).entries).toHaveLength(1)
  })
})

describe('小程序内存队列', () => {
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('继续使用当前运行期的内存队列，不应用 App 的过期策略', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000)
    const f = miniHost('mp-weixin')
    f.host.getNetworkType = options => { options.success({ networkType: 'none' }) }
    f.init({ uploadInterval: 0 }); await f.tracker.whenReady(); f.show()
    f.tracker.track('cached')
    const cached = f.tracker.queuedEvents()
    vi.setSystemTime(Date.now() + APP_QUEUE_RETENTION_MS)
    f.tracker.track('fresh')
    expect(f.tracker.queuedEvents().slice(0, cached.length)).toEqual(cached)
    expect(f.tracker.queuedEvents().at(-1)).toMatchObject({ eventName: 'fresh' })
    expect(f.host.request).not.toHaveBeenCalled()
    await settleStorage()
    expect([...f.values.keys()].every(key => !key.includes(':queue'))).toBe(true)
  })
})
