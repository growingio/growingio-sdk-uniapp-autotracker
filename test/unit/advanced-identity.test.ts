import { describe, expect, it, vi } from 'vitest'
import { runtimeFixture, RuntimeStorage } from '../support/runtime-fixture.js'
import { IdentityPersistence, storageKeys } from '../../src/core/storage/index.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import { assignedDeviceId, readIdentityRecord } from '../../src/core/userStore.js'
import { readLegacyMiniProgramIdentity } from '../../src/core/storage/legacyIdentity.js'
import { normalizeInitOptions } from '../../src/constants/config.js'
import { embeddedGioInfo } from '../../src/plugins/gioHybridAdapter/info.js'

const config = { accountId: 'account', dataSourceId: 'source' }
const source = { ...config, appId: 'wx-test' }
const show = { path: 'pages/home', query: '' }
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }

describe('forceLogin and embedded identity', () => {
  it('holds transmission and persistence until identify, preserving the ordered user identities', async () => {
    const dispatch = vi.fn()
    const { tracker, storage } = runtimeFixture({ upload: { transport: { dispatch }, runtime: {
      now: () => 100, random: () => 0, setTimeout: () => 1, clearTimeout: () => undefined,
    } } })
    expect(tracker.identify('assigned')).toBe(false)
    expect(tracker.init({ ...config, forceLogin: true })).toBe(true)
    tracker.onAppShow(show)
    await tracker.whenReady()
    tracker.setUserId('A')
    tracker.track('A_event')
    tracker.clearUserId()
    tracker.track('anon_event')
    await flush()
    expect(dispatch).not.toHaveBeenCalled()
    expect(storage.writes).not.toContain(storageKeys('source').queue)
    expect(tracker.getGioInfo()).toBeNull()
    expect(tracker.identify('device/中文&😀')).toBe(true)
    expect(tracker.identify('other')).toBe(false)
    const events = tracker.queuedEvents()
    expect(events.every(event => event.deviceId === 'device/中文&😀')).toBe(true)
    expect(events.filter(event => event.eventType === 'CUSTOM').map(event => event.userId)).toEqual(['A', undefined])
    expect(dispatch).toHaveBeenCalledOnce()
    const info = new URLSearchParams(tracker.getGioInfo()!)
    expect(info.get('giou')).toBe('device/中文&😀')
    expect(info.get('gios')).toBe('session-1')
    await flush()
    expect(readIdentityRecord(storage.values.get(storageKeys('source').identity)!, 'source')).toMatchObject({ identity: { deviceId: 'device/中文&😀' } })
  })

  it('preserves historical App queue identities and does not restore anonymous waiting events after restart', async () => {
    const storage = new RuntimeStorage()
    const first = runtimeFixture({ storage }).tracker
    first.init(config); first.onAppShow(show); await first.whenReady(); first.track('historic'); await flush()
    const persisted = storage.values.get(storageKeys('source').queue)!
    const second = runtimeFixture({ storage }).tracker
    second.init({ ...config, forceLogin: true }); second.onAppShow(show); await second.whenReady(); second.track('new')
    await flush()
    expect(storage.values.get(storageKeys('source').queue)).toBe(persisted)
    expect(second.identify(123)).toBe(true)
    expect(second.queuedEvents().filter(event => event.eventType === 'CUSTOM').map(event => [event.eventName, event.deviceId]))
      .toEqual([['historic', 'generated-device'], ['new', '123']])
  })

  it('orders identify during hydration and before the first foreground', async () => {
    const { tracker } = runtimeFixture()
    tracker.init({ ...config, forceLogin: true })
    tracker.track('before'); tracker.identify('assigned'); tracker.track('after')
    expect(tracker.identify('duplicate')).toBe(false)
    tracker.onAppShow(show)
    await tracker.whenReady()
    expect(tracker.queuedEvents().map(event => event.deviceId)).toEqual(['assigned', 'assigned', 'assigned'])
    expect(tracker.queuedEvents().map(event => event.eventName).filter(Boolean)).toEqual(['before', 'after'])
  })

  it('returns a non-mutating snapshot only after a real session and redacts identities when collection is disabled', async () => {
    const { tracker, setNow } = runtimeFixture()
    expect(tracker.getGioInfo()).toBeNull()
    tracker.init({ ...config, idMapping: true })
    await tracker.whenReady()
    expect(tracker.getGioInfo()).toBeNull()
    tracker.onAppShow(show); tracker.setUserId('A&=😀', 'key/中')
    let qs = new URLSearchParams(tracker.getGioInfo()!)
    expect(Object.fromEntries(qs)).toMatchObject({ giou: 'generated-device', giocs1: 'A&=😀', giouserkey: 'key/中', gionewdevice: 'true', gioplatform: 'Android' })
    const count = tracker.queuedEvents().length
    tracker.getGioInfo(); tracker.getGioInfo()
    expect(tracker.queuedEvents()).toHaveLength(count)
    tracker.onAppHide(); setNow(40_000); tracker.onAppShow(show)
    qs = new URLSearchParams(tracker.getGioInfo()!)
    expect(qs.get('gionewdevice')).toBe('false')
    tracker.setDataCollect(false)
    expect(Object.fromEntries(new URLSearchParams(tracker.getGioInfo()!))).toEqual({
      gioappid: 'example.app', gioprojectid: 'account', giodatasourceid: 'source', giodatacollect: 'false',
    })
  })

  it.each([null, undefined, '', ' ', '-', 'null', 'undefined', 0, -1, Infinity, NaN, {}, '\ud800', 'a'.repeat(1001)])('rejects invalid assigned identity %j', value => {
    expect(assignedDeviceId(value)).toBeNull()
  })
  it('keeps valid Unicode and positive numeric identity without truncating', () => {
    expect(assignedDeviceId('😀'.repeat(1000))).toBe('😀'.repeat(1000))
    expect(assignedDeviceId(1.5)).toBe('1.5')
    expect(assignedDeviceId('a'.repeat(2001))).toBeNull()
  })
  it('does not allow identify without explicit forceLogin', async () => {
    const { tracker } = runtimeFixture(); tracker.init(config); await tracker.whenReady()
    expect(tracker.identify('new')).toBe(false)
  })
  it('preserves an assigned ID matching the historical App preview format across a cold start', async () => {
    const storage = new RuntimeStorage()
    const first = runtimeFixture({ storage }).tracker
    first.init({ ...config, forceLogin: true }); await first.whenReady()
    expect(first.identify('device-assigned-value')).toBe(true)
    await flush()
    const second = runtimeFixture({ storage }).tracker
    second.init(config); second.onAppShow(show); await second.whenReady()
    expect(second.queuedEvents()[0]).toMatchObject({ deviceId: 'device-assigned-value' })
    expect(second.setUserId('user')).toBe(true)
    await flush()
    expect(readIdentityRecord(storage.values.get(storageKeys('source').identity)!, 'source')).toMatchObject({ identity: { deviceIdAssigned: true } })
  })
  it('assigns App identity after the backlog exceeds 200 events and 2MiB', async () => {
    const { tracker, storage } = runtimeFixture(); tracker.init({ ...config, forceLogin: true }); tracker.onAppShow(show); await tracker.whenReady()
    const properties = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`key${n}`, 'a'.repeat(1000)]))
    for (let n = 0; n < 250; n++) expect(tracker.track('full', properties)).toBe(true)
    const before = tracker.queuedEvents()
    expect(before).toHaveLength(251)
    expect(Buffer.byteLength(JSON.stringify(before))).toBeGreaterThan(2 * 1024 * 1024)
    const deviceId = '😀'.repeat(1000)
    expect(tracker.identify(deviceId)).toBe(true)
    expect(tracker.queuedEvents()).toEqual(before.map(event => ({ ...event, deviceId })))
    expect(tracker.getGioInfo()).not.toBeNull()
    await flush()
    expect(JSON.parse(storage.values.get(storageKeys('source').queue)!).entries.map((entry: { event: ProtocolEvent }) => entry.event))
      .toEqual(tracker.queuedEvents())
  })
  it('rejects a device ID expansion exceeding one event budget atomically, allowing a corrected identity', async () => {
    const { tracker } = runtimeFixture(); tracker.init({ ...config, forceLogin: true }); tracker.onAppShow(show); await tracker.whenReady()
    const properties = Object.fromEntries(Array.from({ length: 516 }, (_, n) => [`key${n}`, 'a'.repeat(1000)]))
    expect(tracker.track('full', properties)).toBe(true)
    const before = tracker.queuedEvents()
    expect(tracker.identify('😀'.repeat(1000))).toBe(false)
    expect(tracker.queuedEvents()).toEqual(before)
    expect(tracker.getGioInfo()).toBeNull()
    expect(tracker.identify('assigned')).toBe(true)
  })
  it('handles an unavailable session and malformed URI identity safely', () => {
    const input = { collecting: true, appId: 'app', accountId: 'a', dataSourceId: 's', platform: 'MinP', sessionId: 'session', identity: { deviceId: 'device', userId: null, userKey: null }, idMapping: false, newDevice: false }
    expect(Object.fromEntries(new URLSearchParams(embeddedGioInfo({ ...input, collecting: false })!))).toEqual({
      gioappid: 'app', gioprojectid: 'a', giodatasourceid: 's', giodatacollect: 'false',
    })
    expect(embeddedGioInfo({ ...input, sessionId: null })).toBeNull()
    expect(embeddedGioInfo({ ...input, appId: '\ud800' })).toBeNull()
  })
})

