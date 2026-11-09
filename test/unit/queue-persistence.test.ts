import { describe, expect, it } from 'vitest'

import { QueuePersistence } from '../../src/core/storage/index.js'
import { buildAppEvent } from '../../src/core/dataStore/protocol.js'
import { EventQueue } from '../../src/core/queue.js'
import type { StoragePort } from '../../src/types/index.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import { APP_EVENT_FIXTURES } from '../contracts/app-protocol.fixture.js'

/** 创建可恢复的合法协议事件，供队列信封与写入顺序测试。 */
function event(sequence: number): ProtocolEvent {
  const built = buildAppEvent('CUSTOM', {
    deviceId: 'device', sessionId: 'session', dataSourceId: 'source', platform: 'Android', platformVersion: '14', timestamp: sequence,
    domain: 'com.example', appState: 'FOREGROUND', appName: 'Example', networkState: 'WIFI', screenWidth: 0, screenHeight: 0,
    deviceBrand: 'UNKNOWN', deviceModel: 'UNKNOWN', deviceType: 'UNKNOWN', appVersion: '1.0.0', language: 'en-US', timezoneOffset: '0',
    sdkVersion: '0.1.0', eventSequenceId: sequence, eventName: `event_${sequence}`,
  })
  if (!built.ok) throw new Error('fixture_event_invalid')
  return built.event
}

/** 创建可观察快照和写入结果的队列存储替身。 */
function storage(initial: string | null = null): { port: StoragePort; values: () => string[] } {
  let value = initial
  const values: string[] = []
  return {
    port: {
      persistentQueue: true,
      read: async () => value === null ? { kind: 'missing' } : { kind: 'value', value },
      write: async (_area, _key, next) => { values.push(next); value = next; return { kind: 'ok' } },
      remove: async () => { value = null; return { kind: 'ok' } },
    },
    values: () => values,
  }
}

