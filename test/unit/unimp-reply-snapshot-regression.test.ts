import { afterEach, describe, expect, it, vi } from 'vitest'
import { HYBRID_EVENTS, HYBRID_MAX_BYTES, validateReply, type UniMPRequest } from '../../src/plugins/gioHybridAdapter/contract.js'
import { hybridFixture, hybridFlush, unimpResolved } from '../support/unimp-host.js'

const header = { version: 1 as const, requestId: 1, instanceId: 'runtime', generation: 1 }
const hello: UniMPRequest = { ...header, method: 'hello', payload: { appId: unimpResolved.appId, accountId: 'account', dataSourceId: 'source', idMapping: true, sdkVersion: '0.1.0' } }
const operation: UniMPRequest = { ...header, connectionId: 'connection', method: 'setUserId', payload: { userId: 'A' } }
const host = () => ({ dataCollect: false, containerVisible: true })
const rejected = () => ({ ...header, connectionId: 'connection', status: 'rejected', code: 'queue_full' })
const accepted = () => ({ ...header, connectionId: 'connection', status: 'ok', host: host() })
const helloReply = () => ({ ...header, connectionId: 'connection', status: 'ok', payload: {
  appId: unimpResolved.appId, accountId: 'account', dataSourceId: 'source', idMapping: true, hostType: 'native',
  platform: 'Android', nativeSdkVersion: '4.4.0', host: host(), events: [...HYBRID_EVENTS], identityWrite: true,
} })

function hide(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const data = value[key]
  delete value[key]
  Object.defineProperty(value, key, { value: data, configurable: true, writable: true })
  return value
}

afterEach(() => vi.useRealTimers())

