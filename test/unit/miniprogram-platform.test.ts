import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeInitOptions } from '../../src/constants/config.js'
import { appCapabilityProfile, miniProgramCapabilityProfile } from '../../src/constants/platform.js'
import { MiniProgramSystemContextPort, matchesMiniProgramAppId, type MiniProgramHost } from '../../src/platform/miniprogram.js'
import { resolveRuntimeTarget, readHostRecord } from '../../src/platform/resolve.js'
import { AppStoragePort } from '../../src/platform/uni.js'
import { storageKeys } from '../../src/core/storage/index.js'
import { buildAppEvent, buildMiniProgramEvent } from '../../src/core/dataStore/protocol.js'
import { EventQueue } from '../../src/core/queue.js'
import { miniHost, miniTargets, miniCases } from '../support/miniprogram-host.js'

afterEach(() => vi.unstubAllGlobals())
const input = { accountId: 'account', dataSourceId: 'source', appId: 'fixture' }

describe.each(miniTargets)('%s platform and protocol', target => {
  it.each(['android', 'ios', 'devtools', 'harmonyos'])('selects the mini target independently of OS %s', platform => {
    const host = { getSystemInfoSync: () => ({ uniPlatform: target, platform }) }
    expect(resolveRuntimeTarget(host, undefined, {})).toBe(target)
    expect(resolveRuntimeTarget(host, target, {})).toBe(target)
    expect(resolveRuntimeTarget(host, 'app', {})).toBeNull()
  })
  it('normalizes mini defaults without changing App defaults or consuming mini-only App inputs', () => {
    expect(normalizeInitOptions(input, target)).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs: 300000 }, miniprogram: { target, appId: 'fixture', uploadIntervalMs: 1000 } } })
    expect(normalizeInitOptions({ ...input, keepAlive: 2, sessionExpires: 1, uploadInterval: 50 }, target)).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs: 120000, activityTimeoutMs: 60000 }, miniprogram: { uploadIntervalMs: 50 } } })
    expect(normalizeInitOptions({ ...input, keepAlive: 361, sessionExpires: 0.5 }, target)).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs: 21660000, activityTimeoutMs: 30000 } } })
    expect(normalizeInitOptions({ ...input, sessionExpires: 360 }, target)).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs: 300000, activityTimeoutMs: 21600000 } } })
    expect(normalizeInitOptions({ ...input, sessionExpires: -1 }, target).ok).toBe(true)
    const app = normalizeInitOptions({ ...input, keepAlive: null, uploadInterval: NaN })
    expect(app).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs: 30000 } } })
    if (app.ok) expect(app.config).not.toHaveProperty('miniprogram')
    expect(normalizeInitOptions({ ...input, sessionExpires: -1 })).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs: 30000 } } })
  })
  it.each([undefined, null, '', ' ', '__UNI__123', '\ud800'])('rejects invalid mini appId %s', appId => {
    expect(normalizeInitOptions({ ...input, appId }, target)).toEqual({ ok: false, code: 'invalid_app_id' })
  })
  it.each([[0, 0], [0.5, 30000], [1440, 86400000]])('preserves mini SDK keepAlive %s as %s ms', (keepAlive, timeoutMs) => {
    expect(normalizeInitOptions({ ...input, keepAlive }, target)).toMatchObject({ ok: true, config: { sessionPolicy: { timeoutMs } } })
  })
  it.each([null, -1, 1440.001, 1441, NaN, Infinity, Number.MAX_VALUE, '5'])('defaults invalid keepAlive %s', keepAlive => {
    expect(normalizeInitOptions({ ...input, keepAlive }, target)).toEqual(normalizeInitOptions(input, target))
  })
  it.each([null, 0, -2, NaN, Infinity, 360.001, 361, Number.MAX_VALUE, '1'])('disables activity timeout for invalid sessionExpires %s', sessionExpires => {
    expect(normalizeInitOptions({ ...input, sessionExpires }, target)).toEqual(normalizeInitOptions(input, target))
  })
  it.each([[0, 0], [0.4, 0], [0.5, 1], [50.5, 51], [3000, 3000], [3000.4, 3000], [3000.5, 1000]])('rounds mini SDK uploadInterval %s to %s ms', (uploadInterval, uploadIntervalMs) => {
    expect(normalizeInitOptions({ ...input, uploadInterval }, target)).toMatchObject({ ok: true, config: { miniprogram: { uploadIntervalMs } } })
  })
  it.each([null, -1, 3001, NaN, Infinity, 2147483648, '1000'])('defaults invalid uploadInterval %s', uploadInterval => {
    expect(normalizeInitOptions({ ...input, uploadInterval }, target)).toEqual(normalizeInitOptions(input, target))
  })
  it('reads actual appId and host version without requiring App-only methods', async () => {
    const fixture = miniHost(target)
    const config = normalizeInitOptions({ ...input, appId: fixture.appId }, target)
    if (!config.ok) throw new Error('invalid_fixture')
    const port = new MiniProgramSystemContextPort(fixture.host, config.config, '0.1.0')
    const context = await port.load()
    const { name, platform } = miniCases[target]
    expect(context).toMatchObject({ platform, domain: fixture.appId, platformVersion: `${name} 10.0`, deviceType: `${name}-Android`, screenWidth: 1170, screenHeight: 2532, appVersion: '1.2.0', language: 'zh_CN' })
    expect(context).not.toHaveProperty('appState')
    expect(matchesMiniProgramAppId(fixture.host, fixture.appId)).toBe(true)
    expect(matchesMiniProgramAppId(fixture.host, 'wrong')).toBe(false)
    const event = { ...context, eventSequenceId: 1, timestamp: 1, deviceId: 'device', sessionId: 'session', dataSourceId: 'source', timezoneOffset: '-480', path: 'pages/home', title: '首页', referralPage: 'external', appState: 'BACKGROUND', appName: 'wrong', orientation: 'PORTRAIT', protocolType: 'https' }
    for (const type of ['VISIT', 'PAGE', 'CUSTOM', 'LOGIN_USER_ATTRIBUTES', 'APP_CLOSED', 'VIEW_CLICK', 'VIEW_CHANGE']) {
      const built = buildMiniProgramEvent(type, { ...event, eventName: 'test', attributes: { a: '1' }, pageShowTimestamp: 1, xpath: 'id#save' })
      expect(built.ok).toBe(true)
      if (!built.ok) continue
      expect(built.event).not.toHaveProperty('appState')
      expect(built.event).not.toHaveProperty('appName')
      expect(built.event).not.toHaveProperty('orientation')
      expect(built.event).not.toHaveProperty('protocolType')
      expect(built.event.title).toBe('首页')
      expect('referralPage' in built.event).toBe(type === 'VISIT' || type === 'PAGE')
      expect(buildAppEvent(type, event).ok).toBe(false)
    }
    const valid = buildMiniProgramEvent('VISIT', event)
    if (!valid.ok) throw new Error('invalid_fixture')
    const queue = new EventQueue(undefined, buildMiniProgramEvent)
    queue.enqueue(valid.event)
    expect(queue.restore(queue.snapshot())).toBe(true)
    expect(new EventQueue().restore(queue.snapshot())).toBe(false)
    for (const invalid of [{ platform: 'Android' }, { deviceType: 'PHONE' }, { operatingSystem: 'wrong' }, { screenHeight: NaN }, { domain: '' }]) expect(buildMiniProgramEvent('VISIT', { ...event, ...invalid }).ok).toBe(false)
    expect(buildMiniProgramEvent('UNKNOWN', event).ok).toBe(false)
    expect(buildMiniProgramEvent('CUSTOM', { ...event, eventName: 'bad-event' }).ok).toBe(false)
    expect(buildMiniProgramEvent('VISIT', { ...event, timestamp: undefined }).ok).toBe(false)
    expect(buildMiniProgramEvent('PAGE', { ...event, eventSequenceId: null }).ok).toBe(false)
  })
  it.each(['ios', 'ohos', 'devtools', ''])('supports optional split metadata and safe system fallbacks for %s', async os => {
    const fixture = miniHost(target)
    const host: MiniProgramHost = { ...fixture.host, getDeviceInfo: () => ({ osName: os, deviceBrand: 'new-brand', deviceModel: 'new-model' }), getAppBaseInfo: () => ({ appId: '__UNI__WRONG', hostVersion: '12', hostLanguage: 'en' }), getWindowInfo: () => ({ pixelRatio: 2, screenWidth: 844, screenHeight: 390 }) }
    const config = normalizeInitOptions({ ...input, appVersion: '3.0' }, target)
    if (!config.ok) throw new Error('invalid_fixture')
    const context = await new MiniProgramSystemContextPort(host, config.config, '0.1.0').load()
    expect(context).toMatchObject({ appVersion: '3.0', screenWidth: 1688, screenHeight: 780, deviceBrand: 'new-brand', deviceModel: 'new-model' })
    expect(context.platformVersion).toContain('12')
    expect(context.domain).toBe('fixture')
  })
  it('tolerates throwing and absent optional metadata', async () => {
    const fixture = miniHost(target)
    const host: MiniProgramHost = { ...fixture.host, getDeviceInfo: () => { throw new Error('unsupported') }, getSystemInfoSync: () => { throw new Error('unsupported') }, getAccountInfoSync: undefined }
    const config = normalizeInitOptions(input, target)
    if (!config.ok) throw new Error('invalid_fixture')
    const context = await new MiniProgramSystemContextPort(host, config.config, '0.1.0').load()
    expect(context).toMatchObject({ appVersion: '', language: 'und', screenWidth: 0, screenHeight: 0, deviceBrand: 'UNKNOWN', deviceModel: 'UNKNOWN' })
    expect(matchesMiniProgramAppId(host, 'fixture')).toBe(true)
    expect(readHostRecord({ throwing: () => { throw new Error() } }, 'throwing')).toEqual({})
  })
  it('falls back from invalid split dimensions and pixel ratio to valid legacy fields', async () => {
    const f = miniHost(target)
    const host = { ...f.host, getWindowInfo: () => ({ pixelRatio: NaN, screenWidth: Infinity, screenHeight: -1 }), getDeviceInfo: () => ({ devicePixelRatio: 0 }) }
    const config = normalizeInitOptions(input, target)
    if (!config.ok) throw new Error('invalid_fixture')
    expect(await new MiniProgramSystemContextPort(host, config.config, '0.1.0').load()).toMatchObject({ screenWidth: 1170, screenHeight: 2532 })
    host.getWindowInfo = () => ({ pixelRatio: 3, screenWidth: Number.MAX_VALUE, screenHeight: Number.MAX_VALUE })
    expect(await new MiniProgramSystemContextPort(host, config.config, '0.1.0').load()).toMatchObject({ screenWidth: 0, screenHeight: 0 })
  })
  it('keeps production automatic interaction gates separate from verification and App', () => {
    expect(miniProgramCapabilityProfile(target).autoClick).toBe(false)
    expect(miniProgramCapabilityProfile(target, true).autoClick).toBe(true)
    expect(Object.values(miniProgramCapabilityProfile(target, true).autoChange).every(Boolean)).toBe(true)
    expect(appCapabilityProfile('Android')?.autoClick).toBe(false)
  })
})

