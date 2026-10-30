import { describe, expect, it } from 'vitest'

import { MetaPersistence } from '../../src/core/storage/index.js'
import type { StoragePort } from '../../src/types/index.js'

describe('MetaPersistence', () => {
  it('restores and persists the cross-session event sequence', async () => {
    const writes: string[] = []
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'value', value: JSON.stringify({ version: 1, expiresAt: null, value: { eventSequenceId: 42 } }) }),
      write: async (_area, _key, value) => { writes.push(value); return { kind: 'ok' } },
      remove: async () => ({ kind: 'ok' }),
    }
    const persistence = new MetaPersistence(port, 'gio:v1:source:meta')
    await expect(persistence.hydrate()).resolves.toStrictEqual({ snapshot: { eventSequenceId: 42 }, source: 'restored' })
    await expect(persistence.persist({ eventSequenceId: 43 })).resolves.toStrictEqual({ kind: 'ok' })
    expect(JSON.parse(writes[0]!).value).toStrictEqual({ eventSequenceId: 43 })
  })

  it('removes only invalid meta and starts its sequence at zero', async () => {
    let removals = 0
    const port: StoragePort = {
      persistentQueue: true,
      read: async () => ({ kind: 'value', value: '{bad' }),
      write: async () => ({ kind: 'ok' }),
      remove: async () => { removals += 1; return { kind: 'ok' } },
    }
    await expect(new MetaPersistence(port, 'gio:v1:source:meta').hydrate()).resolves.toStrictEqual({ snapshot: { eventSequenceId: 0 }, source: 'corrupt' })
    expect(removals).toBe(1)
  })
})
