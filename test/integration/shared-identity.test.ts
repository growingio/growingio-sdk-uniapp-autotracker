import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { miniHost } from '../support/miniprogram-host.js'
import { serializeIdentityRecord } from '../../src/core/userStore.js'
import { normalizeInitOptions } from '../../src/constants/config.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('shared identity persistence boundaries', () => {
  it('starts from shared keys and leaves previous uni-app encrypted records untouched', async () => {
    const f = miniHost('mp-weixin')
    const oldKey = `gio:mp:v1:mp-weixin:${f.appId}:account:source:identity`
    const previous = serializeIdentityRecord({ deviceId: 'previous-uni-device', userId: 'previous-uni-user', userKey: null }, 'source')
    f.values.set(oldKey, previous)
    f.init()
    expect(await f.tracker.whenReady()).toBe(true)
    f.show()
    expect(f.tracker.queuedEvents()[0]).toMatchObject({ deviceId: 'fixture-device' })
    expect(f.tracker.queuedEvents()[0]).not.toHaveProperty('userId')
    expect(f.values.get(oldKey)).toBe(previous)
    expect(f.host.getStorageSync).not.toHaveBeenCalledWith(oldKey)
  })

  it('leaves a malformed shared field intact and permits initialization after repair', async () => {
    const f = miniHost('mp-alipay')
    const corrupted = { value: 'old-envelope', expiredAt: 'future' }
    f.values.set('_growing_uid_', corrupted)
    f.init()
    expect(await f.tracker.whenReady()).toBe(false)
    expect(f.values.get('_growing_uid_')).toBe(corrupted)
    expect(f.sent).toEqual([])
    f.values.set('_growing_uid_', 'repaired-device')
    expect(f.init()).toBe(true)
    expect(await f.tracker.whenReady()).toBe(true)
    f.show()
    expect(f.tracker.queuedEvents()[0]).toMatchObject({ deviceId: 'repaired-device' })
  })

  it('rolls back a partial account write and resumes after the business operation succeeds', async () => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true })
    await f.tracker.whenReady()
    f.show()
    expect(f.tracker.setUserId('before-user', 'before-key')).toBe(true)
    const previous = new Map(f.values)
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_userKey_' && value === 'after-key') throw new Error('full')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('after-user', 'after-key')).toBe(false)
    for (const key of ['_growing_uid_', '_growing_userId_', '_growing_userKey_', '_growing_gioId_']) expect(f.values.get(key)).toEqual(previous.get(key))
    expect(f.tracker.track('must_wait')).toBe(false)
    expect(f.tracker.getGioInfo()).toBeNull()
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.setUserId('after-user', 'after-key')).toBe(true)
    expect(f.tracker.track('recovered')).toBe(true)
    expect(f.tracker.queuedEvents().at(-1)).toMatchObject({ deviceId: 'fixture-device', userId: 'after-user', userKey: 'after-key' })
  })

  it('keeps forceLogin pending until the assigned device is durably stored', async () => {
    const f = miniHost('mp-weixin')
    f.init({ forceLogin: true, uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_uid_') throw new Error('denied')
      f.values.set(key, value)
    })
    expect(f.tracker.identify('assigned-device')).toBe(false)
    expect(f.sent).toEqual([])
    expect(f.tracker.queuedEvents().every(event => event.deviceId === 'fixture-device')).toBe(true)
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.identify('assigned-device')).toBe(true)
    expect(f.values.get('_growing_uid_')).toBe('assigned-device')
    expect(f.sent.every(event => event.deviceId === 'assigned-device')).toBe(true)
  })

  it('keeps a failed account transaction blocked when identify only updates the device', async () => {
    const f = miniHost('mp-weixin')
    f.init({ forceLogin: true, idMapping: true, uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    expect(f.tracker.setUserId('old-user', 'old-key')).toBe(true)
    const consistentSession = f.tracker.queuedEvents()[0]!.sessionId
    f.host.setStorageSync.mockImplementation((key, value) => {
      if ((key === '_growing_userKey_' && value === 'new-key') || (key === '_growing_userId_' && value === 'old-user')) throw new Error('denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('new-user', 'new-key')).toBe(false)
    expect(f.values.get('_growing_userId_')).toBe('new-user')
    expect(f.values.get('_growing_userKey_')).toBe('old-key')
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.identify('assigned-device')).toBe(false)
    expect(f.tracker.track('still_blocked')).toBe(false)
    expect(f.sent).toEqual([])
    expect(f.tracker.setUserId('new-user', 'new-key')).toBe(true)
    expect(f.tracker.identify('assigned-device')).toBe(true)
    expect(f.tracker.track('consistent_identity')).toBe(true)
    expect(f.sent.at(-1)).toMatchObject({ deviceId: 'assigned-device', userId: 'new-user', userKey: 'new-key' })
    expect(new URLSearchParams(f.tracker.getGioInfo()!).get('gios')).not.toBe(consistentSession)
  })

  it('restores the last complete login marker when logout repairs a failed transaction', async () => {
    const f = miniHost('mp-weixin')
    f.init({ forceLogin: true, idMapping: true, uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    f.tracker.setUserId('old-user', 'old-key')
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (value === 'old-user' || value === 'old-key') throw new Error('rollback denied')
      f.values.set(key, value)
      if (key === '_growing_gioId_') throw new Error('write unconfirmed')
    })
    expect(f.tracker.setUserId('new-user', 'new-key')).toBe(false)
    expect(f.values.get('_growing_gioId_')).toBe('new-user')
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.clearUserId()).toBe(true)
    expect(f.values.get('_growing_gioId_')).toBe('old-user')
    expect(f.tracker.identify('assigned-device')).toBe(true)
    expect(f.tracker.track('recovered_logout')).toBe(true)
    expect(f.sent.at(-1)).toMatchObject({ deviceId: 'assigned-device', eventName: 'recovered_logout' })
    expect(f.sent.at(-1)).not.toHaveProperty('userId')
    expect(f.sent.at(-1)).not.toHaveProperty('userKey')
  })

  it('keeps an unconfirmed device change blocked when only login fields are updated', async () => {
    const f = miniHost('mp-weixin')
    f.init({ forceLogin: true, idMapping: true, uploadInterval: 0 })
    await f.tracker.whenReady()
    f.show()
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_uid_') {
        if (value === 'assigned-device') f.values.set(key, value)
        throw new Error('device write unconfirmed')
      }
      f.values.set(key, value)
    })
    expect(f.tracker.identify('assigned-device')).toBe(false)
    expect(f.values.get('_growing_uid_')).toBe('assigned-device')
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.setUserId('new-user', 'new-key')).toBe(false)
    expect(f.tracker.track('still_blocked')).toBe(false)
    expect(f.tracker.identify('assigned-device')).toBe(true)
    expect(f.tracker.track('confirmed_device')).toBe(true)
    expect(f.sent.at(-1)).toMatchObject({ deviceId: 'assigned-device', eventName: 'confirmed_device' })
    expect(f.sent.at(-1)).not.toHaveProperty('userId')
  })

  it('shares plugin device scope while isolating the child login keys', async () => {
    const f = miniHost('mp-weixin')
    f.values.set('_growing_plugin_uid_', 'plugin-device')
    f.values.set('_growing_plugin_userId_', 'primary-user')
    f.values.set('g1_growing_plugin_userId_', 'child-user')
    f.init({ miniprogramStorage: { plugin: true, storagePrefix: 'g1' } })
    await f.tracker.whenReady()
    f.show()
    expect(f.tracker.queuedEvents()[0]).toMatchObject({ deviceId: 'plugin-device', userId: 'child-user' })
    f.tracker.clearUserId()
    expect(f.values.get('g1_growing_plugin_userId_')).toBe('')
    expect(f.values.get('_growing_plugin_userId_')).toBe('primary-user')
    expect(f.values.has('_growing_uid_')).toBe(false)
  })

  it('rejects an ambiguous mini scope and ignores Web and Mini storage options on native App', () => {
    const input = { accountId: 'account', dataSourceId: 'source', appId: 'wx123' }
    expect(normalizeInitOptions({ ...input, miniprogramStorage: { storagePreifx: 'g1' } }, 'mp-weixin')).toEqual({ ok: false, code: 'invalid_storage_scope' })
    expect(normalizeInitOptions({ ...input, cookieDomain: 'example.com', storageType: 'localstorage',
      miniprogramStorage: { storagePrefix: 'g1', plugin: true }, embeddedAdapter: { strict: true }, hashtag: true,
    })).toEqual(normalizeInitOptions(input))
  })
})
