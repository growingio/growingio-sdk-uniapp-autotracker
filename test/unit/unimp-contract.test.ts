import { describe, expect, it, vi } from 'vitest'
import { asciiId, HYBRID_EVENTS, normalizeUniMPConfig, positiveCounter, validHybridOptions, validateReply, wireBytes, type UniMPRequest } from '../../src/plugins/gioHybridAdapter/contract.js'
import { unimpConfig, unimpResolved } from '../support/unimp-host.js'

const header = { version: 1 as const, requestId: 1, instanceId: 'runtime', generation: 1 }
const hello: UniMPRequest = { ...header, method: 'hello', payload: { appId: unimpConfig.appId, accountId: 'account', dataSourceId: 'source', idMapping: true, sdkVersion: '0.1.0' } }
const helloReply = () => ({ ...header, status: 'ok', connectionId: 'connection', payload: { appId: unimpConfig.appId, accountId: 'account', dataSourceId: 'source', idMapping: true, hostType: 'native',
  platform: 'Android', nativeSdkVersion: '4.4.0', host: { dataCollect: true, containerVisible: true }, events: [...HYBRID_EVENTS], identityWrite: true } })
const operation: UniMPRequest = { ...header, method: 'dispatchEvent', connectionId: 'connection', payload: { event: { eventType: 'CUSTOM', eventName: 'event', timestamp: 100 } } }
const accepted = () => ({ ...header, status: 'accepted', connectionId: 'connection', host: { dataCollect: true, containerVisible: true } })