describe('Native reply snapshot consistency', () => {
  it.each(['status', 'code', 'connectionId', 'requestId', 'instanceId', 'generation', 'version'])('rejects a non-enumerable required rejection field %s', key => {
    const reply = hide(rejected(), key)
    expect(Object.keys(reply)).not.toContain(key)
    expect(validateReply(reply, operation, unimpResolved)).toEqual({ kind: 'invalid' })
  })

  it.each(['payload', 'connectionId', 'status'])('rejects non-enumerable hello %s instead of returning an incomplete success', key => {
    expect(validateReply(hide(helloReply(), key), hello, unimpResolved)).toEqual({ kind: 'invalid' })
  })

  it.each(['dataCollect', 'containerVisible'])('rejects a hidden host gate field %s', key => {
    const reply = accepted()
    hide(reply.host, key)
    expect(validateReply(reply, operation, unimpResolved)).toEqual({ kind: 'invalid' })
  })

  it('uses own data instead of a Proxy get/toJSON trap that rewrites rejection to success', () => {
    const rewrite = vi.fn(() => ({ ...header, connectionId: 'connection', status: 'ok', host: host() }))
    const get = vi.fn((target: Record<string, unknown>, key: PropertyKey, receiver: unknown) => key === 'toJSON' ? rewrite : Reflect.get(target, key, receiver))
    const raw = new Proxy(rejected(), { get })
    expect(validateReply(raw, operation, unimpResolved)).toMatchObject({ kind: 'reply', reply: { status: 'rejected', code: 'queue_full' } })
    expect(get).not.toHaveBeenCalled()
    expect(rewrite).not.toHaveBeenCalled()
  })

  it('does not let Proxy get change the reported collection gate', () => {
    const get = vi.fn((target: Record<string, unknown>, key: PropertyKey, receiver: unknown) => key === 'host'
      ? { dataCollect: true, containerVisible: true } : Reflect.get(target, key, receiver))
    const raw = new Proxy(accepted(), { get })
    expect(validateReply(raw, operation, unimpResolved)).toMatchObject({ kind: 'reply', reply: { host: { dataCollect: false } } })
    expect(get).not.toHaveBeenCalled()
  })

  it.each(['requestId', 'instanceId', 'generation', 'connectionId'])('rechecks association if own descriptors change during capture (%s)', field => {
    let reads = 0
    const raw = new Proxy(accepted(), {
      getOwnPropertyDescriptor(target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
        if (key === field && ++reads > 1) return { ...descriptor, value: typeof descriptor!.value === 'number' ? 999 : 'other' }
        return descriptor
      },
    })
    expect(validateReply(raw, operation, unimpResolved)).toEqual({ kind: 'invalid' })
  })

  it('keeps unrelated malformed replies unrelated without reading or serializing their values', () => {
    const get = vi.fn(() => { throw Error('unrelated getter') })
    const raw = new Proxy(hide({ ...rejected(), requestId: 999 }, 'status'), { get })
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(validateReply(raw, operation, unimpResolved)).toEqual({ kind: 'unrelated' })
    expect(get).not.toHaveBeenCalled()
    expect(stringify).not.toHaveBeenCalled()
  })

  it('rejects toJSON accessors without executing them', () => {
    const getter = vi.fn(() => () => accepted())
    const raw = accepted()
    Object.defineProperty(raw, 'toJSON', { get: getter })
    expect(validateReply(raw, operation, unimpResolved)).toEqual({ kind: 'invalid' })
    expect(getter).not.toHaveBeenCalled()
  })

  it.each(['sparse', 'hole', 'oversized-string'] as const)('rejects %s input before expanding JSON', mode => {
    const reply = helloReply() as Record<string, unknown>
    reply.extra = mode === 'sparse' ? new Array(1_000_000) : mode === 'hole' ? new Array(5) : 'x'.repeat(HYBRID_MAX_BYTES + 1)
    const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors')
    const stringify = vi.spyOn(JSON, 'stringify')
    expect(validateReply(reply, hello, unimpResolved)).toEqual({ kind: 'invalid' })
    expect(stringify).not.toHaveBeenCalled()
    if (mode === 'sparse') expect(descriptors.mock.calls.some(([value]) => value === reply.extra)).toBe(false)
  })

  it('handles serialization failure and a non-object parsed result safely', () => {
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw Error('serializer failed') })
    expect(validateReply(accepted(), operation, unimpResolved)).toEqual({ kind: 'invalid' })
    stringify.mockRestore()
    for (const value of [null, [], 1, 'reply']) {
      vi.spyOn(JSON, 'parse').mockReturnValueOnce(value)
      expect(validateReply(accepted(), operation, unimpResolved)).toEqual({ kind: 'invalid' })
    }
  })

  it('retains an independent host gate after the module mutates the source object', () => {
    const reply = accepted()
    const result = validateReply(reply, operation, unimpResolved)
    reply.host.dataCollect = true
    expect(result).toMatchObject({ kind: 'reply', reply: { host: { dataCollect: false } } })
  })

  it('does not turn an identity rejection with hidden status into a successful identity result', async () => {
    vi.useFakeTimers()
    const fixture = hybridFixture()
    await fixture.connect(false)
    fixture.runtime.setUserId('A'); await hybridFlush()
    fixture.native.deliver(1, hide(fixture.native.rejected(1, 'queue_full') as Record<string, unknown>, 'status'))
    await hybridFlush()
    expect(fixture.runtime.failed()).toBe(true)
    expect(fixture.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_reply', method: 'setUserId', outcome: 'unknown' }))
    fixture.runtime.dispose()
  })

  it('retries an incomplete hello without resolving ready or throwing from its async callback', async () => {
    vi.useFakeTimers()
    const fixture = hybridFixture()
    fixture.runtime.onAppShow({ path: null, query: null })
    const ready = fixture.runtime.whenReady()
    const result = fixture.native.execute(0) as Record<string, unknown>
    fixture.native.deliver(0, hide(result, 'payload'))
    await hybridFlush()
    expect(fixture.runtime.ready()).toBe(false)
    expect(fixture.ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await ready).toBe(false)
    expect(fixture.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'handshake_timeout' }))
    fixture.runtime.dispose()
  })
})
