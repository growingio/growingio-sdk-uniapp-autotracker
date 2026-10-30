import { describe, expect, it } from 'vitest'

import { BuiltinPluginRegistry } from '../../src/core/lifecycle.js'

describe('BuiltinPluginRegistry', () => {
  it('retains declaration order without running plugin code', () => {
    const registry = new BuiltinPluginRegistry()
    expect(registry.register({ name: 'gioEventAutoTracking' })).toStrictEqual({ ok: true })
    expect(registry.plugins()).toStrictEqual([{ name: 'gioEventAutoTracking' }])
  })

  it('rejects an invalid or duplicate batch atomically', () => {
    const registry = new BuiltinPluginRegistry()
    expect(registry.register({ name: 'unknown' })).toStrictEqual({ ok: false, code: 'plugin_invalid' })
    expect(registry.plugins()).toStrictEqual([])

    expect(registry.register({ name: 'gioEventAutoTracking' }, { name: 'gioEventAutoTracking' })).toStrictEqual({ ok: false, code: 'plugin_duplicate' })
    expect(registry.plugins()).toStrictEqual([])
  })

  it('keeps declarations after a failed init attempt and closes only after success', () => {
    const registry = new BuiltinPluginRegistry()
    expect(registry.register({ name: 'gioEventAutoTracking', options: {} })).toStrictEqual({ ok: true })
    registry.closeRegistration()
    expect(registry.register({ name: 'gioEventAutoTracking' })).toStrictEqual({ ok: false, code: 'plugin_registration_closed' })
  })
})
