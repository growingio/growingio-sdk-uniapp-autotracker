import { describe, expect, it } from 'vitest'
import { SharedIdentityPersistence, type SharedIdentityStorage } from '../../src/core/storage/sharedIdentity.js'
import type { StorageRead, StorageWrite } from '../../src/types/index.js'

const keys = { deviceId: '_growing_uid_', userId: '_growing_userId_', userKey: '_growing_userKey_', lastUserId: '_growing_gioId_' }
const recoveryKey = 'gio:mp:v1:shared-identity:_growing_uid_:_growing_userId_:_growing_userKey_:_growing_gioId_:pending'
const before = { deviceId: 'device-A', userId: 'user-A', userKey: 'key-A', lastUserId: 'user-A' }
const after = { deviceId: 'device-A', userId: 'user-B', userKey: 'key-B', lastUserId: 'user-B' }
const record = { version: 1, keys, before, after }

function fixture() {
  const values = new Map<string, string>(Object.entries(keys).map(([field, key]) => [key, before[field as keyof typeof before]]))
  let read: ((key: string) => StorageRead | undefined) | undefined
  let write: ((key: string, value: string) => StorageWrite | undefined) | undefined
  let remove: ((key: string) => StorageWrite | undefined) | undefined
  const storage: SharedIdentityStorage = {
    read: key => read?.(key) ?? (values.has(key) ? { kind: 'value', value: values.get(key)! } : { kind: 'missing' }),
    write: (key, value) => { const result = write?.(key, value); if (result !== undefined) return result; values.set(key, value); return { kind: 'ok' } },
    remove: key => { const result = remove?.(key); if (result !== undefined) return result; values.delete(key); return { kind: 'ok' } },
  }
  const create = (recover = true) => new SharedIdentityPersistence(storage, keys, recover)
  return { values, create, read: (handler?: typeof read) => { read = handler }, write: (handler?: typeof write) => { write = handler }, remove: (handler?: typeof remove) => { remove = handler } }
}

