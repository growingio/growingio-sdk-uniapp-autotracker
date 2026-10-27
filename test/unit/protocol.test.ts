import { describe, expect, it } from 'vitest'

import { buildAppEvent, normalizeAttributes, sanitizeOutboundEvent } from '../../src/core/dataStore/protocol.js'

const context = {
  deviceId: 'device', sessionId: 'session', dataSourceId: 'source', platform: 'Android',
  platformVersion: '14', timestamp: 1, domain: 'com.example', appState: 'FOREGROUND',
  appName: 'Example', networkState: 'WIFI', screenWidth: 0, screenHeight: 0,
  deviceBrand: 'UNKNOWN', deviceModel: 'UNKNOWN', deviceType: 'UNKNOWN', appVersion: '',
  language: 'und', timezoneOffset: '0', sdkVersion: '0.1.0',
}

describe('Protocol core', () => {
  it('超长 Unicode 属性只保留前 1000 码点，数组尾部非法值仍拒绝整项', () => {
    const prefix = `${'😀'.repeat(999)}中`
    const attributes = normalizeAttributes({ scalar: `${prefix}discarded`, list: [`${prefix}discarded`, false], invalid: [prefix, { nested: true }] })
    expect([...attributes.attributes]).toEqual([['scalar', prefix], ['list', prefix]])
    expect(attributes.diagnostics).toEqual(['attribute_invalid_value'])
  })

  it('sanitizes only wire-empty values and preserves zero plus string false', () => {
    expect(sanitizeOutboundEvent({ empty: '', nil: null, object: {}, list: [], zero: 0, falseText: 'false' })).toStrictEqual({
      zero: 0,
      falseText: 'false',
    })
  })

  it('normalizes supported attributes and isolates invalid entries', () => {
    const result = normalizeAttributes({ enabled: false, zero: 0, tags: ['a', null, 2], nested: { no: true }, bad: Number.NaN })
    expect([...result.attributes]).toStrictEqual([['enabled', 'false'], ['zero', '0'], ['tags', 'a||||2']])
    expect(result.diagnostics).toStrictEqual(['attribute_invalid_value', 'attribute_invalid_value'])
  })

  it('keeps the first key after Unicode-safe truncation', () => {
    const key = '😀'.repeat(101)
    const result = normalizeAttributes({ [key]: 'first', [`${'😀'.repeat(100)}x`]: 'second' })
    expect([...result.attributes.values()]).toStrictEqual(['first'])
    expect(result.diagnostics).toContain('attribute_key_collision')
  })

  it('builds a whitelisted event and removes unsupported or empty fields', () => {
    const result = buildAppEvent('VIEW_CHANGE', {
      ...context,
      eventSequenceId: 1,
      pageShowTimestamp: 2,
      xpath: 'page#change#switch',
      index: 0,
      hyperlink: 'should-not-leak',
      appVersion: '',
    })
    const { appVersion: _emptyAppVersion, ...nonEmptyContext } = context
    expect(result).toStrictEqual({
      ok: true,
      event: { ...nonEmptyContext, eventType: 'VIEW_CHANGE', eventSequenceId: 1, xpath: 'page#change#switch' },
    })
  })

  it.each([
    ['CUSTOM', { ...context, eventSequenceId: 1, eventName: '123bad' }, 'invalid_custom_event_name'],
    ['PAGE', { ...context, eventSequenceId: 1 }, 'missing_required_field'],
    ['OTHER', context, 'invalid_event_type'],
  ])('rejects %s when its contract is invalid', (eventType, fields, code) => {
    expect(buildAppEvent(eventType, fields)).toStrictEqual({ ok: false, code })
  })

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('rejects trailing line terminators in custom event names: %j', (ending) => {
    expect(buildAppEvent('CUSTOM', { ...context, eventSequenceId: 1, eventName: `valid${ending}` }))
      .toEqual({ ok: false, code: 'invalid_custom_event_name' })
  })

  it('rejects required values that sanitization would remove', () => {
    expect(buildAppEvent('VIEW_CLICK', {
      ...context, eventSequenceId: 1, xpath: '',
    })).toStrictEqual({ ok: false, code: 'missing_required_field' })
    expect(buildAppEvent('LOGIN_USER_ATTRIBUTES', {
      ...context, attributes: {},
    })).toStrictEqual({ ok: false, code: 'missing_required_field' })
  })
})
