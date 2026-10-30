import { describe, expect, it } from 'vitest'

import { dispatchWithFinalizer, type TimerPort } from '../../src/core/uploader.js'
import type { TransportPort, TransportRequest, TransportResult } from '../../src/types/index.js'

const request: TransportRequest = { url: 'https://collector.example', method: 'POST', headers: {}, body: '[]', timeoutMs: 5_000 }

/** 提供可手动推进的定时器，验证超时、中止和重复回调的唯一结算。 */
function fakeTimer(): { timer: TimerPort; fire: () => void; cleared: () => boolean } {
  let callback: (() => void) | null = null
  let wasCleared = false
  return {
    timer: {
      setTimeout: (next) => { callback = next; return 1 },
      clearTimeout: () => { wasCleared = true },
    },
    fire: () => callback?.(),
    cleared: () => wasCleared,
  }
}

describe('dispatchWithFinalizer', () => {
  it.each(['cancel', 'timeout'] as const)('%s 结果先锁定，宿主 abort 的同步回调不能抢占完成结果', (action) => {
    const fake = fakeTimer()
    const results: TransportResult[] = []
    const finalized = dispatchWithFinalizer({ dispatch: (_request, done) => ({ abort: () => done({ kind: 'network', message: 'request:fail abort' }) }) }, fake.timer, request, result => results.push(result))
    if (action === 'cancel') finalized.cancel()
    else fake.fire()
    expect(results).toEqual([{ kind: action === 'cancel' ? 'aborted' : 'timeout' }])
  })

  it.each(['cancel', 'timeout'] as const)('%s 时宿主 abort 抛错仍只结算一次，迟到回调无效', (action) => {
    const fake = fakeTimer()
    const results: TransportResult[] = []
    let callback!: (result: TransportResult) => void
    const finalized = dispatchWithFinalizer({ dispatch: (_request, done) => {
      callback = done
      return { abort: () => { throw new Error('host abort failure') } }
    } }, fake.timer, request, result => results.push(result))
    if (action === 'cancel') finalized.cancel()
    else fake.fire()
    callback({ kind: 'success', status: 204 })
    callback({ kind: 'http', status: 500 })
    expect(results).toEqual([{ kind: action === 'cancel' ? 'aborted' : 'timeout' }])
    expect(fake.cleared()).toBe(true)
  })

  it('非 Error 宿主异常也归一为网络失败', () => {
    const results: TransportResult[] = []
    dispatchWithFinalizer({ dispatch: () => { throw 'offline' } }, fakeTimer().timer, request, result => results.push(result))
    expect(results).toEqual([{ kind: 'network', message: undefined }])
  })
  it('completes synchronous success once and clears its deadline', () => {
    const fake = fakeTimer()
    const results: TransportResult[] = []
    const transport: TransportPort = { dispatch: (_request, done) => { done({ kind: 'success', status: 204 }) } }
    dispatchWithFinalizer(transport, fake.timer, request, (result) => results.push(result))
    fake.fire()

    expect(results).toStrictEqual([{ kind: 'success', status: 204 }])
    expect(fake.cleared()).toBe(true)
  })

  it('times out once, aborts the host request, and ignores a late callback', () => {
    const fake = fakeTimer()
    const results: TransportResult[] = []
    let callback: ((result: TransportResult) => void) | undefined
    let aborted = 0
    const transport: TransportPort = {
      dispatch: (_request, done) => {
        callback = done
        return { abort: () => { aborted += 1 } }
      },
    }
    dispatchWithFinalizer(transport, fake.timer, request, (result) => results.push(result))
    fake.fire()
    callback?.({ kind: 'success', status: 200 })

    expect(aborted).toBe(1)
    expect(results).toStrictEqual([{ kind: 'timeout' }])
  })

  it('normalizes synchronous transport throws and supports best-effort cancellation', () => {
    const fake = fakeTimer()
    const results: TransportResult[] = []
    const transport: TransportPort = { dispatch: () => { throw new Error('offline') } }
    const finalized = dispatchWithFinalizer(transport, fake.timer, request, (result) => results.push(result))
    finalized.cancel()
    expect(results).toStrictEqual([{ kind: 'network', message: 'offline' }])
  })
})
