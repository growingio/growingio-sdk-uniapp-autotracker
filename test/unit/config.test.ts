import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeInitOptions } from '../../src/constants/config.js'
import { createAppTracker } from '../../src/platform/index.js'

const required = { accountId: ' account ', dataSourceId: ' source ' }

describe('normalizeInitOptions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('accepts ASCII collectors without URL or Unicode normalization support', () => {
    vi.stubGlobal('URL', undefined)
    const normalize = vi.spyOn(String.prototype, 'normalize').mockImplementation(() => { throw new Error('Unicode unavailable') })
    try {
      expect(normalizeInitOptions({ ...required, serverUrl: 'HTTP://COLLECTOR.EXAMPLE:3100' })).toMatchObject({
        ok: true, config: { serverUrl: 'http://collector.example:3100' },
      })
    } finally { normalize.mockRestore() }
  })

  it('uses the default collector safely when Unicode property escapes are unavailable', () => {
    vi.stubGlobal('URL', undefined)
    const NativeRegExp = RegExp
    vi.stubGlobal('RegExp', new Proxy(NativeRegExp, {
      construct(target, args) {
        if (String(args[0]).includes('\\p{')) throw new SyntaxError('Unicode properties unavailable')
        return Reflect.construct(target, args)
      },
    }))
    expect(normalizeInitOptions({ ...required, serverUrl: 'https://收集.example' })).toStrictEqual(normalizeInitOptions(required))
    expect(normalizeInitOptions({ ...required, serverUrl: 'https://COLLECTOR.EXAMPLE' })).toMatchObject({
      ok: true, config: { serverUrl: 'https://collector.example' },
    })
  })

  it.each([
    ['HTTPS://Collector.Example.com:443/', 'https://collector.example.com'],
    ['http://localhost:80', 'http://localhost'],
    ['collector.example.com:8443', 'https://collector.example.com:8443'],
    ['http://192.168.1.2:8080/', 'http://192.168.1.2:8080'],
    ['https://[2001:db8::1]:443/', 'https://[2001:db8::1]'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['https://收集.example', 'https://xn--wbv461i.example'],
    ['https://BÜCHER.example', 'https://xn--bcher-kva.example'],
    ['https://例え。テスト', 'https://xn--r8jz45g.xn--zckzah'],
    ['https://ｃｏｌｌｅｃｔｏｒ.example', 'https://collector.example'],
    ['http://127.1', 'http://127.0.0.1'],
    ['http://0x7f.0.0.1', 'http://127.0.0.1'],
    ['http://0177.0.0.1', 'http://127.0.0.1'],
    ['http://2130706433', 'http://127.0.0.1'],
    ['http://192.168.1.2.', 'http://192.168.1.2'],
    ['https://[::ffff:192.168.1.2]', 'https://[::ffff:192.168.1.2]'],
    ['http://0x', 'http://0.0.0.0'],
    ['https://faß.de', 'https://xn--fa-hia.de'],
    ['https://ΟΣ.example', 'https://xn--0xai.example'],
    ['https://e\u0301.example', 'https://xn--9ca.example'],
  ])('accepts App collector %s when the host has no global URL', (serverUrl, expected) => {
    vi.stubGlobal('URL', undefined)
    expect(normalizeInitOptions({ ...required, serverUrl })).toMatchObject({
      ok: true, config: { serverUrl: expected },
    })
  })

  it.each([
    'https://user:pass@collector.example.com', 'https://collector.example.com#x',
    'https://collector.example.com?x', 'https://collector.example.com//',
    'https://collector.example.com:65536', 'https://collector.example.com:abc',
    'https://collector.example.com\\evil', 'https://[1:2:3]', 'https://[1::2::3]',
    'https://[gg::1]', 'https://[::ffff:999.1.1.1]',
    'https://999.1.1.1', 'https://1.2.3.4.5', 'https://4294967296',
    'https://1.2.3.256', 'https://09', 'https://foo.1',
    'https://0xffffffffffffffffffff', 'https://1..2',
    'https://[::ffff:192.168.001.1]', 'https://[::ffff:1.2.3]',
    'https://\u0301example.com', 'https://\ud800.example',
    `https://${'中'.repeat(64)}.example`, `https://${'中a'.repeat(30)}.example`,
  ])('uses the default for invalid App collector %s without global URL', (serverUrl) => {
    vi.stubGlobal('URL', undefined)
    expect(normalizeInitOptions({ ...required, serverUrl })).toStrictEqual(normalizeInitOptions(required))
  })

  it.each(['https://收集.example', 'https://faß.de', 'https://ΟΣ.example', 'https://collector.example:', 'https://%63ollector.example'])('preserves the host URL implementation for legal origin %s', (serverUrl) => {
    const expected = new URL(serverUrl).origin
    expect(normalizeInitOptions({ ...required, serverUrl })).toMatchObject({ ok: true, config: { serverUrl: expected } })
  })

  it('does not let a failing host URL implementation fall back to weaker validation', () => {
    vi.stubGlobal('URL', class { constructor() { throw new Error('invalid') } })
    expect(normalizeInitOptions({ ...required, serverUrl: 'https://collector.example' })).toStrictEqual(normalizeInitOptions(required))
  })

  it('uses the default session duration when millisecond conversion would overflow', () => {
    expect(normalizeInitOptions({ ...required, sessionExpires: Number.MAX_VALUE })).toStrictEqual(normalizeInitOptions(required))
  })
  it.each(['\ud800', '\udc00', 'a\ud800b', '\ud83d\ude00\udc00'])('rejects unpaired UTF-16 in mandatory identifiers: %s', (value) => {
    expect(normalizeInitOptions({ ...required, accountId: value })).toStrictEqual({ ok: false, code: 'invalid_account_id' })
    expect(normalizeInitOptions({ ...required, dataSourceId: value })).toStrictEqual({ ok: false, code: 'invalid_data_source_id' })
  })

  it('preserves Chinese and paired supplementary characters in mandatory identifiers', () => {
    const result = normalizeInitOptions({ accountId: ' 中文😀 ', dataSourceId: ' 来源🚀 ' })
    expect(result).toMatchObject({ ok: true, config: { accountId: '中文😀', dataSourceId: '来源🚀' } })
    if (result.ok) expect(() => encodeURIComponent(result.config.accountId)).not.toThrow()
  })

  it.each(['accountId', 'dataSourceId'])('rejects malformed %s before reading or writing App ports', async (field) => {
    const access = vi.fn()
    const tracker = createAppTracker({
      getStorageSync: access, setStorageSync: access, removeStorageSync: access,
      getDeviceInfo: access, getSystemInfoSync: access, getAppBaseInfo: access,
      getNetworkType: access, request: access,
    }, { sdkVersion: '0.1.0', deviceIdFactory: () => 'device', sessionIdFactory: () => 'session' })
    expect(tracker.init({ ...required, [field]: '\ud800' })).toBe(false)
    expect(await tracker.whenReady()).toBe(false)
    expect(access).not.toHaveBeenCalled()
    expect(normalizeInitOptions({ ...required, [field]: '修正😀' })).toMatchObject({ ok: true })
  })
  it.each([[0.5, 30_000], [360, 21_600_000]])('normalizes every App-owned option with sessionExpires %s and drops appId', (sessionExpires, timeoutMs) => {
    expect(
      normalizeInitOptions({
        ...required,
        serverUrl: 'collector.example.com/',
        appId: 'web-only-id',
        appChannel: ' channel ',
        appVersion: ' 2.3.4 ',
        sessionExpires,
        dataCollect: false,
        idMapping: true,
        debug: true,
      }),
    ).toStrictEqual({
      ok: true,
      config: {
        accountId: 'account',
        dataSourceId: 'source',
        serverUrl: 'https://collector.example.com',
        appChannel: 'channel',
        appVersionFallback: '2.3.4',
        sessionPolicy: { timeoutMs },
        dataCollect: false,
        idMapping: true,
        debug: true,
      },
    })
  })

  it('uses only documented defaults', () => {
    expect(normalizeInitOptions(required)).toStrictEqual({
      ok: true,
      config: {
        accountId: 'account',
        dataSourceId: 'source',
        serverUrl: 'https://napi.growingio.com',
        appChannel: null,
        appVersionFallback: null,
        sessionPolicy: { timeoutMs: 30_000 },
        dataCollect: true,
        idMapping: false,
        debug: false,
      },
    })
  })

  it.each([
    [null, 'invalid_options'],
    [[], 'invalid_options'],
    [{}, 'invalid_account_id'],
    [{ accountId: 'a' }, 'invalid_data_source_id'],
    [{ ...required, accountId: '' }, 'invalid_account_id'],
    [{ ...required, dataSourceId: null }, 'invalid_data_source_id'],
    [{ ...required, runtime: 'unimp' }, 'invalid_options'],
  ])('rejects %o with %s and no partial configuration', (options, code) => {
    expect(normalizeInitOptions(options)).toStrictEqual({ ok: false, code })
  })

  it.each([
    { serverUrl: 'ftp://collector.example.com' },
    { serverUrl: 'https://collector.example.com/v3/projects/a/collect' },
    { serverUrl: 'https://collector.example.com?unsafe=true' },
    { serverUrl: '' }, { serverUrl: 1 },
    { sessionExpires: null }, { sessionExpires: -1 }, { sessionExpires: 0 },
    { sessionExpires: 360.001 }, { sessionExpires: 361 },
    { sessionExpires: Number.NaN }, { sessionExpires: Infinity }, { sessionExpires: '1' },
    { appChannel: 1 }, { appChannel: '\ud800' },
    { appVersion: null }, { appVersion: '' }, { appVersion: '   ' }, { appVersion: 42 }, { appVersion: {} }, { appVersion: '\udc00' },
    { dataCollect: 'false' }, { idMapping: 1 }, { debug: null }, { forceLogin: 'true' },
    { legacyMiniProgramIdentity: {} }, { runtime: 'unknown' },
  ])('defaults invalid optional input %o without failing initialization', options => {
    expect(normalizeInitOptions({ ...required, ...options })).toStrictEqual(normalizeInitOptions(required))
  })

  it('defaults only invalid fields and preserves explicit consent and other valid options', () => {
    expect(normalizeInitOptions({
      ...required, serverUrl: 'bad url', sessionExpires: -1, appChannel: 1,
      dataCollect: false, idMapping: true, debug: true, appVersion: ' 2.0 ',
    })).toMatchObject({
      ok: true,
      config: {
        serverUrl: 'https://napi.growingio.com', sessionPolicy: { timeoutMs: 30_000 },
        appChannel: null, dataCollect: false, idMapping: true, debug: true, appVersionFallback: '2.0',
      },
    })
  })

  it('allows a corrected retry because the normalizer does not preserve failed input', () => {
    expect(normalizeInitOptions({ ...required, accountId: '' })).toStrictEqual({
      ok: false,
      code: 'invalid_account_id',
    })
    expect(normalizeInitOptions({ ...required, serverUrl: 'https://collector.example.com' })).toMatchObject({
      ok: true,
      config: { serverUrl: 'https://collector.example.com' },
    })
  })
})
