import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeIdentifierState, validNativeIdentifier, validNativeIdentifierOptions } from '../../src/plugins/gioNativeIdentifiers/index.js'
import { AppNativeIdentifiersPort } from '../../src/platform/native-identifiers.js'
import { buildAppEvent, buildMiniProgramEvent } from '../../src/core/dataStore/protocol.js'
import { runtimeFixture, appSystem } from '../support/runtime-fixture.js'

const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve() }
afterEach(() => vi.useRealTimers())
describe('optional native identifiers', () => {
  it.each([undefined, null, [], {}, { fields: [] }, { fields: ['bad'] }, { fields: ['oaid', 'oaid'] }, { fields: ['oaid'], extra: true }])('rejects invalid plugin options %j', input => {
    expect(validNativeIdentifierOptions(input)).toBe(false)
  })
  it('accepts explicit distinct supported fields', () => expect(validNativeIdentifierOptions({ fields: ['idfa', 'oaid'] })).toBe(true))
  it('snapshots registered identifier fields before caller mutation', async () => {
    const fields: ('oaid' | 'androidId')[] = ['oaid']
    const read = vi.fn(async () => ({ oaid: 'oaid' }))
    const tracker = runtimeFixture({ nativeIdentifiers: { read } }).tracker
    tracker.registerPlugins({ name: 'gioNativeIdentifiers', options: { fields } })
    fields.push('androidId')
    tracker.init({ accountId: 'a', dataSourceId: 's' }); await tracker.whenReady()
    expect(read).toHaveBeenCalledWith(['oaid'])
  })
  it.each(['', ' ', 'UNKNOWN', 'null', 'undefined', '00000000-0000-0000-0000-000000000000', '0', 'abc\n', '\ud800', 'a'.repeat(257), 42])('omits unusable identifier %j', value => expect(validNativeIdentifier(value)).toBe(false))
  it('keeps platform fields separate and never requests HarmonyOS identifiers', async () => {
    const read = vi.fn(async () => ({ oaid: 'android-oaid', idfa: 'ios-idfa', androidId: 'android-id', unexpected: 'secret' }))
    const android = new NativeIdentifierState({ read }, ['oaid', 'idfa', 'androidId'], 'Android')
    android.refresh(); await flush()
    expect(read).toHaveBeenCalledWith(['oaid', 'androidId'])
    expect(android.current()).toEqual({ oaid: 'android-oaid', androidId: 'android-id' })
    const ios = new NativeIdentifierState({ read }, ['oaid', 'idfa'], 'iOS')
    ios.refresh(); await flush()
    expect(ios.current()).toEqual({ idfa: 'ios-idfa' })
    read.mockClear()
    new NativeIdentifierState({ read }, ['oaid'], 'HarmonyOS').refresh()
    new NativeIdentifierState(undefined, ['oaid'], 'Android').refresh()
    expect(read).not.toHaveBeenCalled()
  })
  it('invalidates stale and consent-revoked callbacks, isolates failures and omits invalid data', async () => {
    const replies: ((value: unknown) => void)[] = []
    const read = vi.fn(() => new Promise(resolve => replies.push(resolve)))
    const state = new NativeIdentifierState({ read }, ['oaid'], 'Android')
    state.refresh(); state.clear(); replies[0]!({ oaid: 'old' }); await flush()
    expect(state.current()).toEqual({})
    state.refresh(); state.refresh(); replies[1]!({ oaid: 'stale' }); replies[2]!({ oaid: 'new' }); await flush()
    expect(state.current()).toEqual({ oaid: 'new' })
    state.refresh(); replies[3]!(null); await flush()
    expect(state.current()).toEqual({ oaid: 'new' })
    state.refresh(); replies[4]!({ oaid: '0' }); await flush()
    expect(state.current()).toEqual({})
    new NativeIdentifierState({ read: async () => { throw Error('no permission') } }, ['oaid'], 'Android').refresh()
    expect(() => new NativeIdentifierState({ read: () => { throw Error('synchronous failure') } }, ['oaid'], 'Android').refresh()).not.toThrow()
    await flush()
  })
  it('loads the agreed module lazily, handles synchronous and duplicate callbacks once, and validates the envelope', async () => {
    vi.useFakeTimers()
    const requireNativePlugin = vi.fn(() => ({ getIdentifiers: (request: unknown, done: (value: unknown) => void) => {
      expect(request).toEqual({ version: 1, fields: ['oaid'] }); done({ version: 1, identifiers: { oaid: 'oaid-value' } }); done({ version: 1, identifiers: { oaid: 'late' } })
    } }))
    const port = new AppNativeIdentifiersPort({ requireNativePlugin })
    expect(requireNativePlugin).not.toHaveBeenCalled()
    expect(await port.read(['oaid'])).toEqual({ oaid: 'oaid-value' })
    expect(requireNativePlugin).toHaveBeenCalledWith('GrowingIOUniAppEnhance')
    expect(vi.getTimerCount()).toBe(0)
    for (const reply of [null, { version: 2, identifiers: {} }]) {
      expect(await new AppNativeIdentifiersPort({ requireNativePlugin: () => ({ getIdentifiers: (_: unknown, done: (v: unknown) => void) => done(reply) }) }).read(['oaid'])).toEqual({})
    }
  })
  it('settles missing, invalid, throwing and silent modules without blocking startup', async () => {
    vi.useFakeTimers()
    for (const host of [{}, { requireNativePlugin: () => null }, { requireNativePlugin: () => ({}) }, { requireNativePlugin: () => { throw Error('secret') } },
      { requireNativePlugin: () => ({ getIdentifiers: () => { throw Error('secret') } }) }]) {
      expect(await new AppNativeIdentifiersPort(host).read(['oaid'])).toEqual({})
    }
    let done!: (value: unknown) => void
    const promise = new AppNativeIdentifiersPort({ requireNativePlugin: () => ({ getIdentifiers: (_: unknown, callback: typeof done) => { done = callback } }) }).read(['oaid'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(await promise).toEqual({})
    done({ version: 1, identifiers: { oaid: 'late' } })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('does no work by default and enriches only future events after explicit registration and consent', async () => {
    let done!: (value: unknown) => void
    const read = vi.fn(() => new Promise(resolve => { done = resolve }))
    const first = runtimeFixture({ nativeIdentifiers: { read } }).tracker
    first.init({ accountId: 'a', dataSourceId: 's' }); await first.whenReady()
    expect(read).not.toHaveBeenCalled()
    const tracker = runtimeFixture({ nativeIdentifiers: { read } }).tracker
    tracker.registerPlugins({ name: 'gioNativeIdentifiers', options: { fields: ['oaid', 'idfa'] } })
    tracker.init({ accountId: 'a', dataSourceId: 's', dataCollect: false }); tracker.onAppShow({ path: 'home', query: '' }); await tracker.whenReady()
    expect(read).not.toHaveBeenCalled()
    tracker.setDataCollect(true)
    expect(read).toHaveBeenCalledWith(['oaid'])
    expect(tracker.queuedEvents().every(event => event.oaid === undefined)).toBe(true)
    tracker.setDataCollect(false); done({ oaid: 'late' }); await flush()
    tracker.setDataCollect(true); done({ oaid: 'valid-oaid' }); await flush()
    tracker.track('enhanced')
    expect(tracker.queuedEvents().at(-1)).not.toHaveProperty('oaid')
    tracker.setUserId('A'); tracker.setUserId('B')
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ eventType: 'VISIT', oaid: 'valid-oaid', deviceId: 'generated-device' })
    expect(tracker.queuedEvents()[0]).not.toHaveProperty('oaid')
    tracker.setDataCollect(false); tracker.setDataCollect(true)
    expect(tracker.queuedEvents().at(-1)).not.toHaveProperty('oaid')
  })
  it('rejects native plugin on mini-program and enforces App platform fields at the protocol boundary', () => {
    const tracker = runtimeFixture({ target: 'mp-weixin' }).tracker
    tracker.registerPlugins({ name: 'gioNativeIdentifiers', options: { fields: ['oaid'] } })
    expect(tracker.init({ accountId: 'a', dataSourceId: 's', appId: 'wx-test' })).toBe(false)
    const fields = { ...appSystem, timestamp: 100, eventSequenceId: 1, sessionId: 's', deviceId: 'd', dataSourceId: 'ds', timezoneOffset: '0', oaid: 'oaid' }
    expect(buildAppEvent('VISIT', fields)).toMatchObject({ ok: true, event: { oaid: 'oaid' } })
    expect(buildAppEvent('CUSTOM', { ...fields, eventName: 'custom' })).toMatchObject({ ok: true })
    const custom = buildAppEvent('CUSTOM', { ...fields, eventName: 'custom' }); if (custom.ok) expect(custom.event).not.toHaveProperty('oaid')
    expect(buildAppEvent('VISIT', { ...fields, idfa: 'idfa' })).toMatchObject({ ok: false })
    expect(buildAppEvent('VISIT', { ...fields, platform: 'HarmonyOS' })).toMatchObject({ ok: false })
    expect(buildAppEvent('VISIT', { ...fields, oaid: '0000' })).toMatchObject({ ok: false })
    const { oaid: _, ...ios } = fields
    expect(buildAppEvent('VISIT', { ...ios, platform: 'iOS', idfv: 'idfv' })).toMatchObject({ ok: true })
    const mini = buildMiniProgramEvent('VISIT', { ...fields, platform: 'MinP', domain: 'wx-test', path: 'home', deviceType: 'Weixin-Phone', operatingSystem: 'Weixin-Phone' })
    expect(mini).toMatchObject({ ok: true }); if (mini.ok) expect(mini.event).not.toHaveProperty('oaid')
  })
})
