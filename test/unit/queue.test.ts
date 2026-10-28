import { describe, expect, it } from 'vitest'

import { APP_QUEUE_RETENTION_MS, EventQueue } from '../../src/core/queue.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'

/** 构造字段齐全且序号可控的协议事件，供容量和批次边界验证。 */
function event(number: number, value = ''): ProtocolEvent {
  return { eventType: 'CUSTOM', eventSequenceId: number, eventName: `event_${number}`, value } as ProtocolEvent
}

describe('EventQueue', () => {
  it('App 事件满 7 天到期，较新的事件及回拨时钟下的事件仍保留', () => {
    let now = 100
    const queue = new EventQueue(undefined, undefined, { maxAgeMs: APP_QUEUE_RETENTION_MS, now: () => now })
    queue.enqueue({ ...event(1), timestamp: 100 })
    queue.enqueue({ ...event(2), timestamp: 101 })
    queue.claimNextBatch()
    now = 99
    expect(queue.pruneExpired()).toEqual([])
    now = 100 + APP_QUEUE_RETENTION_MS - 1
    expect(queue.pruneExpired()).toEqual([])
    now++
    expect(queue.pruneExpired()).toEqual(['q1'])
    expect(queue.has('q1')).toBe(false)
    expect(queue.snapshot().map(entry => entry.event.eventSequenceId)).toEqual([2])
    now++
    expect(queue.pruneExpired()).toEqual(['q2'])
    expect(queue.size()).toBe(0)
  })

  it.each(['count', 'bytes'])('入队前释放到期事件占用的 %s 容量', mode => {
    let now = 1_700_000_000_000
    const first = { ...event(1), timestamp: now }
    const capacity = Buffer.byteLength(JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER,
      entries: [{ requestId: 'q1', event: first, retryCount: 0 }] }))
    const queue = new EventQueue({ maxItems: mode === 'count' ? 1 : 10, maxPersistedBytes: mode === 'bytes' ? capacity : 5000,
      maxEventBytes: 1000, maxBatchEvents: 50, maxBatchBytes: 1000 }, undefined,
    { maxAgeMs: APP_QUEUE_RETENTION_MS, now: () => now })
    expect(queue.enqueue(first).ok).toBe(true)
    expect(queue.enqueue({ ...first, eventName: 'event_2' })).toEqual({ ok: false, code: 'queue_full' })
    now += APP_QUEUE_RETENTION_MS
    expect(queue.enqueue({ ...first, eventName: 'event_2', timestamp: now }).ok).toBe(true)
    expect(queue.snapshot().map(entry => entry.event.eventName)).toEqual(['event_2'])
  })

  it('未装配 App 保留策略的队列不按时间清理', () => {
    const queue = new EventQueue()
    queue.enqueue({ ...event(1), timestamp: 0 })
    expect(queue.pruneExpired()).toEqual([])
    expect(queue.size()).toBe(1)
  })

  it.each([NaN, Infinity, -1, 'throw'])('时钟不可用（%s）时保留缓存', invalid => {
    let now: number | string = 100
    const queue = new EventQueue(undefined, undefined, { maxAgeMs: APP_QUEUE_RETENTION_MS, now: () => {
      if (typeof now === 'string') throw new Error('clock_unavailable')
      return now
    } })
    queue.enqueue({ ...event(1), timestamp: now })
    now = invalid
    expect(queue.pruneExpired()).toEqual([])
    expect(queue.size()).toBe(1)
  })

  it('批次与快照内容被外部改写后，内部队列及字节预算仍保持原值', () => {
    const queue = new EventQueue()
    const original: ProtocolEvent = { eventType: 'CUSTOM', eventName: 'immutable', eventSequenceId: 1, attributes: { value: 'original' } }
    queue.enqueue(original)
    const batch = queue.claimNextBatch()
    ;(batch[0]!.event.attributes as Record<string, string>).value = 'changed'.repeat(1000)
    ;(queue.snapshot()[0]!.event.attributes as Record<string, string>).value = 'snapshot'
    queue.release(['q1'])
    expect(queue.snapshot()[0]?.event).toEqual(original)
    expect(queue.nextBatch()[0]?.event).toEqual(original)
  })

  it('容量包含持久化修订号字段，Unicode 事件不会在落盘时超过字节限制', () => {
    const original: ProtocolEvent = { eventType: 'CUSTOM', eventName: 'bounded', eventSequenceId: 1, attributes: { value: '中😀' } }
    const entry = { requestId: 'q1', event: original, retryCount: 0 }
    const capacity = Buffer.byteLength(JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER, entries: [entry] }))
    const limits = { maxItems: 10, maxPersistedBytes: capacity, maxEventBytes: 500, maxBatchEvents: 10, maxBatchBytes: 500 }
    const queue = new EventQueue(limits)
    expect(queue.enqueue(original).ok).toBe(true)
    expect(Buffer.byteLength(JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER, entries: queue.snapshot() }))).toBe(capacity)
    expect(new EventQueue({ ...limits, maxPersistedBytes: capacity - 1 }).enqueue(original)).toEqual({ ok: false, code: 'queue_full' })
    queue.remove(['q1'])
    expect(queue.enqueue(original).ok).toBe(true)
  })

  it('固定种子的 5000 次交错操作保持容量、批次、恢复与快照一致性', () => {
    const limits = { maxItems: 20, maxPersistedBytes: 5000, maxEventBytes: 1000, maxBatchEvents: 7, maxBatchBytes: 900 }
    const queue = new EventQueue(limits)
    let seed = 0x12345678
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    for (let step = 1; step <= 5000; step++) {
      const ids = queue.snapshot().map(entry => entry.requestId)
      switch (random() % 6) {
        case 0: case 1:
          queue.enqueue({ eventType: 'CUSTOM', eventName: `event_${step}`, eventSequenceId: step, attributes: { value: '中😀'.repeat(random() % 30) } })
          break
        case 2: queue.incrementRetries(ids.slice(0, random() % 10)); break
        case 3: queue.remove(ids.filter(() => random() % 3 === 0)); break
        case 4: {
          const batch = queue.claimNextBatch()
          expect(batch.length).toBeLessThanOrEqual(limits.maxBatchEvents)
          expect(Buffer.byteLength(JSON.stringify(batch.map(entry => entry.event)))).toBeLessThanOrEqual(limits.maxBatchBytes)
          expect(new Set(batch.map(entry => entry.retryCount)).size).toBeLessThanOrEqual(1)
          queue.release(batch.map(entry => entry.requestId))
          break
        }
        case 5: expect(queue.restore(queue.snapshot())).toBe(true); break
      }
      const snapshot = queue.snapshot()
      expect(snapshot.length).toBeLessThanOrEqual(limits.maxItems)
      expect(new Set(snapshot.map(entry => entry.requestId)).size).toBe(snapshot.length)
      expect(Buffer.byteLength(JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER, entries: snapshot }))).toBeLessThanOrEqual(limits.maxPersistedBytes)
    }
  })

  it.each([false, true])('allocates distinct recoverable request ids after restoring the largest safe request number (occupied low id: %s)', (occupied) => {
    const queue = new EventQueue()
    const first: ProtocolEvent = { eventType: 'CUSTOM', eventName: 'restored', eventSequenceId: 1 }
    const restored = [
      ...(occupied ? [{ requestId: 'q1', event: { ...first, eventName: 'occupied' }, retryCount: 0 }] : []),
      { requestId: `q${Number.MAX_SAFE_INTEGER}`, event: first, retryCount: 0 },
    ]
    expect(queue.restore(restored)).toBe(true)
    expect(queue.enqueue({ ...first, eventName: 'next' }).ok).toBe(true)
    expect(queue.enqueue({ ...first, eventName: 'last' }).ok).toBe(true)
    const entries = queue.snapshot()
    expect(new Set(entries.map(entry => entry.requestId)).size).toBe(restored.length + 2)
    expect(new EventQueue().restore(entries)).toBe(true)
    queue.remove([entries[restored.length]!.requestId])
    expect(queue.snapshot().map(entry => entry.event.eventName)).toEqual([...restored.map(entry => entry.event.eventName), 'last'])
  })

  it.each(['é', '中文', '😀'])('包含 %s 的事件按 UTF-8 字节和数组边界分批', (value) => {
    const first = event(1, value)
    const bytes = Buffer.byteLength(JSON.stringify(first), 'utf8')
    const limits = { maxItems: 5, maxPersistedBytes: 2000, maxEventBytes: bytes, maxBatchEvents: 5, maxBatchBytes: bytes + 2 }
    const queue = new EventQueue(limits)
    expect(queue.enqueue(first)).toMatchObject({ ok: true })
    expect(queue.enqueue(event(2, value))).toMatchObject({ ok: true })
    expect(queue.claimNextBatch().map(entry => entry.event)).toEqual([first])
    expect(queue.claimNextBatch().map(entry => entry.event)).toEqual([event(2, value)])
    expect(queue.claimNextBatch()).toEqual([])
    queue.release(['q1'])
    expect(queue.claimNextBatch().map(entry => entry.requestId)).toEqual(['q1'])
    expect(new EventQueue({ ...limits, maxEventBytes: bytes - 1 }).enqueue(first)).toEqual({ ok: false, code: 'event_too_large' })
  })

  it.each([undefined, null, [], 1])('拒绝非对象事件 %s，保留已入队事件', (value) => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    expect(queue.enqueue(value as unknown as ProtocolEvent)).toEqual({ ok: false, code: 'event_not_serializable' })
    expect(queue.snapshot().map(entry => entry.event)).toEqual([event(1)])
  })
  it('keeps JSON-only event snapshots in FIFO order and supports retry metadata', () => {
    const queue = new EventQueue()
    expect(queue.enqueue(event(1))).toStrictEqual({ ok: true, requestId: 'q1' })
    expect(queue.enqueue(event(2))).toStrictEqual({ ok: true, requestId: 'q2' })
    expect(queue.nextBatch().map((entry) => entry.requestId)).toStrictEqual(['q1', 'q2'])

    queue.incrementRetries(['q1'])
    expect(queue.snapshot()[0]).toMatchObject({ requestId: 'q1', retryCount: 1 })
    queue.remove(['q1'])
    expect(queue.snapshot().map((entry) => entry.requestId)).toStrictEqual(['q2'])
  })

  it('drops bad JSON and events that cannot occupy even a one-event HTTP batch', () => {
    const queue = new EventQueue({ maxItems: 2, maxPersistedBytes: 1_000, maxEventBytes: 30, maxBatchEvents: 2, maxBatchBytes: 30 })
    const cyclic: Record<string, unknown> = { eventType: 'CUSTOM' }
    cyclic.self = cyclic
    expect(queue.enqueue(cyclic as ProtocolEvent)).toStrictEqual({ ok: false, code: 'event_not_serializable' })
    expect(queue.enqueue(event(1, 'x'.repeat(100)))).toStrictEqual({ ok: false, code: 'event_too_large' })
  })

  it('preserves existing items when count or persistent-envelope capacity is exhausted', () => {
    const byCount = new EventQueue({ maxItems: 1, maxPersistedBytes: 1_000, maxEventBytes: 500, maxBatchEvents: 50, maxBatchBytes: 500 })
    expect(byCount.enqueue(event(1))).toMatchObject({ ok: true })
    expect(byCount.enqueue(event(2))).toStrictEqual({ ok: false, code: 'queue_full' })
    expect(byCount.snapshot()).toHaveLength(1)

    const byBytes = new EventQueue({ maxItems: 5, maxPersistedBytes: 100, maxEventBytes: 500, maxBatchEvents: 50, maxBatchBytes: 500 })
    expect(byBytes.enqueue(event(1, 'x'.repeat(200)))).toStrictEqual({ ok: false, code: 'queue_full' })
    expect(byBytes.snapshot()).toStrictEqual([])
  })

  it('forms batches by the actual JSON-array byte limit, not event count alone', () => {
    const queue = new EventQueue({ maxItems: 5, maxPersistedBytes: 2_000, maxEventBytes: 500, maxBatchEvents: 5, maxBatchBytes: 120 })
    queue.enqueue(event(1, 'x'.repeat(20)))
    queue.enqueue(event(2, 'x'.repeat(20)))
    queue.enqueue(event(3, 'x'.repeat(20)))
    expect(queue.nextBatch().map((entry) => entry.event.eventSequenceId)).toStrictEqual([1])
  })
})
