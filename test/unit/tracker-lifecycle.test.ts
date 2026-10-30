import { describe, expect, it } from 'vitest'

import { TrackerLifecycle } from '../../src/core/lifecycle.js'

const options = { accountId: 'account', dataSourceId: 'source' }

describe('TrackerLifecycle', () => {
  it('keeps plugin declarations after failed init and begins hydration only after valid config', () => {
    const lifecycle = new TrackerLifecycle()
    expect(lifecycle.registerPlugins({ name: 'gioEventAutoTracking' })).toBe(true)
    expect(lifecycle.init({ accountId: '', dataSourceId: 'source' })).toStrictEqual({ ok: false, code: 'invalid_config' })
    expect(lifecycle.status()).toBe('new')
    expect(lifecycle.registeredPlugins()).toStrictEqual([{ name: 'gioEventAutoTracking' }])

    expect(lifecycle.init(options)).toMatchObject({ ok: true, config: { accountId: 'account', dataSourceId: 'source' } })
    expect(lifecycle.status()).toBe('initializing')
    expect(lifecycle.registerPlugins({ name: 'gioEventAutoTracking' })).toBe(false)
  })

  it('permits exactly one successful init and exactly one ready transition', () => {
    const lifecycle = new TrackerLifecycle()
    lifecycle.init(options)
    expect(lifecycle.init(options)).toStrictEqual({ ok: false, code: 'already_initialized' })
    expect(lifecycle.markReady()).toBe(true)
    expect(lifecycle.markReady()).toBe(false)
    expect(lifecycle.status()).toBe('ready')
  })

  it('changes only dataCollect and flags false-to-true for lifecycle-owned session replay', () => {
    const lifecycle = new TrackerLifecycle()
    expect(lifecycle.setDataCollect(false)).toStrictEqual({ ok: false, changed: false, sessionRenewalRequired: false })
    lifecycle.init({ ...options, dataCollect: true })
    expect(lifecycle.setDataCollect(false)).toStrictEqual({ ok: true, changed: true, sessionRenewalRequired: false })
    expect(lifecycle.config()?.dataCollect).toBe(false)
    expect(lifecycle.setDataCollect(true)).toStrictEqual({ ok: true, changed: true, sessionRenewalRequired: true })
    expect(lifecycle.setDataCollect(true)).toStrictEqual({ ok: true, changed: false, sessionRenewalRequired: false })
    expect(lifecycle.setDataCollect('true')).toStrictEqual({ ok: false, changed: false, sessionRenewalRequired: false })
  })
})
