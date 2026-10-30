import { describe, expect, it, vi } from 'vitest'

import { APP_QUEUE_RETENTION_MS, EventQueue } from '../../src/core/queue.js'
import type { TransportPort, TransportResult } from '../../src/types/index.js'
import { Uploader, type UploaderRuntime } from '../../src/core/uploader.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'

/** 构造上传测试的合法协议事件。 */
function event(sequence: number): ProtocolEvent {
  return { eventType: 'CUSTOM', eventName: `event_${sequence}`, eventSequenceId: sequence } as ProtocolEvent
}

/** 提供可推进时间与确定随机值，验证并发、超时和退避调度。 */
function runtime(): { value: UploaderRuntime; fireDelay: (delay: number) => void; scheduledDelays: () => number[] } {
  const callbacks = new Map<number, { delay: number; callback: () => void }>()
  let nextHandle = 1
  return {
    value: {
      now: () => 123,
      random: () => 0.5,
      setTimeout: (callback, delay) => {
        const handle = nextHandle++
        callbacks.set(handle, { delay, callback })
        return handle
      },
      clearTimeout: (handle) => { callbacks.delete(handle as number) },
    },
    fireDelay: (delay) => {
      const matching = [...callbacks.entries()].filter(([, task]) => task.delay === delay)
      for (const [handle, task] of matching) {
        callbacks.delete(handle)
        task.callback()
      }
    },
    scheduledDelays: () => [...callbacks.values()].map((task) => task.delay),
  }
}