describe('mini shared identity recovery record boundaries', () => {
  it.each([
    ['invalid JSON', '{'], ['null', 'null'], ['array', '[]'], ['primitive', '42'],
    ['unknown version', JSON.stringify({ ...record, version: 2 })],
    ['missing scope', JSON.stringify({ ...record, keys: null })],
    ['another scope', JSON.stringify({ ...record, keys: { ...keys, userId: 'other-user-key' } })],
    ['missing before', JSON.stringify({ ...record, before: undefined })],
    ['array snapshot', JSON.stringify({ ...record, before: [] })],
    ['incomplete snapshot', JSON.stringify({ ...record, before: { deviceId: 'device-A' } })],
    ['invalid field type', JSON.stringify({ ...record, before: { ...before, userKey: 1 } })],
    ['invalid field encoding', JSON.stringify({ ...record, after: { ...after, userKey: '\ud800' } })],
    ['oversized field', JSON.stringify({ ...record, before: { ...before, userId: 'x'.repeat(1001) } })],
    ['missing after device', JSON.stringify({ ...record, after: { ...after, deviceId: null } })],
  ])('does not release or alter an identity with %s in its recovery record', (_, serialized) => {
    const f = fixture()
    f.values.set(recoveryKey, serialized)
    expect(() => f.create().hydrate(() => 'unused')).toThrow('invalid_shared_identity_recovery')
    expect(Object.fromEntries(f.values)).toEqual({
      _growing_uid_: 'device-A', _growing_userId_: 'user-A', _growing_userKey_: 'key-A', _growing_gioId_: 'user-A',
      [recoveryKey]: serialized,
    })
  })

  it.each(['failed', 'unconfirmed'] as const)('requires durable recovery record creation before generating a device (%s)', mode => {
    const f = fixture()
    f.values.clear()
    f.write(key => key === recoveryKey ? { kind: mode === 'failed' ? 'failed' : 'ok' } : undefined)
    expect(() => f.create().hydrate(() => 'new-device')).toThrow('shared_identity_write_failed')
    expect(f.values.has('_growing_uid_')).toBe(false)
    f.write()
    expect(f.create().hydrate(() => 'new-device')).toMatchObject({ identity: { deviceId: 'new-device', userId: null, userKey: null } })
    expect(f.values.has(recoveryKey)).toBe(false)
  })

  it.each(['failed', 'unconfirmed'] as const)('keeps a completed write blocked until recovery record cleanup is durable (%s)', mode => {
    const f = fixture()
    const identity = f.create()
    f.remove(key => key === recoveryKey ? { kind: mode === 'failed' ? 'failed' : 'ok' } : undefined)
    expect(identity.persist(identity.current(), after)).toBe(false)
    expect(f.values.get('_growing_userId_')).toBe('user-B')
    expect(f.values.get('_growing_userKey_')).toBe('key-B')
    expect(() => f.create().hydrate(() => 'unused')).toThrow('shared_identity_recovery_write_failed')
    f.remove()
    expect(f.create().hydrate(() => 'unused').identity).toEqual(after)
    expect(f.values.has(recoveryKey)).toBe(false)
  })

  it('retries an anonymous rollback after removal of a partially written login was refused', () => {
    const f = fixture()
    f.values.delete('_growing_userKey_')
    f.values.delete('_growing_gioId_')
    f.values.set('_growing_userId_', 'user-B')
    f.values.set(recoveryKey, JSON.stringify({ ...record, before: { deviceId: 'device-A', userId: null, userKey: null, lastUserId: null } }))
    f.remove(key => key === '_growing_userId_' ? { kind: 'failed' } : undefined)
    expect(() => f.create().hydrate(() => 'unused')).toThrow('shared_identity_recovery_write_failed')
    expect(f.values.get('_growing_userId_')).toBe('user-B')
    f.remove()
    expect(f.create().hydrate(() => 'unused').identity).toEqual({ deviceId: 'device-A', userId: null, userKey: null, lastUserId: null })
    expect(f.values.has(recoveryKey)).toBe(false)
  })

  it('rejects an update that leaves a different field from an incomplete transaction unresolved', () => {
    const f = fixture()
    f.values.set('_growing_userId_', 'user-B')
    f.values.set(recoveryKey, JSON.stringify(record))
    const identity = f.create()
    expect(identity.persist(identity.current(), { deviceId: 'device-B' })).toBe(false)
    expect(f.values.get('_growing_uid_')).toBe('device-A')
    expect(f.values.get('_growing_userId_')).toBe('user-A')
    expect(f.values.get('_growing_userKey_')).toBe('key-A')
  })

  it('does not replace a valid external device while repairing the login fields', () => {
    const f = fixture()
    const identity = f.create()
    const previous = identity.current()
    f.values.set('_growing_uid_', 'external-device')
    expect(identity.persist(previous, { userId: 'next-user' })).toBe(false)
    expect(f.values.get('_growing_uid_')).toBe('external-device')
    expect(f.values.get('_growing_userId_')).toBe('user-A')
  })

  it('keeps a newer external value intact if it appears during the final rollback write', () => {
    const f = fixture()
    f.values.set('_growing_uid_', 'device-B')
    f.values.set(recoveryKey, JSON.stringify({ ...record, after: { ...after, deviceId: 'device-B' } }))
    f.write((key, value) => {
      if (key === '_growing_uid_' && value === 'device-A') f.values.set('_growing_userKey_', 'external-key')
      return undefined
    })
    expect(() => f.create().hydrate(() => 'unused')).toThrow('shared_identity_recovery_conflict')
    expect(f.values.get('_growing_userKey_')).toBe('external-key')
    expect(f.values.has(recoveryKey)).toBe(true)
  })

  it('rejects a login if another writer changes the device before its complete-state check', () => {
    const f = fixture()
    const identity = f.create()
    f.write((key, value) => {
      if (key === '_growing_userKey_' && value === 'key-B') f.values.set('_growing_uid_', 'external-device')
      return undefined
    })
    expect(identity.persist(identity.current(), after)).toBe(false)
    expect(f.values.get('_growing_uid_')).toBe('external-device')
    expect(f.values.get('_growing_userId_')).toBe('user-B')
    expect(f.values.has(recoveryKey)).toBe(true)
    expect(() => f.create().hydrate(() => 'unused')).toThrow('shared_identity_recovery_conflict')
  })

  it('does not recover using a record replaced by another writer', () => {
    const f = fixture()
    f.values.set('_growing_userId_', 'user-B')
    f.values.set(recoveryKey, JSON.stringify(record))
    const newer = JSON.stringify({ ...record, after: { ...after, userId: 'external-user' } })
    let reads = 0
    f.read(key => {
      if (key === recoveryKey && ++reads === 2) f.values.set(key, newer)
      return undefined
    })
    expect(() => f.create().hydrate(() => 'unused')).toThrow('shared_identity_recovery_conflict')
    expect(f.values.get('_growing_userId_')).toBe('user-B')
    expect(f.values.get(recoveryKey)).toBe(newer)
  })

  it('does not enable device fallback or mini recovery records for default Web persistence', () => {
    const f = fixture()
    const identity = f.create(false)
    expect(identity.persist(identity.current(), { userId: 'web-user' })).toBe(true)
    expect(f.values.has(recoveryKey)).toBe(false)
    f.values.delete('_growing_uid_')
    expect(() => identity.current('device-A')).toThrow('missing_shared_device_id')
  })
})
