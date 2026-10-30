import { describe, expect, it } from 'vitest'

import {
  IDENTITY_VALUE_MAX_LENGTH,
  readIdentityRecord,
  serializeIdentityRecord,
  updateIdentity,
} from '../../src/core/userStore.js'

const anonymous = { deviceId: 'visitor-1', userId: null, userKey: null } as const

describe('identity record and mutation semantics', () => {
  it('retains and protects the latest nonempty user after clearing public login identity', () => {
    const loggedIn = updateIdentity(anonymous, 'private-latest-user', 'email', true)
    const loggedOut = updateIdentity(loggedIn.identity, '', undefined, true)
    expect(loggedOut.identity).toMatchObject({ userId: null, userKey: null, lastUserId: 'private-latest-user' })
    const serialized = serializeIdentityRecord(loggedOut.identity, 'source')
    expect(serialized).not.toContain('private-latest-user')
    expect(readIdentityRecord(serialized, 'source')).toMatchObject({ kind: 'current', identity: { lastUserId: 'private-latest-user' } })
  })

  it('accepts old encrypted records without a latest-user field', () => {
    const original = JSON.parse(serializeIdentityRecord({ ...anonymous, userId: 'A' }, 'source')) as { value: Record<string, unknown> }
    delete original.value.lastUserId
    expect(readIdentityRecord(JSON.stringify(original), 'source')).toStrictEqual({ kind: 'current', identity: { ...anonymous, userId: 'A' } })
  })

  it('rejects a corrupt protected latest-user value', () => {
    const original = JSON.parse(serializeIdentityRecord(anonymous, 'source')) as { value: Record<string, unknown> }
    original.value.lastUserId = 'plain-sensitive-user'
    expect(readIdentityRecord(JSON.stringify(original), 'source')).toStrictEqual({ kind: 'corrupt' })
  })

  it.each(['userId', 'userKey'])('rejects corrupt %s ciphertext instead of interpreting it as anonymous', (field) => {
    const original = JSON.parse(serializeIdentityRecord({ ...anonymous, userId: 'A', userKey: 'email' }, 'source')) as { value: Record<string, unknown> }
    original.value[field] = 'broken-ciphertext'
    expect(readIdentityRecord(JSON.stringify(original), 'source')).toStrictEqual({ kind: 'corrupt' })
  })
  it('writes an encrypted v1 envelope and reads it back', () => {
    const serialized = serializeIdentityRecord({ ...anonymous, userId: '张三', userKey: 'email' }, 'source')
    expect(serialized).not.toContain('visitor-1')
    expect(serialized).not.toContain('张三')
    expect(readIdentityRecord(serialized, 'source')).toStrictEqual({
      kind: 'current', identity: { deviceId: 'visitor-1', userId: '张三', userKey: 'email' },
    })
  })

  it('reads a valid plain legacy envelope for one-way migration', () => {
    expect(readIdentityRecord(JSON.stringify({ version: 1, expiresAt: null, value: anonymous }), 'source')).toStrictEqual({
      kind: 'legacy', identity: anonymous,
    })
  })

  it.each([
    'not-json',
    JSON.stringify({ version: 2, expiresAt: null, value: anonymous }),
    JSON.stringify({ version: 1, expiresAt: null, cipher: 'xor-utf8-v0', value: anonymous }),
    JSON.stringify({ version: 1, expiresAt: null, cipher: 'xor-utf8-v1', value: { ...anonymous, deviceId: 'gioenc-v3-invalid=' } }),
  ])('marks malformed or untrusted records as corrupt', (serialized) => {
    expect(readIdentityRecord(serialized, 'source')).toStrictEqual({ kind: 'corrupt' })
  })

  it('uses idMapping as an init-fixed user-key gate and clears identity on an empty user ID', () => {
    expect(updateIdentity(anonymous, 'A', 'email', false)).toStrictEqual({
      ok: true, identity: { ...anonymous, userId: 'A', userKey: null, lastUserId: 'A' }, userKeyIgnored: true, changed: true,
    })
    const mapped = updateIdentity(anonymous, 'A', 'email', true)
    expect(mapped.identity).toStrictEqual({ ...anonymous, userId: 'A', userKey: 'email', lastUserId: 'A' })
    expect(updateIdentity(mapped.identity, '', undefined, true)).toStrictEqual({
      ok: true, identity: { ...anonymous, lastUserId: 'A' }, userKeyIgnored: false, changed: true,
    })
  })

  it('rejects an oversize user id or user key atomically', () => {
    const tooLong = '😀'.repeat(IDENTITY_VALUE_MAX_LENGTH + 1)
    expect(updateIdentity(anonymous, tooLong, null, true)).toMatchObject({ ok: false, identity: anonymous, changed: false })
    expect(updateIdentity(anonymous, 'A', tooLong, true)).toMatchObject({ ok: false, identity: anonymous, changed: false })
  })

  it.each(['userId', 'userKey'] as const)('rejects a huge %s within the identity character budget', (field) => {
    const tooLong = '😀'.repeat(100_000)
    const originalIterator = String.prototype[Symbol.iterator]
    let visited = 0
    String.prototype[Symbol.iterator] = function () {
      const tracked = String(this) === tooLong
      const iterator = originalIterator.call(this)
      return {
        [Symbol.iterator]() { return this },
        next() {
          if (tracked) visited++
          return iterator.next()
        },
      }
    }
    try {
      const result = field === 'userId'
        ? updateIdentity(anonymous, tooLong, null, true)
        : updateIdentity(anonymous, 'A', tooLong, true)
      expect(result).toMatchObject({ ok: false, identity: anonymous, changed: false })
      expect(visited).toBeLessThanOrEqual(IDENTITY_VALUE_MAX_LENGTH + 1)
    } finally {
      String.prototype[Symbol.iterator] = originalIterator
    }
  })

  it('accepts exactly the identity character budget without splitting surrogate pairs', () => {
    const limit = '😀'.repeat(IDENTITY_VALUE_MAX_LENGTH)
    expect(updateIdentity(anonymous, limit, limit, true)).toMatchObject({ ok: true, identity: { userId: limit, userKey: limit } })
  })

  it.each(['\ud800', '\udc00', 'before\ud800after'])('rejects unpaired UTF-16 before identity encryption: %j', (value) => {
    expect(updateIdentity(anonymous, value, null, true)).toMatchObject({ ok: false, identity: anonymous, changed: false })
    expect(updateIdentity(anonymous, 'A', value, true)).toMatchObject({ ok: false, identity: anonymous, changed: false })
  })
})
