import { describe, expect, it } from 'vitest'
import { EventQueue } from '../../src/core/queue.js'
import { Uploader } from '../../src/core/uploader.js'
import type { TransportResult } from '../../src/types/index.js'

describe('上传器故障交错压测', () => {
  it.each([0x12345678, 0x5eed2026, 0xabcdef01])('种子 %i：5000 次提交、掉线、超时、迟到回调和强制刷新均保持有界并最终结算', async (initialSeed) => {
    let seed = initialSeed
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const queue = new EventQueue()
    let now = 100
    let connected = true
    let handle = 0
    let request = 0
    const timers = new Map<number, { at: number; callback: () => void }>()
    const active = new Map<number, (result: TransportResult) => void>()
    const accepted = new Map<string, number>()
    const delivered = new Set<number>()
    const dropped = new Set<number>()
    const flushed: Array<Promise<boolean>> = []
    let maxActive = 0
    let lateCallbacks = 0
    const faults = { network: 0, server: 0, client: 0, timeout: 0, dispatch: 0, disconnect: 0, forceFlush: 0 }
    const uploader = new Uploader(queue, { dispatch: (input, done) => {
      const id = ++request
      // 直接抛错的宿主不能留下并发槽位或永久占用队列。
      if (id % 17 === 0) { faults.dispatch++; throw new Error('host_dispatch_failure') }
      const events = JSON.parse(input.body) as Array<{ eventSequenceId: number }>
      let completed = false
      const finish = (result: TransportResult) => {
        if (!completed) {
          completed = true
          active.delete(id)
          if (result.kind === 'success') for (const event of events) {
            expect(delivered.has(event.eventSequenceId)).toBe(false)
            delivered.add(event.eventSequenceId)
          }
        } else lateCallbacks++
        done(result)
      }
      active.set(id, finish)
      maxActive = Math.max(maxActive, active.size)
      return { abort: () => { finish({ kind: 'aborted' }); finish({ kind: 'http', status: 503 }) } }
    } }, {
      now: () => now, random: () => (random() % 1000) / 1000,
      setTimeout: (callback, delay) => {
        const id = ++handle
        timers.set(id, { at: now + delay, callback: () => { if (delay === 5000) faults.timeout++; callback() } })
        return id
      },
      clearTimeout: id => { timers.delete(id as number) },
    }, 'https://collector.example', 'account', drop => {
      for (const id of drop.requestIds) {
        expect(accepted.has(id)).toBe(true)
        dropped.add(accepted.get(id)!)
      }
    }, undefined, undefined, () => connected)
    const advance = (amount: number) => {
      now += amount
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.callback()
    }
    for (let step = 1; step <= 5000; step++) {
      switch ((random() >>> 8) % 8) {
        case 0: case 1: case 2: {
          const result = queue.enqueue({ eventType: 'CUSTOM', eventName: 'soak_event', eventSequenceId: step })
          if (result.ok) accepted.set(result.requestId, step)
          uploader.schedule()
          break
        }
        case 3: {
          const complete = [...active.values()][random() % Math.max(1, active.size)]
          const result = (random() >>> 8) % 4
          if (complete !== undefined) {
            if (result === 0) faults.network++
            else if (result === 1) faults.server++
            else if (result === 2) faults.client++
          }
          complete?.(result === 0 ? { kind: 'network' } : result === 1 ? { kind: 'http', status: 503 }
            : result === 2 ? { kind: 'http', status: 400 } : { kind: 'success', status: 204 })
          complete?.({ kind: 'network' })
          break
        }
        case 4: advance(random() % 6000); break
        case 5: connected = !connected; if (connected) uploader.flush(); else faults.disconnect++; break
        case 6: uploader.flush(); break
        case 7: faults.forceFlush++; flushed.push(uploader.forceFlush(1000)); break
      }
      expect(queue.size()).toBeLessThanOrEqual(200)
      expect(uploader.activeCount()).toBeLessThanOrEqual(3)
      expect(uploader.activeCount()).toBe(active.size)
      // 每个在途/重试批次占用至少一条队列记录，另计显式刷新等待者。
      expect(timers.size).toBeLessThanOrEqual(queue.size() + flushed.length)
    }
    connected = true
    uploader.flush()
    for (let drain = 0; queue.size() > 0 || timers.size > 0; drain++) {
      expect(drain).toBeLessThan(1000)
      for (const complete of [...active.values()]) complete({ kind: 'success', status: 204 })
      advance(6000)
    }
    expect(maxActive).toBe(3)
    expect(lateCallbacks).toBeGreaterThan(0)
    for (const [kind, count] of Object.entries(faults)) expect(count, `${kind} must be exercised`).toBeGreaterThan(0)
    expect(new Set([...delivered, ...dropped]).size).toBe(accepted.size)
    expect([...delivered].every(sequence => !dropped.has(sequence))).toBe(true)
    expect(uploader.activeCount()).toBe(0)
    expect(active.size).toBe(0)
    expect(await uploader.forceFlush()).toBe(true)
    expect((await Promise.all(flushed)).every(result => typeof result === 'boolean')).toBe(true)
    expect(timers.size).toBe(0)
  })
})