describe('Uploader', () => {
  it('重试批次等待重连跨过 7 天后，仅发送其中尚未到期的事件', () => {
    let now = 100
    let connected = true
    const queue = new EventQueue(undefined, undefined, { maxAgeMs: APP_QUEUE_RETENTION_MS, now: () => now })
    queue.enqueue({ ...event(1), timestamp: now })
    queue.enqueue({ ...event(2), timestamp: now + 1 })
    const clocks = runtime()
    const sent: ProtocolEvent[][] = []
    const callbacks: Array<(result: TransportResult) => void> = []
    const changed = vi.fn()
    const uploader = new Uploader(queue, { dispatch: (request, done) => {
      sent.push(JSON.parse(request.body)); callbacks.push(done)
    } }, { ...clocks.value, now: () => now }, 'https://collector.example', 'account', undefined, changed, undefined, () => connected)
    uploader.flush()
    callbacks[0]!({ kind: 'network' })
    connected = false
    clocks.fireDelay(800)
    now += APP_QUEUE_RETENTION_MS
    uploader.flush()
    expect(sent).toHaveLength(1)
    expect(queue.snapshot().map(entry => entry.event.eventSequenceId)).toEqual([2])
    expect(changed).toHaveBeenCalledTimes(2)
    connected = true
    uploader.flush()
    expect(sent[1]!.map(event => event.eventSequenceId)).toEqual([2])
    callbacks[1]!({ kind: 'success', status: 204 })
    expect(queue.size()).toBe(0)
    expect(clocks.scheduledDelays()).toEqual([])
  })

  it('整批重试到期后不再派发，并能完成 forceFlush 等待', async () => {
    let now = 100
    const queue = new EventQueue(undefined, undefined, { maxAgeMs: APP_QUEUE_RETENTION_MS, now: () => now })
    queue.enqueue({ ...event(1), timestamp: now })
    const clocks = runtime()
    const dispatch = vi.fn<TransportPort['dispatch']>((_request, done) => { done({ kind: 'network' }) })
    const uploader = new Uploader(queue, { dispatch }, { ...clocks.value, now: () => now }, 'https://collector.example', 'account')
    uploader.flush()
    const forced = uploader.forceFlush()
    now += APP_QUEUE_RETENTION_MS
    clocks.fireDelay(800)
    await expect(forced).resolves.toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(queue.size()).toBe(0)
    expect(clocks.scheduledDelays()).toEqual([])
  })

  it('离线重试整批过期后立即释放待发副本，forceFlush 无需等待重连', async () => {
    let now = 100
    let connected = true
    const queue = new EventQueue(undefined, undefined, { maxAgeMs: APP_QUEUE_RETENTION_MS, now: () => now })
    queue.enqueue({ ...event(1), timestamp: now })
    const clocks = runtime()
    const dispatch = vi.fn<TransportPort['dispatch']>((_request, done) => { done({ kind: 'network' }) })
    const uploader = new Uploader(queue, { dispatch }, { ...clocks.value, now: () => now },
      'https://collector.example', 'account', undefined, undefined, undefined, () => connected)
    uploader.flush()
    connected = false
    clocks.fireDelay(800)
    now += APP_QUEUE_RETENTION_MS
    await expect(uploader.forceFlush()).resolves.toBe(true)
    expect(queue.size()).toBe(0)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(clocks.scheduledDelays()).toEqual([])
  })

  it('日志观察者修改收到的事件后，重试仍发送入队时的原始内容', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const clocks = runtime()
    const sent: unknown[] = []
    const callbacks: Array<(result: TransportResult) => void> = []
    const uploader = new Uploader(queue, { dispatch: (request, done) => { sent.push(JSON.parse(request.body)); callbacks.push(done) } },
      clocks.value, 'https://collector.example', 'account', undefined, undefined,
      events => { (events[0] as Record<string, unknown>).eventName = 'changed_by_observer' })
    uploader.flush()
    callbacks[0]!({ kind: 'network' })
    clocks.fireDelay(800)
    expect(sent).toEqual([[event(1)], [event(1)]])
    expect(queue.snapshot()[0]?.event).toEqual(event(1))
    callbacks[1]!({ kind: 'success', status: 204 })
    expect(queue.size()).toBe(0)
  })

  it('离线重复调度只读取标识，不复制整个事件队列', () => {
    const queue = new EventQueue()
    for (let index = 1; index <= 200; index++) queue.enqueue(event(index))
    const snapshot = vi.spyOn(queue, 'snapshot')
    const uploader = new Uploader(queue, { dispatch: () => { throw new Error('offline') } }, runtime().value,
      'https://collector.example', 'account', undefined, undefined, undefined, () => false)
    for (let index = 0; index < 200; index++) uploader.schedule()
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('App 普通事件立即发送，不设置聚合等待定时器', () => {
    const queue = new EventQueue()
    const clocks = runtime()
    const sent: Array<readonly ProtocolEvent[]> = []
    const uploader = new Uploader(queue, { dispatch: (request, done) => {
      sent.push(JSON.parse(request.body) as ProtocolEvent[])
      done({ kind: 'success', status: 204 })
    } }, clocks.value, 'https://collector.example', 'account')
    queue.enqueue(event(1))
    uploader.schedule()
    expect(sent).toEqual([[event(1)]])
    expect(clocks.scheduledDelays()).toEqual([])
    queue.enqueue(event(2))
    uploader.schedule()
    expect(sent).toEqual([[event(1)], [event(2)]])
    expect(clocks.scheduledDelays()).toEqual([])
    expect(queue.snapshot()).toEqual([])
  })

  it('并发槽位满后等待，请求完成立即发送后续事件', () => {
    const queue = new EventQueue()
    const clocks = runtime()
    const callbacks: Array<(result: TransportResult) => void> = []
    const sent: Array<readonly ProtocolEvent[]> = []
    const uploader = new Uploader(queue, { dispatch: (request, done) => {
      sent.push(JSON.parse(request.body) as ProtocolEvent[])
      callbacks.push(done)
    } }, clocks.value, 'https://collector.example', 'account')
    for (let index = 1; index <= 4; index++) { queue.enqueue(event(index)); uploader.schedule() }
    expect(sent).toEqual([[event(1)], [event(2)], [event(3)]])
    callbacks[0]!({ kind: 'success', status: 204 })
    expect(sent).toEqual([[event(1)], [event(2)], [event(3)], [event(4)]])
    for (const callback of callbacks.slice(1)) callback({ kind: 'success', status: 204 })
    expect(queue.snapshot()).toEqual([])
    expect(clocks.scheduledDelays()).toEqual([])
  })

  it('100 条 App 普通事件均立即调度，不等待条数或时间阈值', () => {
    const queue = new EventQueue()
    const sent: Array<readonly ProtocolEvent[]> = []
    const uploader = new Uploader(queue, { dispatch: (request, done) => {
      sent.push(JSON.parse(request.body) as ProtocolEvent[])
      done({ kind: 'success', status: 204 })
    } }, runtime().value, 'https://collector.example', 'account')
    for (let index = 1; index <= 100; index++) { queue.enqueue(event(index)); uploader.schedule() }
    expect(sent.map(batch => batch.length)).toEqual(Array(100).fill(1))
    expect(sent.flat().map(value => value.eventSequenceId)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1))
  })

  it('后台强制发送等待正在上传的事件，后续重试按到期时间发送', async () => {
    const queue = new EventQueue()
    const clocks = runtime()
    const callbacks: Array<(result: TransportResult) => void> = []
    const uploader = new Uploader(queue, { dispatch: (_request, done) => { callbacks.push(done) } }, clocks.value, 'https://collector.example', 'account')
    queue.enqueue(event(1))
    uploader.schedule()
    const forced = uploader.forceFlush()
    expect(callbacks).toHaveLength(1)
    // 此时只应保留请求超时和后台刷新等待两个定时器。
    expect(clocks.scheduledDelays()).toEqual([5_000, 1_000])
    callbacks[0]!({ kind: 'network' })
    clocks.fireDelay(800)
    expect(callbacks).toHaveLength(2)
    callbacks[1]!({ kind: 'success', status: 204 })
    await expect(forced).resolves.toBe(true)
  })

  it('请求构建失败时释放队列并报告原因，不占用上传槽位', async () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const drops: unknown[] = []
    let sent = false
    const uploader = new Uploader(queue, { dispatch: () => { sent = true } }, { ...runtime().value, now: () => NaN }, 'https://collector.example', 'account', drop => drops.push(drop))
    expect(await uploader.forceFlush()).toBe(true)
    expect(sent).toBe(false)
    expect(uploader.activeCount()).toBe(0)
    expect(queue.snapshot()).toEqual([])
    expect(drops).toEqual([{ requestIds: ['q1'], reason: 'request_build_failed' }])
  })

  it('日志观察者抛错也必须发送原始事件并正常清空队列', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const sent: unknown[] = []
    const uploader = new Uploader(queue, { dispatch: (request, done) => { sent.push(JSON.parse(request.body)); done({ kind: 'success', status: 204 }) } },
      runtime().value, 'https://collector.example', 'account', undefined, undefined, () => { throw new Error('observer failed') })
    uploader.flush()
    expect(sent).toEqual([[event(1)]])
    expect(queue.snapshot()).toEqual([])
  })
  it('明确断网时保留事件，后台强制发送也不能消耗队列', async () => {
    let connected = false
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const callbacks: Array<(result: TransportResult) => void> = []
    const clocks = runtime()
    const uploader = new Uploader(queue, { dispatch: (_request, done) => { callbacks.push(done) } }, clocks.value, 'https://collector.example', 'account', undefined, undefined, undefined, () => connected)
    const forced = uploader.forceFlush()
    clocks.fireDelay(1_000)
    await expect(forced).resolves.toBe(false)
    expect(callbacks).toHaveLength(0)
    expect(queue.snapshot()[0]?.retryCount).toBe(0)
    connected = true
    uploader.flush()
    expect(callbacks).toHaveLength(1)
    callbacks[0]!({ kind: 'success', status: 204 })
    expect(queue.snapshot()).toEqual([])
  })

  it('到期重试遇到断网暂停，最后一次请求遇到断网失败也不丢弃', () => {
    let connected = true
    const queue = new EventQueue()
    queue.restore([{ requestId: 'q1', event: event(1), retryCount: 1 }])
    const callbacks: Array<(result: TransportResult) => void> = []
    const clocks = runtime()
    const drops: unknown[] = []
    const uploader = new Uploader(queue, { dispatch: (_request, done) => { callbacks.push(done) } }, clocks.value, 'https://collector.example', 'account', drop => drops.push(drop), undefined, undefined, () => connected)
    uploader.flush()
    callbacks[0]!({ kind: 'network' })
    expect(queue.snapshot()[0]?.retryCount).toBe(2)
    connected = false
    clocks.fireDelay(1_600)
    expect(callbacks).toHaveLength(1)
    connected = true
    uploader.flush()
    expect(callbacks).toHaveLength(2)
    connected = false
    callbacks[1]!({ kind: 'timeout' })
    expect(drops).toEqual([])
    expect(queue.snapshot()[0]?.retryCount).toBe(2)
    connected = true
    uploader.flush()
    callbacks[2]!({ kind: 'success', status: 204 })
    expect(queue.snapshot()).toEqual([])
  })

  it('恢复后按各自剩余额度发送，混合批次不会重置重试次数', () => {
    const queue = new EventQueue()
    expect(queue.restore([2, 0, 1].map((retryCount, i) => ({ requestId: `q${i + 1}`, event: event(i + 1), retryCount })))).toBe(true)
    const sent: number[] = []
    const callbacks: Array<(result: TransportResult) => void> = []
    const clocks = runtime()
    const uploader = new Uploader(queue, { dispatch: (request, done) => {
      sent.push(...JSON.parse(request.body).map((event: ProtocolEvent) => event.eventSequenceId as number))
      callbacks.push(done)
    } }, clocks.value, 'https://collector.example', 'account')
    uploader.flush()
    expect(sent).toEqual([1, 2, 3])
    callbacks[0]!({ kind: 'network' })
    callbacks[1]!({ kind: 'network' })
    callbacks[2]!({ kind: 'http', status: 503 })
    clocks.fireDelay(800)
    callbacks[3]!({ kind: 'network' })
    clocks.fireDelay(1_600)
    callbacks[4]!({ kind: 'network' })
    callbacks[5]!({ kind: 'network' })
    expect(sent.filter(sequence => sequence === 1)).toHaveLength(1)
    expect(sent.filter(sequence => sequence === 2)).toHaveLength(3)
    expect(sent.filter(sequence => sequence === 3)).toHaveLength(2)
    expect(queue.snapshot()).toEqual([])
    expect(clocks.scheduledDelays()).toEqual([])
  })

  it('超过重试额度的历史条目不再发送，后续有效条目仍正常上传', () => {
    const queue = new EventQueue()
    queue.restore([{ requestId: 'q1', event: event(1), retryCount: 3 }, { requestId: 'q2', event: event(2), retryCount: 0 }])
    const sent: unknown[] = []
    const uploader = new Uploader(queue, { dispatch: (request, done) => { sent.push(...JSON.parse(request.body)); done({ kind: 'success', status: 204 }) } }, runtime().value, 'https://collector.example', 'account')
    uploader.flush()
    expect(sent).toEqual([event(2)])
    expect(queue.snapshot()).toEqual([])
  })

  it('uses at most three concurrent slots and releases a fourth only after completion', () => {
    const queue = new EventQueue({ maxItems: 5, maxPersistedBytes: 5_000, maxEventBytes: 500, maxBatchEvents: 1, maxBatchBytes: 500 })
    for (let index = 1; index <= 4; index += 1) queue.enqueue(event(index))
    const callbacks: Array<(result: TransportResult) => void> = []
    const transport: TransportPort = { dispatch: (_request, done) => { callbacks.push(done) } }
    const clocks = runtime()
    const uploader = new Uploader(queue, transport, clocks.value, 'https://collector.example', 'account')

    uploader.flush()
    expect(callbacks).toHaveLength(3)
    expect(uploader.activeCount()).toBe(3)
    callbacks[0]?.({ kind: 'success', status: 204 })
    expect(callbacks).toHaveLength(4)
    expect(uploader.activeCount()).toBe(3)
  })

  it('retries network failure twice with documented jitter-free midpoint delays', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const callbacks: Array<(result: TransportResult) => void> = []
    const transport: TransportPort = { dispatch: (_request, done) => { callbacks.push(done) } }
    const clocks = runtime()
    const uploader = new Uploader(queue, transport, clocks.value, 'https://collector.example', 'account')

    uploader.flush()
    callbacks.shift()?.({ kind: 'network' })
    expect(clocks.scheduledDelays()).toContain(800)
    expect(queue.snapshot()[0]).toMatchObject({ retryCount: 1 })
    clocks.fireDelay(800)
    callbacks.shift()?.({ kind: 'timeout' })
    expect(clocks.scheduledDelays()).toContain(1_600)
    clocks.fireDelay(1_600)
    callbacks.shift()?.({ kind: 'success', status: 200 })
    expect(queue.snapshot()).toStrictEqual([])
  })

  it('drops 4xx once and never schedules a retry', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const drops: unknown[] = []
    const transport: TransportPort = { dispatch: (_request, done) => { done({ kind: 'http', status: 400 }) } }
    const clocks = runtime()
    const uploader = new Uploader(queue, transport, clocks.value, 'https://collector.example', 'account', (drop) => drops.push(drop))

    uploader.flush()
    expect(queue.snapshot()).toStrictEqual([])
    expect(clocks.scheduledDelays()).toStrictEqual([])
    expect(drops).toStrictEqual([{ requestIds: ['q1'], reason: 'non_retryable', result: { kind: 'http', status: 400 } }])
  })

  it('exposes sanitized protocol events to an optional observer immediately before dispatch without queue metadata', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const observations: Array<readonly ProtocolEvent[]> = []
    const order: string[] = []
    const transport: TransportPort = {
      dispatch: (_request, done) => {
        order.push('transport')
        done({ kind: 'success', status: 204 })
      },
    }
    const uploader = new Uploader(
      queue, transport, runtime().value, 'https://collector.example', 'account',
      undefined, undefined, (events) => { observations.push(events); order.push('observer') },
    )

    uploader.flush()
    expect(order).toStrictEqual(['observer', 'transport'])
    expect(observations).toStrictEqual([[{ eventType: 'CUSTOM', eventName: 'event_1', eventSequenceId: 1 }]])
  })

  it('forceFlush settles true once the active batch completes, or false at its one-second deadline', async () => {
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const callbacks: Array<(result: TransportResult) => void> = []
    const clocks = runtime()
    const transport: TransportPort = { dispatch: (_request, done) => { callbacks.push(done) } }
    const uploader = new Uploader(queue, transport, clocks.value, 'https://collector.example', 'account')

    const flushed = uploader.forceFlush()
    callbacks[0]?.({ kind: 'success', status: 204 })
    await expect(flushed).resolves.toBe(true)

    queue.enqueue(event(2))
    const timedOut = uploader.forceFlush()
    clocks.fireDelay(1_000)
    await expect(timedOut).resolves.toBe(false)
  })
  it('新请求占满槽位时到期重试也必须等待', () => {
    const queue = new EventQueue({ maxItems: 6, maxPersistedBytes: 5000, maxEventBytes: 500, maxBatchEvents: 1, maxBatchBytes: 500 })
    for (let i = 1; i <= 5; i++) queue.enqueue(event(i))
    const callbacks: Array<(result: TransportResult) => void> = []
    const clocks = runtime()
    const uploader = new Uploader(queue, { dispatch: (_request, done) => { callbacks.push(done) } }, clocks.value, 'https://collector.example', 'account')
    uploader.flush()
    callbacks[0]!({ kind: 'network' })
    expect(callbacks).toHaveLength(4)
    clocks.fireDelay(800)
    expect(callbacks).toHaveLength(4)
    expect(uploader.activeCount()).toBe(3)
    callbacks[1]!({ kind: 'success', status: 204 })
    expect(callbacks).toHaveLength(5)
    expect(uploader.activeCount()).toBe(3)
  })

})
