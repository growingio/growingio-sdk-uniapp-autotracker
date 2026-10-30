import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HybridError } from '../../src/plugins/gioHybridAdapter/contract.js'
import type { UniMPRuntime } from '../../src/plugins/gioHybridAdapter/runtime.js'
import { hybridFixture, hybridFlush } from '../support/unimp-host.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('uniMP queued identity permission revocation', () => {
  it.each(['setUserId', 'clearUserId'] as const)('blocks an already accepted %s before dispatch or onError reentry', async method => {
    let runtime!: UniMPRuntime
    const read = vi.fn(() => 'private')
    const properties = Object.defineProperty({}, 'secret', { enumerable: true, get: read })
    const reentered: boolean[] = []
    const f = hybridFixture({ onError: () => { reentered.push(runtime.track('reentered', properties)) } })
    runtime = f.runtime
    await f.connect(false)
    expect(runtime.setUserAttributes({ plan: 'one' })).toBe(true)
    expect(method === 'setUserId' ? runtime.setUserId('queued-A', 'key') : runtime.clearUserId()).toBe(true)
    expect(runtime.track('must_drop')).toBe(true)
    await hybridFlush()
    f.native.identityWrite = false
    await f.accept()
    expect(f.native.calls.map(call => call.request.method)).toEqual(['hello', 'dispatchEvent'])
    expect(runtime.failed()).toBe(true)
    expect(runtime.setUserId('new-B')).toBe(false)
    expect(reentered).toEqual([false, false]); expect(read).not.toHaveBeenCalled()
    const errors = f.error.mock.calls.map(([error]) => error)
    expect(errors).toEqual([
      expect.objectContaining({ eventType: 'LOGIN_USER_ATTRIBUTES', outcome: 'rejected', code: 'identity_not_allowed', phase: 'dispatch' }),
      expect.objectContaining({ method, outcome: 'not_sent', code: 'identity_not_allowed', phase: 'queue', droppedCount: 2 }),
    ])
    expect(errors.some(error => error.outcome === 'unknown')).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.native.calls).toHaveLength(2)
    expect(f.error).toHaveBeenCalledTimes(2)
    runtime.dispose()
  })

  it('drops queued user attributes without identity blocking and preserves ordinary event FIFO', async () => {
    let runtime!: UniMPRuntime
    const reentered: boolean[] = []
    const f = hybridFixture({ onError: error => {
      if (error.outcome === 'rejected') reentered.push(runtime.track('from_error'))
    } })
    runtime = f.runtime
    await f.connect(false)
    runtime.setUserAttributes({ stage: 'inflight' })
    runtime.setUserAttributes({ stage: 'drop-one' })
    runtime.track('E1')
    runtime.setUserAttributes({ stage: 'drop-two' })
    runtime.track('E2')
    await hybridFlush()
    f.native.identityWrite = false
    await f.accept()
    expect(reentered).toEqual([true])
    for (let n = 0; n < 3; n++) await f.accept()
    expect(f.native.events.map(event => event.eventName)).toEqual(['E1', 'E2', 'from_error'])
    expect(f.native.calls.filter(call => call.request.method === 'dispatchEvent' && call.request.payload.event.eventType === 'LOGIN_USER_ATTRIBUTES')).toHaveLength(1)
    expect(f.error.mock.calls.map(([error]) => error)).toEqual([
      expect.objectContaining({ outcome: 'rejected', phase: 'dispatch', eventType: 'LOGIN_USER_ATTRIBUTES' }),
      expect.objectContaining({ outcome: 'not_sent', phase: 'queue', eventType: 'LOGIN_USER_ATTRIBUTES', droppedCount: 2 }),
    ])
    const read = vi.fn(() => 'private')
    expect(runtime.setUserAttributes(Object.defineProperty({}, 'secret', { enumerable: true, get: read }))).toBe(false)
    expect(read).not.toHaveBeenCalled(); expect(runtime.setUserId('B')).toBe(false)
    expect(runtime.ready()).toBe(true)
    runtime.dispose()
  })

  it('releases the pending attribute capacity and expiry timers immediately on revocation', async () => {
    const f = hybridFixture(); await f.connect(false)
    for (let n = 0; n < 50; n++) expect(f.runtime.setUserAttributes({ stage: n })).toBe(true)
    await hybridFlush()
    f.native.identityWrite = false
    await f.accept()
    expect(f.native.calls).toHaveLength(2)
    expect(f.error).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'not_sent', droppedCount: 49 }))
    for (let n = 0; n < 50; n++) expect(f.runtime.track(`new${n}`)).toBe(true)
    expect(f.runtime.track('over_capacity')).toBe(false)
    f.runtime.dispose()
    const count = f.error.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.error).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets onError explicitly reconnect but preserves blocking until a new identity succeeds', async () => {
    let runtime!: UniMPRuntime
    let restorePermission!: () => void
    const outcomes: HybridError['outcome'][] = []
    const f = hybridFixture({ onError: error => {
      outcomes.push(error.outcome)
      if (error.outcome === 'rejected') {
        restorePermission()
        expect(runtime.setDataCollect(true)).toBe(true)
        expect(runtime.setUserId('too_early')).toBe(false)
      }
    } })
    runtime = f.runtime; restorePermission = () => { f.native.identityWrite = true }
    await f.connect()
    await f.accept()
    runtime.setUserAttributes({ stage: 'inflight' }); runtime.setUserId('queued-A'); runtime.track('must_drop')
    await hybridFlush()
    f.native.identityWrite = false
    await f.accept()
    expect(outcomes).toEqual(['rejected', 'not_sent'])
    expect(f.native.calls.at(-1)?.request.method).toBe('hello')
    await f.accept()
    expect(f.ready).toHaveBeenLastCalledWith({ collecting: false, identityBlocked: true, canWriteIdentity: true })
    expect(runtime.track('still_blocked')).toBe(false)
    f.setWall(2000)
    expect(runtime.setUserId('confirmed-B')).toBe(true)
    await hybridFlush(); await f.accept()
    expect(runtime.track('safe')).toBe(true)
    await f.accept(); await f.accept()
    expect(f.native.events.filter(event => event.eventType === 'CUSTOM').map(event => [event.eventName, event.userId])).toEqual([['safe', 'confirmed-B']])
    const pages = f.native.events.filter(event => event.eventType === 'PAGE')
    expect(pages).toHaveLength(2); expect(pages[1]?.timestamp).toBe(2000)
    expect(f.native.calls.flatMap(call => call.request.method === 'setUserId' ? [call.request.payload.userId] : [])).toEqual(['confirmed-B'])
    runtime.dispose()
  })
})