describe('runtime target and storage isolation', () => {
  it('rejects unknown and conflicting targets without guessing from OS', () => {
    for (const uniPlatform of ['mp-lark', 'mp-dingtalk', 'mp-360', 'mp-harmony', 'mp-taobao', 'h5', 'web', 'toString']) expect(resolveRuntimeTarget({ getSystemInfoSync: () => ({ uniPlatform, platform: 'android' }) }, undefined, {})).toBeNull()
    expect(resolveRuntimeTarget({}, undefined, {})).toBeNull()
    expect(resolveRuntimeTarget({ getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }), getAppBaseInfo: () => ({ uniPlatform: 'mp-alipay' }) }, undefined, {})).toBeNull()
    for (const name of ['wx', 'my']) expect(resolveRuntimeTarget({}, undefined, { [name]: { request() {} } })).toBe(name === 'wx' ? 'mp-weixin' : 'mp-alipay')
    expect(resolveRuntimeTarget({}, undefined, { wx: { request() {} }, my: { request() {} } })).toBeNull()
    for (const hint of ['app', 'app-plus', 'app-harmony']) expect(resolveRuntimeTarget({}, hint, {})).toBe('app')
    const old = { getSystemInfoSync: () => ({}), getDeviceInfo: () => ({ platform: 'ios' }), getAppBaseInfo: () => ({}) }
    expect(resolveRuntimeTarget(old, undefined, {})).toBe('app')
    expect(resolveRuntimeTarget({ ...old, getDeviceInfo: () => ({ platform: 'devtools' }) }, undefined, {})).toBeNull()
    expect(resolveRuntimeTarget({ ...old, getDeviceInfo: () => ({}) }, undefined, {})).toBeNull()
    expect(readHostRecord({ value: () => null }, 'value')).toEqual({})
  })
  it('preserves App keys and separates account, appId, target and data source without collisions', async () => {
    expect(storageKeys('source').identity).toBe('gio:v1:source:identity')
    const scope = { target: 'mp-weixin', appId: 'a:b', accountId: 'account' }
    const keys = [storageKeys('source'), storageKeys('source', scope), storageKeys('source', { ...scope, appId: 'a', accountId: 'b:account' }), storageKeys('source', { ...scope, target: 'mp-alipay' }), storageKeys('source2', scope)]
    expect(new Set(keys.map(key => key.identity)).size).toBe(5)
    const { host } = miniHost('mp-weixin')
    const storage = new AppStoragePort(host, false)
    expect(await storage.read('queue', 'q')).toEqual({ kind: 'missing' })
    expect(await storage.write('queue', 'q', 'secret')).toEqual({ kind: 'ok' })
    expect(await storage.remove('queue', 'q')).toEqual({ kind: 'ok' })
    expect(host.getStorageSync).not.toHaveBeenCalled()
    expect(host.setStorageSync).not.toHaveBeenCalled()
    expect(host.removeStorageSync).not.toHaveBeenCalled()
  })
})
