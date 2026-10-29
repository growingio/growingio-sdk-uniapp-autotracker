import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { TrackerRuntime } from '../src/core/growingIO.js'
import type { AppSystemContext, NetworkState, StoragePort, TransportResult } from '../src/types/index.js'

const system: AppSystemContext = {
  platform: 'Android', platformVersion: '14', domain: 'example.stress', appState: 'FOREGROUND',
  appName: 'Stress', networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920,
  deviceBrand: 'UNKNOWN', deviceModel: 'UNKNOWN', deviceType: 'PHONE', appVersion: '1.0', language: 'zh-CN', sdkVersion: '0.1.0',
}

/** 装配真实 SDK，宿主仅替换时间、存储、网络和传输；不使用真实设备或生产采集服务。 */
async function setup(initiallyConnected: boolean, synchronous: boolean) {
  const values = new Map<string, string>()
  let storageWrites = 0
  const storage: StoragePort = {
    persistentQueue: true,
    read: async (_area, key) => values.has(key) ? { kind: 'value', value: values.get(key)! } : { kind: 'missing' },
    write: async (_area, key, value) => { storageWrites++; values.set(key, value); return { kind: 'ok' } },
    remove: async (_area, key) => { values.delete(key); return { kind: 'ok' } },
  }
  let connected = initiallyConnected
  let networkChanged: (state: NetworkState) => void = () => undefined
  let active = 0
  let maxActive = 0
  let requests = 0
  let received = 0
  let lastSequence = 0
  let session = 0
  let timerId = 0
  const timers = new Map<number, () => void>()
  const pending: Array<(result: TransportResult) => void> = []
  const tracker = new TrackerRuntime({
    storage, systemContext: { load: async () => system }, clock: { now: () => 100 }, timezone: { getOffsetMinutes: () => -480 },
    deviceIdFactory: () => 'stress-device', sessionIdFactory: () => `stress-session-${++session}`, orientation: () => 'PORTRAIT',
    network: { isConnected: () => connected, current: async () => connected ? 'WIFI' : 'UNKNOWN', subscribe: listener => { networkChanged = listener; return () => undefined } },
    upload: {
      runtime: {
        now: () => 100, random: () => 0.5,
        setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id },
        clearTimeout: handle => { timers.delete(handle as number) },
      },
      transport: { dispatch: (request, done) => {
        assert.equal(connected, true)
        requests++
        active++
        maxActive = Math.max(maxActive, active)
        assert.ok(active <= 3)
        const events = JSON.parse(request.body) as Array<{ eventSequenceId?: number }>
        assert.ok(events.length <= 50)
        assert.ok(Buffer.byteLength(request.body) <= 512 * 1024)
        for (const event of events) {
          received++
          if (event.eventSequenceId !== undefined) assert.equal(event.eventSequenceId, ++lastSequence)
        }
        let completed = false
        const finish = (result: TransportResult) => {
          if (!completed) { completed = true; active-- }
          done(result)
        }
        if (synchronous) finish({ kind: 'success', status: 204 })
        else pending.push(finish)
        return { abort: () => finish({ kind: 'aborted' }) }
      } },
    },
  })
  assert.equal(tracker.init({ accountId: 'stress-account', dataSourceId: 'stress-source' }), true)
  assert.equal(await tracker.whenReady(), true)
  tracker.onAppLaunch({ path: 'pages/stress', query: '' })
  tracker.onAppShow({ path: 'pages/stress', query: '' })
  tracker.onPageLoad({ instanceId: 'stress-page', route: 'pages/stress', query: '', referralPage: null })
  tracker.onPageShow('stress-page', 'Stress')
  return {
    tracker, pending, timers,
    reconnect: () => { connected = true; networkChanged('WIFI') },
    stats: () => ({ requests, received, maxActive, active, lastSequence, storageWrites }),
    persisted: () => {
      const queue = values.get('gio:v1:stress-source:queue:v1')
      const meta = values.get('gio:v1:stress-source:meta')
      assert.notEqual(queue, undefined, 'queue_was_not_persisted')
      assert.notEqual(meta, undefined, 'sequence_was_not_persisted')
      return {
        entries: (JSON.parse(queue!) as { entries: unknown[] }).entries.length,
        sequence: (JSON.parse(meta!) as { value: { eventSequenceId: number } }).value.eventSequenceId,
      }
    },
  }
}

/** 检查大流量接纳、离线积压、重连排空、并发和迟到回调；耗时仅做基线，不作硬件相关断言。 */
export async function runRuntimeStress(onlineEvents = 10_000, offlineAttempts = 20_000) {
  const online = await setup(true, true)
  let start = performance.now()
  for (let event = 0; event < onlineEvents; event++) assert.equal(online.tracker.track('stress_event', { index: event, text: '中😀' }), true)
  const onlineMs = performance.now() - start
  assert.equal(online.stats().received, onlineEvents + 2)
  assert.equal(online.tracker.queuedEvents().length, 0)
  assert.equal(online.timers.size, 0)
  let reads = 0
  online.tracker.setDataCollect(false)
  assert.equal(online.tracker.track('private_event', { get value() { reads++; return 'private' } }), false)
  assert.equal(reads, 0)
  online.tracker.setDataCollect(true)
  online.tracker.onAppHide()
  assert.equal(online.stats().received, onlineEvents + 5)
  assert.equal(online.timers.size, 0)

  const offline = await setup(false, false)
  let accepted = 0
  start = performance.now()
  for (let event = 0; event < offlineAttempts; event++) if (offline.tracker.track('stress_event', { index: event })) accepted++
  const offlineMs = performance.now() - start
  assert.equal(accepted, offlineAttempts)
  assert.equal(offline.tracker.queuedEvents().length, offlineAttempts + 2)
  assert.equal(offline.stats().requests, 0)
  offline.reconnect()
  assert.equal(offline.stats().active, 3)
  while (offline.pending.length > 0) {
    const complete = offline.pending.shift()!
    complete({ kind: 'success', status: 204 })
    // 宿主重复回调不能触发重试、占用槽位或再次结算。
    complete({ kind: 'network' })
  }
  assert.equal(offline.stats().received, offlineAttempts + 2)
  assert.equal(offline.stats().lastSequence, offlineAttempts + 2)
  assert.equal(offline.stats().active, 0)
  assert.equal(offline.tracker.queuedEvents().length, 0)
  assert.equal(offline.timers.size, 0)
  // 等待有界写入槽位结算，检查最终落盘而非只检查内存。
  for (let step = 0; step < 12; step++) await Promise.resolve()
  assert.deepEqual(online.persisted(), { entries: 0, sequence: onlineEvents + 4 })
  assert.deepEqual(offline.persisted(), { entries: 0, sequence: offlineAttempts + 2 })
  return {
    online: { events: onlineEvents, elapsedMs: onlineMs, ...online.stats() },
    offline: { attempts: offlineAttempts, accepted, rejected: offlineAttempts - accepted, elapsedMs: offlineMs, ...offline.stats() },
  }
}
