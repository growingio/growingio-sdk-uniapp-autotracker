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

const miniRecoveryPrefix = 'gio:mp:v1:shared-identity:'
const primaryRecoveryKey = `${miniRecoveryPrefix}_growing_uid_:_growing_userId_:_growing_userKey_:_growing_gioId_:pending`

function showTracker(tracker: ReturnType<ReturnType<typeof miniHost>['create']>): void {
  tracker.onAppLaunch({ path: 'pages/home', query: 'entry=1', scene: '1001', referralPage: 'external-app' })
  tracker.onAppShow({ path: 'pages/home', query: 'entry=1', scene: '1001', referralPage: 'external-app' })
  tracker.onPageLoad({ instanceId: 'home-1', route: 'pages/home', query: 'page=1', referralPage: null })
  tracker.onPageShow('home-1', '首页')
}

describe('mini-program shared identity recovery', () => {
  it.each([
    { clear: 'device', action: 'login' }, { clear: 'all', action: 'login' },
    { clear: 'device', action: 'logout' }, { clear: 'all', action: 'logout' },
    { clear: 'device', action: 'identify' }, { clear: 'all', action: 'identify' },
  ])('handles real-host empty-string missing keys and recovery cleanup (%j)', async ({ clear, action }) => {
    const f = miniHost('mp-weixin')
    f.host.getStorageSync.mockImplementation(key => f.values.get(key) ?? '')
    f.init({ idMapping: true, forceLogin: true, uploadInterval: 0 })
    expect(await f.tracker.whenReady()).toBe(true)
    expect(f.tracker.setUserId('old-user', 'old-key')).toBe(true)
    if (clear === 'all') f.values.clear()
    else f.values.delete('_growing_uid_')
    if (action === 'login') expect(f.tracker.setUserId('new-user', 'new-key')).toBe(true)
    else if (action === 'logout') expect(f.tracker.clearUserId()).toBe(true)
    expect(f.tracker.identify('assigned-device')).toBe(true)
    expect(f.values.has(primaryRecoveryKey)).toBe(false)
    f.show()
    expect(f.tracker.track('empty_missing_host')).toBe(true)
    expect(f.sent.at(-1)).toMatchObject({ deviceId: 'assigned-device', eventName: 'empty_missing_host' })
    if (action === 'login') expect(f.sent.at(-1)).toMatchObject({ userId: 'new-user', userKey: 'new-key' })
    else if (action === 'identify' && clear === 'device') expect(f.sent.at(-1)).toMatchObject({ userId: 'old-user', userKey: 'old-key' })
    else {
      expect(f.sent.at(-1)).not.toHaveProperty('userId')
      expect(f.sent.at(-1)).not.toHaveProperty('userKey')
    }
    if (action === 'logout' && clear === 'device') {
      expect(f.values.get('_growing_userId_')).toBe('')
      expect(f.values.get('_growing_userKey_')).toBe('')
    }
  })

  it('does not restore cleared login markers after a refused repair on an empty-string missing host', async () => {
    const f = miniHost('mp-weixin')
    f.host.getStorageSync.mockImplementation(key => f.values.get(key) ?? '')
    f.init({ idMapping: true })
    expect(await f.tracker.whenReady()).toBe(true)
    f.tracker.setUserId('old-user', 'old-key')
    f.values.clear()
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_uid_') throw new Error('device denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('new-user', 'new-key')).toBe(false)
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.clearUserId()).toBe(true)
    expect(f.values.get('_growing_gioId_') || null).toBeNull()
  })

  it.each([
    { forceLogin: false, dataCollect: true }, { forceLogin: true, dataCollect: true },
    { forceLogin: false, dataCollect: false }, { forceLogin: true, dataCollect: false },
  ])('blocks a mixed login across restart and retries after storage repair (%j)', async options => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true, ...options })
    expect(await f.tracker.whenReady()).toBe(true)
    expect(f.tracker.setUserId('user-A', 'key-A')).toBe(true)
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_userKey_' && value === 'key-B' || key === '_growing_userId_' && value === 'user-A') throw new Error('denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('user-B', 'key-B')).toBe(false)
    expect(f.values.get('_growing_userId_')).toBe('user-B')
    expect(f.values.get('_growing_userKey_')).toBe('key-A')
    const restarted = f.create()
    const init = () => restarted.init({ accountId: 'another-account', dataSourceId: 'another-source', appId: f.appId, idMapping: true, uploadInterval: 0, ...options })
    expect(init()).toBe(true)
    expect(await restarted.whenReady()).toBe(false)
    showTracker(restarted)
    expect(restarted.track('must_stay_blocked')).toBe(false)
    expect(f.sent).toEqual([])
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(init()).toBe(true)
    expect(await restarted.whenReady()).toBe(true)
    expect(f.values.get('_growing_userId_')).toBe('user-A')
    expect(f.values.get('_growing_userKey_')).toBe('key-A')
    showTracker(restarted)
    if (!options.dataCollect) expect(restarted.setDataCollect(true)).toBe(true)
    if (options.forceLogin) {
      expect(f.sent).toEqual([])
      expect(restarted.identify('assigned-device')).toBe(true)
    }
    expect(restarted.track('consistent_after_restart')).toBe(true)
    expect(f.sent.at(-1)).toMatchObject({ userId: 'user-A', userKey: 'key-A', eventName: 'consistent_after_restart' })
  })

  it('confirms a fully written login after restart when its write result and rollback were unconfirmed', async () => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true })
    await f.tracker.whenReady()
    expect(f.tracker.setUserId('user-A', 'key-A')).toBe(true)
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (value === 'user-A' || value === 'key-A') throw new Error('rollback denied')
      f.values.set(key, value)
      if (key === '_growing_gioId_') throw new Error('write result unavailable')
    })
    expect(f.tracker.setUserId('user-B', 'key-B')).toBe(false)
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    const restarted = f.create()
    restarted.init({ accountId: 'account', dataSourceId: 'source', appId: f.appId, idMapping: true })
    expect(await restarted.whenReady()).toBe(true)
    showTracker(restarted)
    expect(restarted.queuedEvents()[0]).toMatchObject({ userId: 'user-B', userKey: 'key-B' })
  })

  it('does not begin a login when its recovery record cannot be durably written', async () => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true })
    await f.tracker.whenReady()
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key.startsWith(miniRecoveryPrefix)) throw new Error('recovery record denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('must-not-write', 'must-not-write-key')).toBe(false)
    expect(f.values.has('_growing_userId_')).toBe(false)
    expect(f.values.has('_growing_userKey_')).toBe(false)
    expect(f.tracker.track('blocked')).toBe(false)
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.setUserId('confirmed-user', 'confirmed-key')).toBe(true)
    f.show()
    expect(f.tracker.track('recovered')).toBe(true)
    expect(f.tracker.queuedEvents().at(-1)).toMatchObject({ userId: 'confirmed-user', userKey: 'confirmed-key' })
  })

  it.each(['corrupt', 'unavailable'] as const)('keeps shared fields intact when the recovery record is %s', async failure => {
    const f = miniHost('mp-alipay')
    f.values.set('_growing_uid_', 'existing-device')
    f.values.set('_growing_userId_', 'existing-user')
    f.values.set('_growing_userKey_', 'existing-key')
    if (failure === 'corrupt') f.values.set(primaryRecoveryKey, '{broken')
    else f.host.getStorageSync.mockImplementation(key => {
      if (key === primaryRecoveryKey) throw new Error('record unavailable')
      return f.values.get(key)
    })
    f.init({ idMapping: true })
    expect(await f.tracker.whenReady()).toBe(false)
    expect(f.values.get('_growing_uid_')).toBe('existing-device')
    expect(f.values.get('_growing_userId_')).toBe('existing-user')
    expect(f.sent).toEqual([])
    f.values.delete(primaryRecoveryKey)
    f.host.getStorageSync.mockImplementation(key => f.values.get(key))
    f.init({ idMapping: true })
    expect(await f.tracker.whenReady()).toBe(true)
  })

  it('does not roll back a newer external login outside the saved before and after states', async () => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true })
    await f.tracker.whenReady()
    f.tracker.setUserId('user-A', 'key-A')
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_userKey_' && value === 'key-B' || key === '_growing_userId_' && value === 'user-A') throw new Error('denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('user-B', 'key-B')).toBe(false)
    f.values.set('_growing_userId_', 'external-user')
    f.values.set('_growing_userKey_', 'external-key')
    f.values.set('_growing_gioId_', 'external-user')
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    const restarted = f.create()
    const init = () => restarted.init({ accountId: 'account', dataSourceId: 'source', appId: f.appId, idMapping: true })
    init()
    expect(await restarted.whenReady()).toBe(false)
    expect(f.values.get('_growing_userId_')).toBe('external-user')
    expect(f.values.get('_growing_userKey_')).toBe('external-key')
    expect(f.values.get('_growing_gioId_')).toBe('external-user')
    expect(f.sent).toEqual([])
    f.values.set('_growing_userId_', 'user-A')
    f.values.set('_growing_userKey_', 'key-A')
    f.values.set('_growing_gioId_', 'user-A')
    init()
    expect(await restarted.whenReady()).toBe(true)
  })

  it.each([
    { clear: 'device', action: 'login' }, { clear: 'all', action: 'login' },
    { clear: 'device', action: 'logout' }, { clear: 'all', action: 'logout' },
    { clear: 'device', action: 'identify' }, { clear: 'all', action: 'identify' },
  ])('recovers an explicit identity operation after clearing storage (%j)', async ({ clear, action }) => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true, forceLogin: action === 'identify', uploadInterval: 0 })
    await f.tracker.whenReady()
    expect(f.tracker.setUserId('old-user', 'old-key')).toBe(true)
    if (clear === 'all') f.values.clear()
    else f.values.delete('_growing_uid_')
    const accepted = action === 'login' ? f.tracker.setUserId('new-user', 'new-key')
      : action === 'logout' ? f.tracker.clearUserId() : f.tracker.identify('assigned-device')
    expect(accepted).toBe(true)
    expect(f.values.get('_growing_uid_')).toBe(action === 'identify' ? 'assigned-device' : 'fixture-device')
    f.show()
    expect(f.tracker.track('after_cache_clear')).toBe(true)
    const event = f.sent.at(-1)!
    expect(event).toMatchObject({ deviceId: action === 'identify' ? 'assigned-device' : 'fixture-device', eventName: 'after_cache_clear' })
    if (action === 'login') expect(event).toMatchObject({ userId: 'new-user', userKey: 'new-key' })
    else if (action === 'identify' && clear === 'device') expect(event).toMatchObject({ userId: 'old-user', userKey: 'old-key' })
    else {
      expect(event).not.toHaveProperty('userId')
      expect(event).not.toHaveProperty('userKey')
      expect(f.values.get('_growing_userId_') || null).toBeNull()
      expect(f.values.get('_growing_userKey_') || null).toBeNull()
      if (clear === 'all') expect(f.values.get('_growing_gioId_') || null).toBeNull()
    }
  })

  it('keeps a cache-clear repair blocked until the full operation persists and does not revive the old login', async () => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true })
    await f.tracker.whenReady()
    f.tracker.setUserId('old-user', 'old-key')
    f.values.clear()
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_uid_') throw new Error('device denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('new-user', 'new-key')).toBe(false)
    expect(f.tracker.track('still_blocked')).toBe(false)
    f.host.setStorageSync.mockImplementation((key, value) => { f.values.set(key, value) })
    expect(f.tracker.clearUserId()).toBe(true)
    f.show()
    expect(f.tracker.track('recovered_logout')).toBe(true)
    expect(f.tracker.queuedEvents().at(-1)).not.toHaveProperty('userId')
    expect(f.values.get('_growing_gioId_') || null).toBeNull()
  })

  it.each(['corrupt', 'unavailable', 'external'] as const)('only restores a missing device and respects %s storage', async failure => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true })
    await f.tracker.whenReady()
    if (failure === 'unavailable') f.host.getStorageSync.mockImplementation(key => {
      if (key === '_growing_uid_') throw new Error('device unavailable')
      return f.values.get(key)
    })
    else f.values.set('_growing_uid_', failure === 'corrupt' ? { invalid: true } : 'external-device')
    expect(f.tracker.setUserId('next-user', 'next-key')).toBe(failure === 'external')
    expect(f.values.get('_growing_uid_')).toEqual(failure === 'corrupt' ? { invalid: true } : failure === 'external' ? 'external-device' : 'fixture-device')
    if (failure === 'external') {
      f.show()
      expect(f.tracker.queuedEvents()[0]).toMatchObject({ deviceId: 'external-device', userId: 'next-user', userKey: 'next-key' })
    }
  })

  it('isolates a pending plugin parent login from child login scopes that share its device', async () => {
    const f = miniHost('mp-weixin')
    f.init({ idMapping: true, miniprogramStorage: { plugin: true } })
    await f.tracker.whenReady()
    f.tracker.setUserId('parent-A', 'parent-key-A')
    f.host.setStorageSync.mockImplementation((key, value) => {
      if (key === '_growing_plugin_userKey_' && value === 'parent-key-B' || key === '_growing_plugin_userId_' && value === 'parent-A') throw new Error('denied')
      f.values.set(key, value)
    })
    expect(f.tracker.setUserId('parent-B', 'parent-key-B')).toBe(false)
    const child = f.create()
    child.init({ accountId: 'account', dataSourceId: 'source', appId: f.appId, idMapping: true, miniprogramStorage: { plugin: true, storagePrefix: 'g1' } })
    expect(await child.whenReady()).toBe(true)
    expect(child.setUserId('child-user', 'child-key')).toBe(true)
    showTracker(child)
    expect(child.queuedEvents()[0]).toMatchObject({ deviceId: 'fixture-device', userId: 'child-user', userKey: 'child-key' })
    expect(f.values.get('_growing_plugin_userId_')).toBe('parent-B')
    expect(f.values.get('_growing_plugin_userKey_')).toBe('parent-key-A')
    const parent = f.create()
    parent.init({ accountId: 'different', dataSourceId: 'different', appId: f.appId, idMapping: true, miniprogramStorage: { plugin: true } })
    expect(await parent.whenReady()).toBe(false)
    expect(f.values.get('g1_growing_plugin_userId_')).toBe('child-user')
  })
})
