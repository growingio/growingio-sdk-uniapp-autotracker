import { describe, expect, it } from 'vitest'

import { buildCollectorRequest, isRetryableCollectorFailure, normalizeCollectorResult } from '../../src/core/uploader.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'

const event = { eventType: 'VISIT', deviceId: 'visitor' } as ProtocolEvent

describe('collector request contract', () => {
  it('constructs the exact POST URL, headers, body, and deadline', () => {
    expect(buildCollectorRequest('https://collector.example', 'account / id', [event], 123)).toStrictEqual({
      ok: true,
      request: {
        url: 'https://collector.example/v3/projects/account%20%2F%20id/collect?stm=123&compress=0',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify([event]),
        timeoutMs: 5_000,
      },
    })
  })

  it('rejects invalid send times and non-serializable event batches', () => {
    expect(buildCollectorRequest('https://collector.example', 'account', [event], Number.NaN)).toStrictEqual({ ok: false, code: 'invalid_send_time' })
    const cyclic: Record<string, unknown> = { eventType: 'VISIT' }
    cyclic.self = cyclic
    expect(buildCollectorRequest('https://collector.example', 'account', [cyclic as ProtocolEvent], 1)).toStrictEqual({ ok: false, code: 'events_not_serializable' })
  })

  it('accepts only 200/204 and retries only transient failures', () => {
    expect(normalizeCollectorResult({ kind: 'success', status: 200 })).toStrictEqual({ kind: 'success', status: 200 })
    expect(normalizeCollectorResult({ kind: 'success', status: 204 })).toStrictEqual({ kind: 'success', status: 204 })
    expect(normalizeCollectorResult({ kind: 'success', status: 201 })).toStrictEqual({ kind: 'http', status: 201 })
    expect(isRetryableCollectorFailure({ kind: 'network' })).toBe(true)
    expect(isRetryableCollectorFailure({ kind: 'timeout' })).toBe(true)
    expect(isRetryableCollectorFailure({ kind: 'http', status: 500 })).toBe(true)
    expect(isRetryableCollectorFailure({ kind: 'http', status: 400 })).toBe(false)
    expect(isRetryableCollectorFailure({ kind: 'unsupported' })).toBe(false)
  })
})