describe('explicit standalone mini-program identity migration', () => {
  const legacy = new Map<string, unknown>([['_growing_uid_', 'old-device'], ['_growing_userId_', 'old-user'], ['_growing_userKey_', 'old-key']])
  const port = { read: (key: string) => legacy.get(key) }
  it('enables migration only for a valid mini-program source and defaults invalid optional values', () => {
    expect(normalizeInitOptions({ ...source, legacyMiniProgramIdentity: source })).toEqual(normalizeInitOptions(source))
    expect(normalizeInitOptions({ ...source, legacyMiniProgramIdentity: source }, 'mp-weixin')).toMatchObject({ ok: true, config: { legacyMiniProgramIdentity: source } })
    for (const change of [{ accountId: 'other' }, { dataSourceId: 'other' }, { appId: 'other' }, { plugin: 1 }, { storagePrefix: '/' }, { storagePrefix: 'x'.repeat(129) }, { unknown: true }]) {
      expect(normalizeInitOptions({ ...source, legacyMiniProgramIdentity: { ...source, ...change } }, 'mp-weixin')).toEqual(normalizeInitOptions(source, 'mp-weixin'))
    }
    expect(normalizeInitOptions({ ...config, forceLogin: null })).toEqual(normalizeInitOptions(config))
  })
  it('migrates only once into a missing namespace, preserves current identity and never alters old keys', async () => {
    const storage = new RuntimeStorage(false)
    const read = vi.fn(port.read)
    const identity = new IdentityPersistence(storage, 'new', 'source', () => 'new-device', () => readLegacyMiniProgramIdentity({ read }, source, true, 100))
    expect(await identity.hydrate()).toMatchObject({ source: 'legacy', identity: { deviceId: 'old-device', userId: 'old-user', userKey: 'old-key' } })
    expect(read.mock.calls.map(call => call[0])).toEqual(['_growing_uid_', '_growing_userId_', '_growing_userKey_'])
    expect(storage.writes).toEqual(['new'])
    read.mockClear()
    expect(await identity.hydrate()).toMatchObject({ source: 'restored' })
    expect(read).not.toHaveBeenCalled()
    expect(legacy.size).toBe(3)
  })
  it('reads plugin and sub-instance keys, respecting expiration and idMapping', () => {
    const values: Record<string, unknown> = { _growing_plugin_uid_: { value: 'device', expiredAt: 101 }, sub_growing_plugin_userId_: 'user', sub_growing_plugin_userKey_: 'key' }
    const read = (key: string) => values[key]
    expect(readLegacyMiniProgramIdentity({ read }, { ...source, plugin: true, storagePrefix: 'sub' }, false, 100)).toEqual({ deviceId: 'device', userId: 'user', userKey: null, lastUserId: 'user', deviceIdAssigned: true })
    expect(readLegacyMiniProgramIdentity({ read }, { ...source, plugin: true }, true, 101)).toBeNull()
    values._growing_plugin_uid_ = { value: 'device', expiredAt: 'future' }
    expect(readLegacyMiniProgramIdentity({ read }, { ...source, plugin: true }, true, 100)).toBeNull()
    expect(readLegacyMiniProgramIdentity({ read: () => { throw Error('unavailable') } }, source, false, 100)).toBeNull()
    expect(readLegacyMiniProgramIdentity({ read: () => null }, source, false, 100)).toBeNull()
  })
  it('uses the real runtime migration seam and marks a migrated device as existing', async () => {
    const { tracker } = runtimeFixture({ target: 'mp-weixin', storage: new RuntimeStorage(false), legacyIdentity: port,
      systemContext: { load: async () => ({ ...((await import('../support/runtime-fixture.js')).appSystem), platform: 'MinP', domain: 'wx-test', deviceType: 'Weixin-Phone', operatingSystem: 'Weixin-Phone' }) } })
    tracker.init({ ...source, legacyMiniProgramIdentity: source }); tracker.onAppShow(show); await tracker.whenReady()
    expect(tracker.queuedEvents()[0]).toMatchObject({ deviceId: 'old-device', userId: 'old-user' })
    expect(new URLSearchParams(tracker.getGioInfo()!).get('gionewdevice')).toBe('false')
  })
  it('retains assigned markers in codecs, skips unavailable migration and accepts numeric expiration strings', async () => {
    const storage = new RuntimeStorage()
    const persistence = new IdentityPersistence(storage, 'new', 'source', () => 'generated', () => { throw Error('unavailable') })
    expect(await persistence.hydrate()).toMatchObject({ source: 'generated', identity: { deviceId: 'generated' } })
    const migrated = readLegacyMiniProgramIdentity({ read: key => key === '_growing_uid_' ? { value: 'device-assigned-value', expiredAt: '101' } : null }, source, false, 100)
    expect(migrated).toMatchObject({ deviceId: 'device-assigned-value', deviceIdAssigned: true })
    await persistence.persist(migrated!)
    expect(await persistence.hydrate()).toMatchObject({ source: 'restored', identity: { deviceId: 'device-assigned-value' } })
  })
})
