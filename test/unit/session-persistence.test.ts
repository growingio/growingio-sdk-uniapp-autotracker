import { describe, expect, it } from 'vitest'

import { SessionPersistence } from '../../src/core/storage/index.js'
import type { StoragePort } from '../../src/types/index.js'

/** 模拟会话存储结果并记录仅针对当前会话键的清理。 */
function port(value: Awaited<ReturnType<StoragePort['read']>>): { port: StoragePort; removed: () => number; writes: string[] } {
  let removals = 0
  const writes: string[] = []
  return {
    port: {
      persistentQueue: true,
      read: async () => value,
      write: async (_area, _key, serialized) => { writes.push(serialized); return { kind: 'ok' } },
      remove: async () => { removals += 1; return { kind: 'ok' } },
    },
    removed: () => removals,
    writes,
  }
}

describe('SessionPersistence', () => {
  it('restores and persists the session without a host TTL', async () => {
    const backend = port({ kind: 'value', value: JSON.stringify({ version: 1, expiresAt: null, value: { sessionId: 'session', lastCloseTime: 100 } }) })
    const persistence = new SessionPersistence(backend.port, 'gio:v1:source:session')
    await expect(persistence.hydrate()).resolves.toStrictEqual({ snapshot: { sessionId: 'session', lastCloseTime: 100 }, source: 'restored' })
    await expect(persistence.persist({ sessionId: 'session', lastCloseTime: null })).resolves.toStrictEqual({ kind: 'ok' })
    expect(JSON.parse(backend.writes[0]!).value).toStrictEqual({ sessionId: 'session', lastCloseTime: null })
  })

  it('cleans only an invalid session record and reports missing independently', async () => {
    const corrupt = port({ kind: 'value', value: JSON.stringify({ version: 1, expiresAt: null, value: { sessionId: '', lastCloseTime: null } }) })
    await expect(new SessionPersistence(corrupt.port, 'gio:v1:source:session').hydrate()).resolves.toStrictEqual({ snapshot: null, source: 'corrupt' })
    expect(corrupt.removed()).toBe(1)
    await expect(new SessionPersistence(port({ kind: 'missing' }).port, 'gio:v1:source:session').hydrate()).resolves.toStrictEqual({ snapshot: null, source: 'missing' })
  })
})