describe('Native v1 protocol validation', () => {
  it('normalizes explicit Native mode without App defaults and supports an arbitrary real appId', () => {
    expect(normalizeUniMPConfig({ ...unimpConfig, appId: '  real-app/😀  ' })).toEqual({ ...unimpResolved, appId: 'real-app/😀' })
    expect(normalizeUniMPConfig({ ...unimpConfig, appId: '😀'.repeat(256), serverUrl: undefined })).not.toBeNull()
    expect(normalizeUniMPConfig({ ...unimpConfig, dataCollect: 1, idMapping: 'true', debug: 1 })).toMatchObject({ dataCollect: true, idMapping: false, debug: false })
    for (const input of [null, [], { ...unimpConfig, runtime: 'app' }, { ...unimpConfig, appId: '\ud800' }, { ...unimpConfig, appId: 'a'.repeat(257) },
      { ...unimpConfig, accountId: 'a'.repeat(300000) }, ...['serverUrl', 'sessionExpires', 'appChannel', 'appVersion', 'keepAlive', 'uploadInterval', 'forceLogin', 'legacyMiniProgramIdentity'].map(key => ({ ...unimpConfig, [key]: null }))]) {
      expect(normalizeUniMPConfig(input)).toBeNull()
    }
  })
  it.each([null, [], { transport: 'host-event' }, { penetrateHybrid: 1 }, { onReady: 1 }, { onError: true }, { unknown: true }])('rejects unsupported plugin options %j', value => expect(validHybridOptions(value)).toBe(false))
  it('accepts only Native transport and typed callbacks', () => {
    expect(validHybridOptions(undefined)).toBe(true); expect(validHybridOptions({})).toBe(true)
    expect(validHybridOptions({ transport: 'native-module', penetrateHybrid: false, onReady: () => undefined, onError: () => undefined })).toBe(true)
  })
  it('counts UTF-8 bytes and validates bounded ASCII identifiers and counters', () => {
    expect(wireBytes('a中😀')).toBe(8)
    expect(asciiId('connection')).toBe(true); expect(asciiId('x'.repeat(128))).toBe(true)
    for (const id of ['', 'x'.repeat(129), '中文', 1]) expect(asciiId(id)).toBe(false)
    for (const counter of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) expect(positiveCounter(counter)).toBe(false)
    expect(positiveCounter(Number.MAX_SAFE_INTEGER)).toBe(true)
  })
  it('accepts an exact hello and optional DCloud version, with all five capabilities required', () => {
    expect(validateReply(helloReply(), hello, unimpResolved).kind).toBe('reply')
    const reply = helloReply()
    expect(validateReply({ ...reply, payload: { ...reply.payload, dcloudSdkVersion: '5.07', platform: 'iOS' } }, hello, unimpResolved).kind).toBe('reply')
  })
  it('returns an independent validated snapshot so later module mutation cannot change the known host gate', () => {
    const reply = helloReply(); const result = validateReply(reply, hello, unimpResolved)
    reply.payload.host.dataCollect = false
    expect(result).toMatchObject({ kind: 'reply', reply: { payload: { host: { dataCollect: true } } } })
  })
  it.each([
    { hostType: 'web' }, { appId: 'other' }, { accountId: 'other' }, { dataSourceId: 'other' }, { idMapping: false }, { platform: 'HarmonyOS' },
    { nativeSdkVersion: '' }, { nativeSdkVersion: 'x'.repeat(65) }, { nativeSdkVersion: 1 }, { dcloudSdkVersion: '' }, { dcloudSdkVersion: null },
    { identityWrite: 'true' }, { events: HYBRID_EVENTS.slice(1) }, { events: ['PAGE', 'PAGE', 'PAGE', 'PAGE', 'PAGE'] }, { events: ['future', ...HYBRID_EVENTS] },
    { events: 'PAGE' }, { host: null }, { host: { dataCollect: true, containerVisible: 1 } }, { host: { dataCollect: true, containerVisible: true, extra: true } }, { extra: true },
  ])('rejects mismatched or malformed hello payload %j', change => {
    const reply = helloReply()
    expect(validateReply({ ...reply, payload: { ...reply.payload, ...change } }, hello, unimpResolved).kind).toBe('invalid')
  })
  it.each([{ connectionId: '' }, { connectionId: '中' }, { status: 'accepted' }, { payload: null }, { version: 2 }, { extra: true }])('rejects matching malformed hello envelope %j', change => {
    expect(validateReply({ ...helloReply(), ...change }, hello, unimpResolved).kind).toBe('invalid')
  })
  it('ignores uncorrelated, non-JSON-object and accessor correlation fields without executing getters', () => {
    for (const reply of [null, [], 'reply', new Date(), { ...helloReply(), requestId: 2 }, { ...helloReply(), instanceId: 'other' }, { ...helloReply(), generation: 2 }]) {
      expect(validateReply(reply, hello, unimpResolved).kind).toBe('unrelated')
    }
    const getter = vi.fn(() => 1)
    const reply = { ...helloReply() }; Object.defineProperty(reply, 'requestId', { get: getter })
    expect(validateReply(reply, hello, unimpResolved).kind).toBe('unrelated'); expect(getter).not.toHaveBeenCalled()
  })
  it('rejects non-data, recursive, excessive, non-finite and accessor reply payloads safely', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const value of [cycle, new Date(), () => undefined, Symbol('x'), 1n, Infinity, new Array(50001).fill(1), 'x'.repeat(300000)]) {
      expect(validateReply({ ...helloReply(), extra: value }, hello, unimpResolved).kind).toBe('invalid')
    }
    const getter = vi.fn(() => true)
    const reply = { ...helloReply() }; Object.defineProperty(reply.payload, 'identityWrite', { enumerable: true, get: getter })
    expect(validateReply(reply, hello, unimpResolved).kind).toBe('invalid'); expect(getter).not.toHaveBeenCalled()
  })
  it('requires safe counters even in a fully correlated envelope', () => {
    expect(validateReply({ ...helloReply(), requestId: 0 }, { ...hello, requestId: 0 }, unimpResolved).kind).toBe('invalid')
    expect(validateReply({ ...helloReply(), generation: 0 }, { ...hello, generation: 0 }, unimpResolved).kind).toBe('invalid')
    expect(validateReply({ ...helloReply(), instanceId: '中' }, { ...hello, instanceId: '中' }, unimpResolved).kind).toBe('invalid')
  })
  it('requires operation-specific status and a current host gate on success', () => {
    expect(validateReply(accepted(), operation, unimpResolved).kind).toBe('reply')
    for (const change of [{ status: 'ok' }, { host: undefined }, { host: [] }, { extra: true }, { host: { dataCollect: true } }]) {
      expect(validateReply({ ...accepted(), ...change }, operation, unimpResolved).kind).toBe('invalid')
    }
    const identity: UniMPRequest = { ...header, connectionId: 'connection', method: 'clearUserId', payload: {} }
    expect(validateReply({ ...accepted(), status: 'ok' }, identity, unimpResolved).kind).toBe('reply')
    expect(validateReply(accepted(), identity, unimpResolved).kind).toBe('invalid')
    expect(validateReply({ ...accepted(), connectionId: 'old' }, operation, unimpResolved).kind).toBe('unrelated')
  })
  it('distinguishes correlated rejected and unknown results and rejects future / contradictory codes', () => {
    const rejected = { ...header, status: 'rejected', code: 'queue_full', connectionId: 'connection' }
    expect(validateReply(rejected, operation, unimpResolved).kind).toBe('reply')
    expect(validateReply({ ...rejected, code: 'collection_disabled', host: { dataCollect: false, containerVisible: true } }, operation, unimpResolved).kind).toBe('reply')
    for (const change of [{ code: 'future' }, { code: 'native_result_unknown' }, { code: 'collection_disabled' }, { code: 'collection_disabled', host: { dataCollect: true, containerVisible: true } }, { host: false }, { extra: true }]) {
      expect(validateReply({ ...rejected, ...change }, operation, unimpResolved).kind).toBe('invalid')
    }
    const { connectionId: _, ...helloRejected } = rejected
    expect(validateReply(helloRejected, hello, unimpResolved).kind).toBe('reply')
    expect(validateReply(rejected, hello, unimpResolved).kind).toBe('invalid')
    const unknown = { ...header, status: 'unknown', code: 'native_result_unknown', connectionId: 'connection' }
    expect(validateReply(unknown, operation, unimpResolved).kind).toBe('reply')
    expect(validateReply({ ...unknown, host: { dataCollect: true, containerVisible: false } }, operation, unimpResolved).kind).toBe('reply')
    for (const change of [{ code: 'queue_full' }, { host: 'true' }, { extra: true }]) expect(validateReply({ ...unknown, ...change }, operation, unimpResolved).kind).toBe('invalid')
  })
})
