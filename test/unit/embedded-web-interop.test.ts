import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrozenWebEmbeddedReceiver, type WebReceiverConfig } from '../fixtures/embedded-web-receiver.js'
import { appSystem, runtimeFixture } from '../support/runtime-fixture.js'
import { AppSystemContextPort } from '../../src/platform/system.js'

afterEach(() => vi.unstubAllGlobals())

const projectId = 'account'
const dataSourceId = 'source'
const publicRouting = ['giodatacollect', 'gioappid', 'giodatasourceid', 'gioprojectid'].sort()
const identityFields = ['giou', 'gios', 'giocs1', 'giouserkey', 'gionewdevice']
const cachedIdentity = { gioprojectid: projectId, giodatasourceid: dataSourceId, gioappid: 'example.app',
  giodatacollect: true, giou: 'old-device', gios: 'old-session', giocs1: 'old-user', giouserkey: 'old-key' }
const webConfig = (appId = 'example.app'): WebReceiverConfig => ({ projectId, appId, dataSourceId: 'web-source', dataCollect: true, platform: 'Web' })
const receive = (query: string, config = webConfig(), cached?: Record<string, unknown>) => new FrozenWebEmbeddedReceiver({ search: `?${query}`, hash: '' }, config, cached)

async function sdk(platform: 'Android' | 'iOS' | 'MinP') {
  const fixture = platform === 'MinP'
    ? runtimeFixture({ target: 'mp-weixin', systemContext: { load: async () => ({ ...appSystem, platform: 'MinP', domain: 'wx-test', deviceType: 'Weixin-Phone', operatingSystem: 'Weixin-Phone' }) } })
    : runtimeFixture({ systemContext: { load: async () => ({ ...appSystem, platform }) } })
  fixture.tracker.init({ accountId: projectId, dataSourceId, idMapping: true, ...(platform === 'MinP' ? { appId: 'wx-test' } : {}) })
  fixture.tracker.onAppShow({ path: 'pages/home', query: '' })
  await fixture.tracker.whenReady()
  fixture.tracker.setUserId('host-user', 'host-key')
  return { ...fixture, appId: platform === 'MinP' ? 'wx-test' : 'example.app' }
}

