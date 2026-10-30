import { describe, expect, it } from 'vitest'

import { IdentityPersistence } from '../../src/core/storage/index.js'
import { serializeIdentityRecord } from '../../src/core/userStore.js'
import type { StoragePort } from '../../src/types/index.js'

/** 构造身份存储读取结果并记录本键写入和删除，验证故障隔离。 */
function port(read: Awaited<ReturnType<StoragePort['read']>>): { port: StoragePort; writes: string[]; removals: string[] } {
  const writes: string[] = []
  const removals: string[] = []
  return {
    port: {
      persistentQueue: true,
      read: async () => read,
      write: async (_area, _key, value) => { writes.push(value); return { kind: 'ok' } },
      remove: async (_area, key) => { removals.push(key); return { kind: 'ok' } },
    },
    writes,
    removals,
  }
}

describe('IdentityPersistence', () => {
  it('restores a protected record without generating or rewriting identity', async () => {
    const value = serializeIdentityRecord({ deviceId: 'visitor', userId: 'A', userKey: null }, 'source')
    const backend = port({ kind: 'value', value })
    const persistence = new IdentityPersistence(backend.port, 'gio:v1:source:identity', 'source', () => 'new-visitor')
    await expect(persistence.hydrate()).resolves.toStrictEqual({
      identity: { deviceId: 'visitor', userId: 'A', userKey: null }, source: 'restored',
    })
    expect(backend.writes).toStrictEqual([])
  })

  it('migrates a valid legacy record only by writing the encrypted replacement', async () => {
    const legacy = JSON.stringify({ version: 1, expiresAt: null, value: { deviceId: 'visitor', userId: null, userKey: null } })
    const backend = port({ kind: 'value', value: legacy })
    const persistence = new IdentityPersistence(backend.port, 'gio:v1:source:identity', 'source', () => 'new-visitor')
    await expect(persistence.hydrate()).resolves.toMatchObject({ source: 'legacy', identity: { deviceId: 'visitor' } })
    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0]).not.toContain('"visitor"')
  })

  it('replaces the legacy App preview device id with the UUID factory result', async () => {
    const value = serializeIdentityRecord({ deviceId: 'device-mtlcgvmp-jg42ca8ji3b', userId: 'A', userKey: null }, 'source')
    const backend = port({ kind: 'value', value })
    const persistence = new IdentityPersistence(backend.port, 'gio:v1:source:identity', 'source', () => '021b4e17-8361-4a46-b8ab-ea970a108e70')

    await expect(persistence.hydrate()).resolves.toStrictEqual({
      identity: { deviceId: '021b4e17-8361-4a46-b8ab-ea970a108e70', userId: 'A', userKey: null },
      source: 'generated',
    })
    expect(backend.writes).toHaveLength(1)
  })

  it('generates on a missing record and removes only the identity key after corruption', async () => {
    const missing = port({ kind: 'missing' })
    await expect(new IdentityPersistence(missing.port, 'gio:v1:source:identity', 'source', () => 'generated').hydrate()).resolves.toStrictEqual({
      identity: { deviceId: 'generated', userId: null, userKey: null }, source: 'generated',
    })
    expect(missing.writes).toHaveLength(1)
    expect(missing.writes[0]).not.toContain('generated')

    const corrupt = port({ kind: 'value', value: '{bad' })
    await expect(new IdentityPersistence(corrupt.port, 'gio:v1:source:identity', 'source', () => 'generated').hydrate()).resolves.toMatchObject({ source: 'corrupt' })
    expect(corrupt.removals).toStrictEqual(['gio:v1:source:identity'])
    expect(corrupt.writes).toHaveLength(1)
  })
})
