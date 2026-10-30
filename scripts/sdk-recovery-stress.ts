import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { TrackerRuntime } from '../src/core/growingIO.js'
import type { ProtocolEvent } from '../src/core/dataStore/protocol.js'
import { readIdentityRecord } from '../src/core/userStore.js'
import { storageKeys } from '../src/core/storage/index.js'
import type { AppSystemContext, NetworkState, StoragePort, TransportResult } from '../src/types/index.js'

const system: AppSystemContext = {
  platform: 'Android', platformVersion: '14', domain: 'example.recovery', appState: 'FOREGROUND',
  appName: 'Recovery', networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920,
  deviceBrand: 'UNKNOWN', deviceModel: 'UNKNOWN', deviceType: 'PHONE', appVersion: '1.0', language: 'zh-CN', sdkVersion: '0.1.0',
}

/** 重复真实运行时冷启动，核对模拟存储、身份/会话、序号、上传与资源；不接触生产存储或服务。 */
export async function runRecoveryStress(rounds = 75, eventsPerRound = 150) {
  assert.ok(Number.isInteger(rounds) && rounds > 0)
  assert.ok(Number.isInteger(eventsPerRound) && eventsPerRound > 0 && eventsPerRound <= 190)
  const startedAt = performance.now()
  const values = new Map<string, string>()
  const keys = storageKeys('recovery-source')
  const expected = new Map<number, ProtocolEvent>()
  const delivered = new Set<number>()
  let now = 1_750_000_000_000
  let sessions = 0
  let deviceIds = 0
  let storageWrites = 0
  let attemptedSealedWrites = 0
  let requests = 0
  let active = 0
  let maxActive = 0
  let lastSequence = 0
  let recoveredEvents = 0
  let acceptedCustom = 0

  /** 每个进程独占宿主回调和计时器，封存后不得再触及下一进程的存储。 */
  async function createProcess() {
    let sealed = false
    let connected = false
    let pendingWrites = 0
    let writeEpoch = 0
    let timerId = 0
    let notifyNetwork: (state: NetworkState) => void = () => undefined
    const timers = new Map<number, { callback: () => void; delayMs: number }>()
    const completions: Array<(result: TransportResult) => void> = []
    const storage: StoragePort = {
      persistentQueue: true,
      read: async (_area, key) => values.has(key) ? { kind: 'value', value: values.get(key)! } : { kind: 'missing' },
      write: async (_area, key, value) => {
        if (sealed) attemptedSealedWrites++
        assert.equal(sealed, false, 'retired_process_started_storage_write')
        pendingWrites++
        writeEpoch++
        storageWrites++
        // 让各键异步结束，并令后续快照确实进入有界的待写槽位。
        for (let delay = 0; delay <= storageWrites % 3; delay++) await Promise.resolve()
        assert.equal(sealed, false, 'retired_process_completed_storage_write')
        values.set(key, value)
        pendingWrites--
        return { kind: 'ok' }
      },
      remove: async (_area, key) => {
        assert.equal(sealed, false)
        values.delete(key)
        return { kind: 'ok' }
      },
    }
    const tracker = new TrackerRuntime({
      storage, systemContext: { load: async () => system }, clock: { now: () => now }, timezone: { getOffsetMinutes: () => -480 },
      deviceIdFactory: () => `recovery-device-${++deviceIds}`, sessionIdFactory: () => `recovery-session-${++sessions}`, orientation: () => 'PORTRAIT',
      network: {
        isConnected: () => connected, current: async () => connected ? 'WIFI' : 'UNKNOWN',
        subscribe: listener => { notifyNetwork = listener; return () => { notifyNetwork = () => undefined } },
      },
      upload: {
        runtime: {
          now: () => now, random: () => 0.5,
          setTimeout: (callback, delayMs) => { const id = ++timerId; timers.set(id, { callback, delayMs }); return id },
          clearTimeout: handle => { timers.delete(handle as number) },
        },
        transport: { dispatch: (request, done) => {
          assert.equal(sealed, false)
          assert.equal(connected, true)
          requests++
          active++
          maxActive = Math.max(maxActive, active)
          assert.ok(active <= 3, 'upload_concurrency_exceeded')
          const events = JSON.parse(request.body) as ProtocolEvent[]
          assert.ok(events.length > 0 && events.length <= 50)
          assert.ok(Buffer.byteLength(request.body) <= 512 * 1024)
          let completed = false
          const finish = (result: TransportResult) => {
            if (!completed) {
              completed = true
              active--
              if (result.kind === 'success') for (const event of events) {
                const sequence = event.eventSequenceId as number
                assert.equal(delivered.has(sequence), false, 'duplicate_delivered_sequence')
                assert.deepEqual(event, expected.get(sequence), 'recovered_event_payload_changed')
                delivered.add(sequence)
              }
            }
            done(result)
          }
          completions.push(finish)
          return { abort: () => finish({ kind: 'aborted' }) }
        } },
      },
    })
    assert.equal(tracker.init({ accountId: 'recovery-account', dataSourceId: 'recovery-source', idMapping: true }), true)
    assert.equal(await tracker.whenReady(), true)

    /** 等待模拟宿主存储中的队列与各写入槽位稳定，之后才允许模拟进程退出。 */
    async function settleStorage() {
      let stable = 0
      let observedEpoch = writeEpoch
      for (let step = 0; step < 200 && stable < 8; step++) {
        await Promise.resolve()
        stable = pendingWrites === 0 && observedEpoch === writeEpoch ? stable + 1 : 0
        observedEpoch = writeEpoch
      }
      assert.equal(stable, 8, 'storage_writes_did_not_settle')
      assert.equal(pendingWrites, 0)
      const queue = JSON.parse(values.get(keys.queue)!) as { entries: Array<{ event: ProtocolEvent }> }
      assert.deepEqual(queue.entries.map(entry => entry.event), tracker.queuedEvents(), 'memory_and_durable_queue_differ')
      const meta = JSON.parse(values.get(keys.meta)!) as { value: { eventSequenceId: number } }
      assert.equal(meta.value.eventSequenceId, lastSequence, 'durable_sequence_is_stale')
      assert.equal(attemptedSealedWrites, 0)
    }
    return {
      tracker, timers, completions, settleStorage,
      reconnect: () => { connected = true; notifyNetwork('WIFI') },
      seal: () => {
        assert.equal(pendingWrites, 0)
        // 离线前台仅允许一个网络恢复检查；模拟进程退出时由宿主一起销毁。
        const pending = [...timers.values()]
        if (!connected && tracker.queuedEvents().length > 0) {
          assert.equal(pending.length, 1)
          assert.equal(pending[0]!.delayMs, 2_000)
        } else assert.equal(pending.length, 0)
        timers.clear()
        sealed = true
        notifyNetwork = () => undefined
      },
    }
  }

  /** 只登记本次新事件，跨进程恢复的旧事件必须保持同一载荷和序号。 */
  function remember(events: readonly ProtocolEvent[]) {
    for (const event of events) {
      const sequence = event.eventSequenceId as number
      if (expected.has(sequence)) { assert.deepEqual(event, expected.get(sequence)); continue }
      assert.equal(sequence, ++lastSequence, 'sequence_reused_or_skipped_after_restart')
      assert.equal(event.deviceId, 'recovery-device-1')
      expected.set(sequence, event)
    }
  }

  for (let round = 0; round < rounds; round++) {
    now += 1000
    const original = await createProcess()
    assert.deepEqual(original.tracker.queuedEvents(), [])
    const entry = { path: 'pages/recovery', query: `round=${round}` }
    assert.equal(original.tracker.onAppLaunch(entry), true)
    assert.equal(original.tracker.onAppShow(entry), true)
    assert.equal(original.tracker.setUserId(`user-${round}`, 'account-key'), true)
    assert.equal(original.tracker.onPageLoad({ instanceId: `page-${round}`, route: entry.path, query: entry.query, referralPage: null }), true)
    assert.equal(original.tracker.onPageShow(`page-${round}`, 'Recovery'), true)
    for (let index = 0; index < eventsPerRound; index++) {
      assert.equal(original.tracker.track('recovery_event', { round, index, unicode: '中😀', array: ['a', 2, true] }), true)
      acceptedCustom++
    }
    const saved = original.tracker.queuedEvents()
    // 先对照原始业务调用核验，不能把 SDK 初次生成的错误载荷当作恢复基准。
    const custom = saved.filter(event => event.eventType === 'CUSTOM')
    assert.equal(custom.length, eventsPerRound, 'accepted_custom_count_mismatch')
    for (let index = 0; index < custom.length; index++) {
      const event = custom[index]!
      assert.equal(event.eventName, 'recovery_event', 'custom_event_name_changed')
      assert.equal(event.userId, `user-${round}`, 'custom_event_identity_changed')
      assert.equal(event.userKey, 'account-key', 'custom_event_identity_changed')
      assert.deepEqual(event.attributes, { round: String(round), index: String(index), unicode: '中😀', array: 'a||2||true' },
        'custom_event_payload_changed')
    }
    remember(saved)
    const lastSaved = saved[saved.length - 1]!
    await original.settleStorage()
    assert.equal(original.completions.length, 0)
    original.seal()

    now += 1000
    const restored = await createProcess()
    assert.deepEqual(restored.tracker.queuedEvents(), saved, 'cold_start_did_not_restore_full_queue')
    recoveredEvents += saved.length
    assert.equal(restored.tracker.onAppLaunch(entry), true)
    assert.equal(restored.tracker.onAppShow(entry), true)
    assert.equal(restored.tracker.track('recovered_marker', { round }), true)
    acceptedCustom++
    const pending = restored.tracker.queuedEvents()
    assert.equal(pending.length, saved.length + 2, 'cold_start_events_missing')
    const marker = pending[pending.length - 1]!
    assert.equal(marker.eventType, 'CUSTOM')
    assert.equal(marker.eventName, 'recovered_marker')
    assert.deepEqual(marker.attributes, { round: String(round) })
    assert.equal(marker.userId, lastSaved.userId)
    assert.equal(marker.userKey, lastSaved.userKey)
    assert.notEqual(marker.sessionId, lastSaved.sessionId, 'new_process_reused_old_session')
    remember(pending)
    await restored.settleStorage()
    const identity = readIdentityRecord(values.get(keys.identity)!, 'recovery-source')
    assert.ok(identity.kind !== 'corrupt')
    assert.equal(identity.identity.userId, `user-${round}`)
    const session = JSON.parse(values.get(keys.session)!) as { value: { sessionId: string } }
    assert.equal(session.value.sessionId, marker.sessionId)
    restored.reconnect()
    assert.equal(active, Math.min(3, Math.ceil(pending.length / 50)))
    for (let completions = 0; restored.completions.length > 0; completions++) {
      assert.ok(completions < 20, 'queue_did_not_drain')
      // 交替正序/逆序结算，随后模拟宿主迟到失败，不能重试已确认成功的事件。
      const finish = round % 2 === 0 ? restored.completions.shift()! : restored.completions.pop()!
      finish({ kind: 'success', status: 204 })
      finish({ kind: 'network' })
    }
    assert.deepEqual(restored.tracker.queuedEvents(), [])
    assert.equal(active, 0)
    assert.equal(restored.timers.size, 0)
    assert.equal(delivered.size, expected.size, 'accepted_event_lost_during_restart')
    await restored.settleStorage()
    restored.seal()
  }
  assert.equal(deviceIds, 1)
  assert.equal(attemptedSealedWrites, 0)
  assert.equal(acceptedCustom, rounds * (eventsPerRound + 1))
  assert.equal(recoveredEvents, rounds * (eventsPerRound + 3) - 1)
  assert.equal(delivered.size, rounds * (eventsPerRound + 5) - 1)
  return {
    rounds, eventsPerRound, acceptedCustom, recoveredEvents, received: delivered.size, requests, maxActive, active,
    storageWrites, sessions, lastSequence, pendingTimers: 0, elapsedMs: performance.now() - startedAt,
  }
}