describe('getGioInfo compatibility with the frozen Web embedded receiver', () => {
  it.each([undefined, cachedIdentity])('preserves the receiver behavior that exposes the old bare stop marker defect (%j)', cached => {
    const receiver = receive('giodatacollect=false', webConfig(), cached)
    expect(receiver.initialize()).toBe(cached !== undefined)
    expect(receiver.qsFrom).toBe(cached === undefined ? 'none' : 'local')
    expect(receiver.config.dataCollect).toBe(true)
  })

  it.each(['Android', 'iOS', 'MinP'] as const)('stops a fresh H5 with only public routing fields for %s', async platform => {
    const { tracker, appId } = await sdk(platform)
    tracker.setDataCollect(false)
    const query = tracker.getGioInfo()!
    const values = new URLSearchParams(query)
    expect([...values.keys()].sort()).toEqual(publicRouting)
    expect(values.get('giodatacollect')).toBe('false')
    for (const key of identityFields) expect(values.has(key)).toBe(false)
    const receiver = receive(query, webConfig(appId))
    expect(receiver.initialize()).toBe(true)
    expect(receiver.qsFrom).toBe('search')
    expect(receiver.config.dataCollect).toBe(false)
    expect(receiver.commonContext.minpExtraParams).not.toHaveProperty('deviceId')
    expect(receiver.commonContext.minpExtraParams).not.toHaveProperty('sessionId')
  })

  it.each(['Android', 'iOS', 'MinP'] as const)('overrides a cached collecting identity without inheriting it for %s', async platform => {
    const { tracker, appId } = await sdk(platform)
    tracker.setDataCollect(false)
    const cached = { ...cachedIdentity, gioappid: appId }
    const receiver = receive(tracker.getGioInfo()!, webConfig(appId), cached)
    expect(receiver.initialize()).toBe(true)
    expect(receiver.qsFrom).toBe('search')
    expect(receiver.config.dataCollect).toBe(false)
    expect(receiver.config.dataSourceId).toBe(dataSourceId)
    for (const key of identityFields) expect(receiver.gqs).not.toHaveProperty(key)
    expect(cached.giou).toBe('old-device')
  })

  it.each([{ projectId: 'other-project' }, { appId: 'other-app' }])('does not claim an unrelated Web instance %j', async change => {
    const { tracker } = await sdk('Android')
    tracker.setDataCollect(false)
    const receiver = receive(tracker.getGioInfo()!, { ...webConfig(), ...change }, cachedIdentity)
    expect(receiver.initialize()).toBe(false)
    expect(receiver.qsFrom).toBe('search')
    expect(receiver.config.dataCollect).toBe(true)
    expect(receiver.growingIO.useEmbeddedInherit).toBe('')
    expect(receiver.config.dataSourceId).toBe('web-source')
  })

  it('inherits the configured host data source after project and app match', async () => {
    const { tracker } = await sdk('Android')
    tracker.setDataCollect(false)
    const receiver = receive(tracker.getGioInfo()!, { ...webConfig(), dataSourceId: 'different-web-source' })
    expect(receiver.initialize()).toBe(true)
    expect(receiver.config.dataSourceId).toBe(dataSourceId)
    expect(receiver.config.dataCollect).toBe(false)
  })

  it('restores collection with the current identity instead of a previously cached session', async () => {
    const { tracker, setNow } = await sdk('Android')
    tracker.setDataCollect(false)
    const stopped = Object.fromEntries(new URLSearchParams(tracker.getGioInfo()!))
    tracker.setUserId('new-user/😀&=%2F', 'new-key')
    setNow(2000)
    tracker.setDataCollect(true)
    const currentQuery = tracker.getGioInfo()!
    const currentSession = new URLSearchParams(currentQuery).get('gios')
    expect(currentSession).not.toBeNull()
    const receiver = receive(currentQuery, webConfig(), stopped)
    expect(receiver.initialize()).toBe(true)
    expect(receiver.config.dataCollect).toBe(true)
    expect(receiver.config.platform).toBe('Android')
    expect(receiver.commonContext.minpExtraParams).toMatchObject({ deviceId: 'generated-device', userId: 'new-user/😀&=%2F', userKey: 'new-key', sessionId: currentSession })
  })

  it('decodes routing configuration exactly once, including reserved and Unicode characters', async () => {
    const account = 'account/&=%2F😀'
    const source = 'source/&=%2F😀'
    const appId = 'example.app/&=%2F😀'
    const { tracker } = runtimeFixture({ systemContext: { load: async () => ({ ...appSystem, domain: appId }) } })
    tracker.init({ accountId: account, dataSourceId: source, dataCollect: false })
    await tracker.whenReady()
    const receiver = receive(tracker.getGioInfo()!, { projectId: account, appId, dataSourceId: 'web-source', dataCollect: true })
    expect(receiver.initialize()).toBe(true)
    expect(receiver.config).toMatchObject({ projectId: account, dataSourceId: source, dataCollect: false })
  })

  it.each(['android', 'ios', 'harmonyos'])('does not publish an unusable snapshot when %s has no native package identity', async platform => {
    vi.stubGlobal('plus', undefined)
    const systemContext = new AppSystemContextPort({
      getDeviceInfo: () => ({ platform }),
      getSystemInfoSync: () => ({}),
      getAppBaseInfo: () => ({}),
    }, '0.1.0', null)
    expect((await systemContext.load()).domain).toBe('')
    const { tracker } = runtimeFixture({ systemContext })
    tracker.init({ accountId: projectId, dataSourceId, appId: '__UNI__not-a-native-package' })
    tracker.onAppShow({ path: 'pages/home', query: '' })
    expect(await tracker.whenReady()).toBe(true)
    expect(tracker.queuedEvents()[0]).toMatchObject({ eventType: 'VISIT', deviceId: 'generated-device', sessionId: 'session-1' })
    expect(tracker.getGioInfo()).toBeNull()
    tracker.setDataCollect(false)
    expect(tracker.getGioInfo()).toBeNull()
  })
})
