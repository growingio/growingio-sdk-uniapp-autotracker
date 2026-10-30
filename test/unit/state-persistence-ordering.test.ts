import { describe, expect, it } from 'vitest'
import { IdentityPersistence, MetaPersistence, SessionPersistence } from '../../src/core/storage/index.js'
import type { StoragePort, StorageWrite } from '../../src/types/index.js'

describe('异步状态存储顺序', () => {
  it('后一次写入更快时，重启恢复的身份仍是最后登录的用户', async () => {
    let value = ''
    let calls = 0
    let releaseFirst: () => void = () => { throw new Error('write_not_started') }
    const port: StoragePort = {
      persistentQueue: true, read: async () => ({ kind: 'value', value }), remove: async () => ({ kind: 'ok' }),
      write: async (_area, _key, next) => {
        if (++calls === 1) await new Promise<void>(resolve => { releaseFirst = resolve })
        value = next
        return { kind: 'ok' }
      },
    }
    const persistence = new IdentityPersistence(port, 'identity', 'source', () => 'device')
    const first = persistence.persist({ deviceId: 'device', userId: 'A', userKey: null })
    const second = persistence.persist({ deviceId: 'device', userId: 'B', userKey: null })
    await Promise.resolve()
    releaseFirst()
    await Promise.all([first, second])
    expect(await new IdentityPersistence(port, 'identity', 'source', () => 'other-device').hydrate())
      .toMatchObject({ identity: { deviceId: 'device', userId: 'B' } })
  })

  it.each(['identity', 'session', 'meta'] as const)('%s 的慢写入不会回退后续状态，突发更新合并为最新值', async (kind) => {
    let value: string | undefined
    const writes: Array<{ value: string; complete: (result: StorageWrite) => void }> = []
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => value === undefined ? { kind: 'missing' } : { kind: 'value', value },
      remove: async () => ({ kind: 'ok' }),
      write: (_area, _key, next) => new Promise(resolve => {
        writes.push({ value: next, complete: result => { if (result.kind === 'ok') value = next; resolve(result) } })
      }),
    }
    const identity = new IdentityPersistence(port, 'identity', 'source', () => 'device')
    const session = new SessionPersistence(port, 'session')
    const meta = new MetaPersistence(port, 'meta')
    const persist = (step: number) => kind === 'identity' ? identity.persist({ deviceId: 'device', userId: `user-${step}`, userKey: null })
      : kind === 'session' ? session.persist({ sessionId: `session-${step}`, lastCloseTime: step }) : meta.persist({ eventSequenceId: step })
    const first = persist(1)
    const pending: Promise<StorageWrite>[] = []
    for (let step = 2; step <= 1000; step++) pending.push(persist(step))
    expect(writes).toHaveLength(1)
    expect(new Set(pending).size).toBe(1)
    writes[0]!.complete({ kind: 'ok' })
    expect(await first).toEqual({ kind: 'ok' })
    expect(writes).toHaveLength(2)
    writes[1]!.complete({ kind: 'ok' })
    expect((await Promise.all(pending)).every(result => result.kind === 'ok')).toBe(true)
    if (kind === 'identity') expect(await identity.hydrate()).toMatchObject({ identity: { userId: 'user-1000' } })
    else if (kind === 'session') expect(await session.hydrate()).toMatchObject({ snapshot: { sessionId: 'session-1000', lastCloseTime: 1000 } })
    else expect(await meta.hydrate()).toMatchObject({ snapshot: { eventSequenceId: 1000 } })
  })
})
