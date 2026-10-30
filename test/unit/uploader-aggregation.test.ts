import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Uploader } from '../../src/core/uploader.js'
import { EventQueue } from '../../src/core/queue.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import type { TransportResult } from '../../src/types/index.js'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

function fixture(interval = 1000) {
  const queue = new EventQueue(), sent: ProtocolEvent[][] = [], callbacks: Array<(result: TransportResult) => void> = []
  let online = true
  const uploader = new Uploader(queue, { dispatch: (request, done) => { sent.push(JSON.parse(request.body)); callbacks.push(done) } },
    { now: Date.now, random: () => 0, setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    'https://collector.example', 'account', undefined, undefined, undefined, () => online, interval)
  const add = (sequence: number) => { queue.enqueue({ eventType: 'CUSTOM', eventName: `event_${sequence}`, eventSequenceId: sequence } as ProtocolEvent); uploader.schedule() }
  const ack = (index: number) => callbacks[index]!({ kind: 'success', status: 204 })
  return { queue, uploader, sent, callbacks, add, ack, connect: (value: boolean) => { online = value } }
}

describe('optional upload aggregation', () => {
  it('uses one timer for a burst and does not postpone its original deadline', async () => {
    const f = fixture(); f.add(1)
    await vi.advanceTimersByTimeAsync(999)
    f.add(2); f.add(3)
    expect(f.sent).toEqual([]); expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.sent[0]!.map(event => event.eventName)).toEqual(['event_1', 'event_2', 'event_3'])
    f.ack(0); expect(f.queue.size()).toBe(0); expect(vi.getTimerCount()).toBe(0)
  })

  it('force flush cancels aggregation and an empty queue does not schedule or resend', async () => {
    const f = fixture(); f.add(1)
    const drained = f.uploader.forceFlush()
    expect(f.sent).toHaveLength(1); f.ack(0); expect(await drained).toBe(true)
    f.uploader.schedule(); await vi.advanceTimersByTimeAsync(2000)
    expect(f.sent).toHaveLength(1); expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps new arrivals in their own interval while older requests finish and caps concurrency', async () => {
    const f = fixture()
    for (let sequence = 1; sequence <= 151; sequence++) f.add(sequence)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sent).toHaveLength(3); expect(f.uploader.activeCount()).toBe(3)
    f.add(152); f.ack(0)
    expect(f.sent).toHaveLength(4) // The fourth batch was already eligible.
    f.ack(1); f.ack(2); f.ack(3)
    expect(f.sent).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sent.at(-1)!.map(event => event.eventName)).toEqual(['event_152'])
    f.ack(4); expect(f.queue.size()).toBe(0)
  })

  it('retains offline events without polling and sends immediately when explicitly flushed on reconnect', async () => {
    const f = fixture(); f.connect(false); f.add(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sent).toEqual([]); expect(f.queue.size()).toBe(1); expect(vi.getTimerCount()).toBe(0)
    f.connect(true); f.uploader.flush()
    expect(f.sent).toHaveLength(1); f.ack(0); expect(f.queue.size()).toBe(0)
  })

  it('keeps retry delays independent of the next aggregation window', async () => {
    const f = fixture(2000); f.add(1)
    await vi.advanceTimersByTimeAsync(2000)
    f.callbacks[0]!({ kind: 'network' }); f.add(2)
    await vi.advanceTimersByTimeAsync(800)
    expect(f.sent.map(batch => batch.map(event => event.eventName))).toEqual([['event_1'], ['event_1']])
    f.ack(1); await vi.advanceTimersByTimeAsync(1200)
    expect(f.sent.at(-1)!.map(event => event.eventName)).toEqual(['event_2'])
    f.ack(2); expect(f.queue.size()).toBe(0)
  })
})