describe('QueuePersistence', () => {
  it('延迟写入使用最后一次 persist 时的内容，后续未提交的移除和重试不改写快照', async () => {
    let finish: () => void = () => { throw new Error('write_not_started') }
    const values: string[] = []
    const port: StoragePort = {
      persistentQueue: true, read: async () => ({ kind: 'missing' }), remove: async () => ({ kind: 'ok' }),
      write: async (_area, _key, value) => {
        values.push(value)
        if (values.length === 1) await new Promise<void>(resolve => { finish = resolve })
        return { kind: 'ok' }
      },
    }
    const queue = new EventQueue()
    const persistence = new QueuePersistence(port, 'queue')
    queue.enqueue(event(1))
    const first = persistence.persist(queue)
    queue.enqueue(event(2))
    const pending = persistence.persist(queue)
    queue.remove(['q1'])
    queue.incrementRetries(['q2'])
    expect(persistence.persist(queue)).toBe(pending)
    queue.remove(['q2'])
    queue.enqueue(event(3))
    finish()
    await Promise.all([first, pending])
    expect(values).toHaveLength(2)
    expect(JSON.parse(values[0]!).entries).toEqual([{ requestId: 'q1', event: event(1), retryCount: 0 }])
    expect(JSON.parse(values[1]!).entries).toEqual([{ requestId: 'q2', event: event(2), retryCount: 1 }])
    expect(queue.snapshot().map(entry => entry.event)).toEqual([event(3)])
  })

  it('合并窗口内的多次请求只写一次最新快照，且写入不在调用栈内同步执行', async () => {
    const backend = storage()
    const timers: Array<{ callback: () => void; delayMs: number }> = []
    const persistence = new QueuePersistence(backend.port, 'queue', {
      setTimeout: (callback, delayMs) => { timers.push({ callback, delayMs }); return timers.length }, clearTimeout: () => undefined, delayMs: 1000,
    })
    const queue = new EventQueue()
    for (let index = 1; index <= 100; index++) { queue.enqueue(event(index)); persistence.request(queue) }
    await Promise.resolve()
    expect(backend.values()).toEqual([])
    expect(timers).toHaveLength(1)
    expect(timers[0]!.delayMs).toBe(1000)
    timers[0]!.callback()
    for (let step = 0; step < 6; step++) await Promise.resolve()
    expect(backend.values()).toHaveLength(1)
    expect(JSON.parse(backend.values()[0]!).entries).toHaveLength(100)
  })

  it('flush 立即写入窗口内的快照并取消定时写入，没有待写内容时不写', async () => {
    const backend = storage()
    const cleared: unknown[] = []
    let scheduled: (() => void) | null = null
    const persistence = new QueuePersistence(backend.port, 'queue', {
      setTimeout: callback => { scheduled = callback; return 'timer' }, clearTimeout: handle => { cleared.push(handle) }, delayMs: 1000,
    })
    expect(persistence.flush()).toBeNull()
    const queue = new EventQueue()
    queue.enqueue(event(1)); persistence.request(queue)
    expect(persistence.pending()).toBe(true)
    expect(await persistence.flush()).toEqual({ kind: 'ok' })
    expect(cleared).toEqual(['timer'])
    expect(persistence.pending()).toBe(false)
    scheduled!()
    for (let step = 0; step < 6; step++) await Promise.resolve()
    expect(backend.values()).toHaveLength(1)
  })

  it('部分条目损坏时只丢弃这些条目，并写回清理后的快照', async () => {
    const backend = storage(JSON.stringify({ version: 1, revision: 3, entries: [
      { requestId: 'q1', retryCount: 0, event: event(1) },
      { requestId: 'q2', retryCount: 0, event: { eventType: 'CUSTOM', eventName: 'forged' } },
      { requestId: 'q3', retryCount: 0, event: event(3) },
    ] }))
    const queue = new EventQueue()
    expect(await new QueuePersistence(backend.port, 'queue').hydrate(queue)).toBe('restored')
    expect(queue.snapshot().map(entry => entry.requestId)).toEqual(['q1', 'q3'])
    for (let step = 0; step < 6; step++) await Promise.resolve()
    expect(JSON.parse(backend.values().at(-1)!)).toMatchObject({ revision: 4, entries: [{ requestId: 'q1' }, { requestId: 'q3' }] })
  })

  it('修订号到达安全整数上限后继续写入可恢复的记录', async () => {
    const backend = storage(JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER, entries: [] }))
    const persistence = new QueuePersistence(backend.port, 'queue')
    const queue = new EventQueue()
    expect(await persistence.hydrate(queue)).toBe('restored')
    queue.enqueue(event(1))
    expect(await persistence.persist(queue)).toEqual({ kind: 'ok' })
    const record = JSON.parse(backend.values()[0]!)
    expect(Number.isSafeInteger(record.revision)).toBe(true)
    expect(record.revision).toBe(1)
    expect(await new QueuePersistence(backend.port, 'queue').hydrate(new EventQueue())).toBe('restored')
  })

  it('负修订号按损坏记录处理', async () => {
    const backend = storage(JSON.stringify({ version: 1, revision: -1, entries: [] }))
    expect(await new QueuePersistence(backend.port, 'queue').hydrate(new EventQueue())).toBe('corrupt')
  })

  it('慢存储期间仅保留一个待写快照，突发更新合并后仍恢复最新队列', async () => {
    let finish: (result: { kind: 'ok' }) => void = () => { throw new Error('write_not_started') }
    const values: string[] = []
    const port: StoragePort = {
      persistentQueue: true, read: async () => ({ kind: 'missing' }), remove: async () => ({ kind: 'ok' }),
      write: (_area, _key, value) => {
        values.push(value)
        return values.length === 1 ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ kind: 'ok' })
      },
    }
    const queue = new EventQueue()
    const persistence = new QueuePersistence(port, 'queue')
    queue.enqueue(event(1))
    const first = persistence.persist(queue)
    await Promise.resolve()
    const pending: Array<Promise<unknown>> = []
    for (let sequence = 2; sequence <= 200; sequence++) {
      queue.remove([`q${sequence - 1}`])
      queue.enqueue(event(sequence))
      pending.push(persistence.persist(queue))
    }
    expect(new Set(pending).size).toBe(1)
    finish({ kind: 'ok' })
    await Promise.all([first, ...pending])
    expect(values).toHaveLength(2)
    expect(persistence.currentRevision()).toBe(2)
    const restored = new EventQueue()
    expect(restored.restore(JSON.parse(values[1]!).entries)).toBe(true)
    expect(restored.snapshot().map(entry => entry.event.eventSequenceId)).toEqual([200])
  })

  it('serializes writes by revision and restores a cold-start queue', async () => {
    const backend = storage()
    const queue = new EventQueue()
    const persistence = new QueuePersistence(backend.port, 'gio:v1:source:queue:v1')
    queue.enqueue(event(1))
    const first = persistence.persist(queue)
    queue.enqueue(event(2))
    const second = persistence.persist(queue)
    await expect(first).resolves.toStrictEqual({ kind: 'ok' })
    await expect(second).resolves.toStrictEqual({ kind: 'ok' })
    expect(persistence.currentRevision()).toBe(2)
    expect(JSON.parse(backend.values()[1]!).revision).toBe(2)

    const restored = new EventQueue()
    const nextPersistence = new QueuePersistence(backend.port, 'gio:v1:source:queue:v1')
    await expect(nextPersistence.hydrate(restored)).resolves.toBe('restored')
    expect(restored.snapshot().map((entry) => entry.event.eventSequenceId)).toStrictEqual([1, 2])
  })

  it('removes only its queue key when a record is malformed', async () => {
    let removed = 0
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'value', value: '{not-json' }),
      write: async () => ({ kind: 'ok' }),
      remove: async () => { removed += 1; return { kind: 'ok' } },
    }
    await expect(new QueuePersistence(port, 'gio:v1:source:queue:v1').hydrate(new EventQueue())).resolves.toBe('corrupt')
    expect(removed).toBe(1)
  })

  it('rejects a syntactically valid snapshot whose event bypasses the protocol contract', async () => {
    let removed = 0
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'value', value: JSON.stringify({
        version: 1, revision: 1, entries: [{ requestId: 'q1', retryCount: 0, event: { eventType: 'CUSTOM', eventName: 'forged' } }],
      }) }),
      write: async () => ({ kind: 'ok' }),
      remove: async () => { removed += 1; return { kind: 'ok' } },
    }
    const queue = new EventQueue()
    await expect(new QueuePersistence(port, 'gio:v1:source:queue:v1').hydrate(queue)).resolves.toBe('corrupt')
    expect(queue.snapshot()).toStrictEqual([])
    expect(removed).toBe(1)
  })

  it('rejects a persisted request identifier that cannot produce a safe next queue id', async () => {
    const persisted = JSON.stringify({ version: 1, revision: 1, entries: [{ requestId: 'q9007199254740992', retryCount: 0, event: event(1) }] })
    let removed = 0
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'value', value: persisted }),
      write: async () => ({ kind: 'ok' }),
      remove: async () => { removed += 1; return { kind: 'ok' } },
    }
    await expect(new QueuePersistence(port, 'gio:v1:source:queue:v1').hydrate(new EventQueue())).resolves.toBe('corrupt')
    expect(removed).toBe(1)
  })

  it.each([
    { ...APP_EVENT_FIXTURES.CUSTOM, eventSequenceId: false },
    { ...APP_EVENT_FIXTURES.CUSTOM, eventSequenceId: -1 },
    { ...APP_EVENT_FIXTURES.CUSTOM, timestamp: '100' },
    { ...APP_EVENT_FIXTURES.CUSTOM, timestamp: 100.5 },
    { ...APP_EVENT_FIXTURES.CUSTOM, deviceId: { value: 'device' } },
    { ...APP_EVENT_FIXTURES.CUSTOM, networkState: 'offline' },
    { ...APP_EVENT_FIXTURES.CUSTOM, screenWidth: 10.5 },
    { ...APP_EVENT_FIXTURES.CUSTOM, latitude: '30' },
    { ...APP_EVENT_FIXTURES.CUSTOM, attributes: { nested: { private: 'bad' } } },
    { ...APP_EVENT_FIXTURES.LOGIN_USER_ATTRIBUTES, attributes: ['bad'] },
    { ...APP_EVENT_FIXTURES.PAGE, orientation: 'diagonal' },
    { ...APP_EVENT_FIXTURES.VIEW_CLICK, timestamp: { time: 100 } },
    { ...APP_EVENT_FIXTURES.VIEW_CLICK, timestamp: Number.MAX_SAFE_INTEGER + 1 },
    { ...APP_EVENT_FIXTURES.VIEW_CLICK, pageShowTimestamp: 100, unsupportedField: 100 },
    { ...APP_EVENT_FIXTURES.VIEW_CHANGE, xpath: true },
  ])('rejects damaged wire field values without replacing the live queue: %j', async (damaged) => {
    const key = 'gio:v1:source:queue:v1'
    const removed: string[] = []
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'value', value: JSON.stringify({ version: 1, revision: 1,
        entries: [{ requestId: 'q2', retryCount: 0, event: damaged }] }) }),
      write: async () => ({ kind: 'ok' }),
      remove: async (area, name) => { removed.push(`${area}:${name}`); return { kind: 'ok' } },
    }
    const queue = new EventQueue()
    queue.enqueue(event(9))
    expect(await new QueuePersistence(port, key).hydrate(queue)).toBe('corrupt')
    expect(queue.snapshot().map(entry => entry.event)).toEqual([event(9)])
    expect(removed).toEqual([`queue:${key}`])
  })

  it('does not advance revision when storage rejects a write', async () => {
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'missing' }),
      write: async () => ({ kind: 'quota' }),
      remove: async () => ({ kind: 'ok' }),
    }
    const queue = new EventQueue()
    queue.enqueue(event(1))
    const persistence = new QueuePersistence(port, 'gio:v1:source:queue:v1')
    await expect(persistence.persist(queue)).resolves.toStrictEqual({ kind: 'quota' })
    expect(persistence.currentRevision()).toBe(0)
  })

  it('原样恢复已经清理过空公共字段的上报事件', async () => {
    const backend = storage()
    const queue = new EventQueue()
    const cleaned = { ...event(1) } as Record<string, unknown>
    for (const key of ['domain', 'appName', 'appVersion']) delete cleaned[key]
    queue.enqueue(cleaned as ProtocolEvent)
    await new QueuePersistence(backend.port, 'queue').persist(queue)
    const restored = new EventQueue()
    expect(await new QueuePersistence(backend.port, 'queue').hydrate(restored)).toBe('restored')
    expect(restored.snapshot()[0]?.event).toEqual(cleaned)
  })

})
