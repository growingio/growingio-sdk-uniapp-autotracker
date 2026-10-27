import { describe, expect, it, vi } from 'vitest'
import { UniMPNativeModulePort, HybridPortFailure } from '../../src/platform/unimp-native-module.js'
import { hybridFixture, hybridFlush } from '../support/unimp-host.js'
import type { UniMPRequest } from '../../src/plugins/gioHybridAdapter/contract.js'

const request: UniMPRequest = { version: 1, requestId: 1, instanceId: 'test', generation: 1, method: 'hello', payload: { appId: 'a', accountId: 'p', dataSourceId: 'd', idMapping: false, sdkVersion: '0.1.0' } }
describe('Native module port', () => {
  it('loads lazily once and defers synchronous callbacks, then suppresses all work after disposal', async () => {
    const callbacks: ((reply: unknown) => void)[] = []
    const requireNativePlugin = vi.fn(() => ({ invoke: vi.fn((_request: unknown, done: (reply: unknown) => void) => { callbacks.push(done); done({ value: 1 }) }) }))
    const port = new UniMPNativeModulePort({ requireNativePlugin })
    const done = vi.fn()
    expect(requireNativePlugin).not.toHaveBeenCalled()
    port.request(request, done); expect(done).not.toHaveBeenCalled(); await hybridFlush()
    expect(done).toHaveBeenCalledWith({ value: 1 })
    port.request({ ...request, requestId: 2 }, done); await hybridFlush()
    expect(requireNativePlugin).toHaveBeenCalledOnce(); expect(requireNativePlugin).toHaveBeenCalledWith('GrowingIOUniMPBridge')
    port.request({ ...request, requestId: 3 }, done); port.dispose(); await hybridFlush()
    const count = done.mock.calls.length
    callbacks[0]!({ late: true }); port.request(request, done); await hybridFlush()
    expect(done).toHaveBeenCalledTimes(count)
  })
  it.each([undefined, null])('rejects missing module %s with a fixed code', module => {
    const port = new UniMPNativeModulePort({ requireNativePlugin: () => module })
    expect(() => port.request(request, vi.fn())).toThrowError(expect.objectContaining({ code: 'module_missing' }))
  })
  it('distinguishes missing API, loading exceptions, invalid module and invoke exception', () => {
    for (const host of [{}, { requireNativePlugin: () => { throw Error('private detail') } }]) {
      expect(() => new UniMPNativeModulePort(host).request(request, vi.fn())).toThrow(new HybridPortFailure('module_missing'))
    }
    expect(() => new UniMPNativeModulePort({ requireNativePlugin: () => ({ invoke: true }) }).request(request, vi.fn())).toThrow(new HybridPortFailure('invalid_module'))
    expect(() => new UniMPNativeModulePort({ requireNativePlugin: () => ({ invoke: () => { throw Error('private detail') } }) }).request(request, vi.fn())).toThrow(new HybridPortFailure('invoke_error'))
  })
  it.each(['module_missing', 'invalid_module', 'invoke_error'] as const)('reports %s once without retrying or exposing raw errors', async code => {
    vi.useFakeTimers()
    try {
      const f = hybridFixture({}, { port: { request: () => { throw new HybridPortFailure(code) }, dispose: () => undefined } })
      f.runtime.onAppShow({ path: null, query: null }); await hybridFlush(); await vi.advanceTimersByTimeAsync(10_000)
      expect(f.runtime.failed()).toBe(true)
      expect(f.error).toHaveBeenCalledExactlyOnceWith({ code, phase: 'handshake', method: 'hello', outcome: 'not_sent' })
      f.runtime.dispose()
    } finally { vi.useRealTimers() }
  })
  it('treats an exception after an operation may execute as unknown, blocking an identity intent', async () => {
    const f = hybridFixture()
    await f.connect(false)
    const original = f.native.request.bind(f.native)
    f.native.request = (request, done) => { if (request.method !== 'hello') throw Error('private'); original(request, done) }
    f.runtime.setUserId('A'); await hybridFlush()
    expect(f.runtime.failed()).toBe(true)
    expect(f.error).toHaveBeenCalledWith(expect.objectContaining({ code: 'invoke_error', method: 'setUserId', outcome: 'unknown' }))
    f.runtime.setDataCollect(true); f.native.reply(); await hybridFlush()
    expect(f.ready).toHaveBeenLastCalledWith(expect.objectContaining({ identityBlocked: true }))
    f.runtime.dispose()
  })
})
