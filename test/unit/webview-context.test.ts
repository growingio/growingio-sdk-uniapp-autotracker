import { describe, expect, it } from 'vitest'
import { readWebEmbeddedContext } from '../../src/plugins/gioEmbeddedAdapter/index.js'
import { FrozenWebEmbeddedReceiver } from '../fixtures/embedded-web-receiver.js'

const queryKey = 'gdp_query_string'
const firstVisitKey = 'gdp_embedded_new_device'
const time = Date.UTC(2026, 10, 10)
const sessionExpiresMs = 30 * 60_000
const config = { projectId: 'project', appId: 'wx-demo', embeddedAdapter: {}, sessionExpiresMs }
const routing = 'gioappid=wx-demo&gioprojectid=project&giodatasourceid=mini-source'
const hostQuery = `${routing}&gioplatform=MinP&giou=mini-device&gios=mini-S1&giocs1=mini-user&giouserkey=mini-key&giodatacollect=true&gionewdevice=true`
const storedQuery = {
  gioappid: 'wx-demo', gioprojectid: 'project', giodatasourceid: 'mini-source', gioplatform: 'MinP',
  giou: 'mini-device', gios: 'mini-S1', giocs1: 'mini-user', giouserkey: 'mini-key', giodatacollect: true,
}
const firstVisit = {
  projectId: 'project', appId: 'wx-demo', deviceId: 'mini-device', sessionId: 'mini-S1',
  newDevice: true, expiresAt: time + sessionExpiresMs,
}

function web(path: string, storage = new Map<string, string>(), userAgent = 'Mozilla/5.0') {
  const location = new URL(path, 'https://web.example.com')
  const history = {
    state: { scroll: 50 },
    replaceState(state: { scroll: number }, _title: string, url: string) {
      history.state = state
      location.href = new URL(url, location.href).href
    },
  }
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  }
  const browser = { location, history, navigator: { userAgent }, document: { title: 'H5' }, localStorage } as unknown as Window
  return { browser, location, history, storage, localStorage }
}

function cache(storage: Map<string, string>, key: string, value: unknown, expiredAt = time + 365 * 24 * 60 * 60_000) {
  storage.set(key, JSON.stringify({ value, expiredAt }))
}

describe('H5 WebView context', () => {
  it.each([{ embeddedAdapter: undefined }, { appId: undefined }])('requires an explicit adapter and appId (%j)', options => {
    const page = web(`/embedded?${hostQuery}`)
    expect(readWebEmbeddedContext(page.browser, { ...config, ...options }, () => time)).toBeNull()
    expect(page.location.search).toBe(`?${hostQuery}`)
    expect(page.storage.size).toBe(0)
  })

  it('decodes host values once and preserves business parameters and history state during URL cleanup', () => {
    const query = `${routing}&gioplatform=MinP&giou=mini-device&gios=mini-S1&giocs1=%E5%AE%BF%E4%B8%BB%252F&giouserkey=key%2B%3D%26&giodatacollect=TRUE&gionewdevice=true`
    const business = 'tag=a+b&next=a=b&tag=%2526&flag&gioBusiness=%E0'
    const page = web(`/embedded?${business}&${query}#/main?tab=2`)
    const context = readWebEmbeddedContext(page.browser, config, () => time)!
    expect(context).toMatchObject({ strict: false, dataSourceId: 'mini-source', deviceId: 'mini-device', sessionId: 'mini-S1',
      userId: '宿主%2F', userKey: 'key+=&', collecting: true, newDevice: true, dimensions: { domain: 'wx-demo', platform: 'MinP' } })
    expect(page.location.search).toBe(`?${business}`)
    expect(page.location.hash).toBe('#/main?tab=2')
    expect(page.history.state).toEqual({ scroll: 50 })
    expect(JSON.parse(page.storage.get(queryKey)!)).toMatchObject({ value: { giocs1: '宿主%2F', tag: '%2526', next: 'a=b' }, expiredAt: expect.any(Number) })
    expect(JSON.parse(page.storage.get(queryKey)!).value).not.toHaveProperty('gionewdevice')
    expect(JSON.parse(page.storage.get(firstVisitKey)!)).toMatchObject({ value: firstVisit, expiredAt: expect.any(Number) })
    const reloaded = readWebEmbeddedContext(page.browser, config, () => time)!
    expect(reloaded).toMatchObject({ userId: '宿主%2F', userKey: 'key+=&', newDevice: true })
  })

  it('selects the search snapshot ahead of an enabled hash snapshot and an existing cache', () => {
    const page = web(`/embedded?${hostQuery}#/route?${hostQuery.replace('mini-S1', 'hash-S')}`)
    cache(page.storage, queryKey, { ...storedQuery, gios: 'cached-S' })
    expect(readWebEmbeddedContext(page.browser, { ...config, hashtag: true }, () => time)?.sessionId).toBe('mini-S1')
  })

  it('uses the configured hash route and leaves its business parameters and search intact', () => {
    const page = web(`/embedded?search=keep#/route?item=one&${hostQuery}&item=two`)
    expect(readWebEmbeddedContext(page.browser, config, () => time)).toBeNull()
    const context = readWebEmbeddedContext(page.browser, { ...config, hashtag: true }, () => time)
    expect(context?.sessionId).toBe('mini-S1')
    expect(page.location.search).toBe('?search=keep')
    expect(page.location.hash).toBe('#/route?item=one&item=two')
  })

  it('honors rewriteQuery false and preserves identity strings that spell boolean values', () => {
    const query = `${routing}&giou=mini-device&gios=mini-S1&giocs1=true&giouserkey=false`
    const page = web(`/embedded?${query}`)
    const context = readWebEmbeddedContext(page.browser, { ...config, embeddedAdapter: { rewriteQuery: false } }, () => time)
    expect(context).toMatchObject({ userId: 'true', userKey: 'false', collecting: undefined })
    expect(page.location.search).toBe(`?${query}`)
  })

  it.each([['gioprojectid=project', 'gioprojectid=other'], ['gioappid=wx-demo', 'gioappid=wx-other']])('does not inherit an older matching cache when the fresh route mismatches %s', (expected, actual) => {
    const page = web(`/embedded?${hostQuery.replace(expected, actual)}`)
    cache(page.storage, queryKey, storedQuery)
    expect(readWebEmbeddedContext(page.browser, config, () => time)).toBeNull()
    expect(page.location.search).toContain(actual)
    expect(JSON.parse(page.storage.get(queryKey)!).value).toEqual(storedQuery)
  })

  it('restores the decoded Web 4.4.2 cache when the URL only contains incomplete routing', () => {
    const page = web('/embedded?gioprojectid=project&product=2')
    cache(page.storage, queryKey, storedQuery)
    cache(page.storage, firstVisitKey, firstVisit)
    expect(readWebEmbeddedContext(page.browser, config, () => time)).toMatchObject({
      dataSourceId: 'mini-source', deviceId: 'mini-device', sessionId: 'mini-S1', userId: 'mini-user', userKey: 'mini-key', newDevice: true,
    })
    expect(page.location.search).toBe('?gioprojectid=project&product=2')
  })

  it('writes a snapshot that the independent Web receiver can restore', () => {
    const page = web(`/embedded?${hostQuery}`)
    readWebEmbeddedContext(page.browser, config, () => time)
    const oldWeb = new FrozenWebEmbeddedReceiver({ search: '', hash: '' }, { ...config, dataSourceId: 'web-source', dataCollect: false },
      JSON.parse(page.storage.get(queryKey)!).value)
    expect(oldWeb.initialize()).toBe(true)
    expect(oldWeb.config).toMatchObject({ dataSourceId: 'mini-source', dataCollect: true })
    expect(oldWeb.commonContext.minpExtraParams).toMatchObject({ deviceId: 'mini-device', sessionId: 'mini-S1', userId: 'mini-user', userKey: 'mini-key' })
  })

  it('requires a mini-program WebView signal in strict mode and distinguishes explicit logout from missing fields', () => {
    const strict = { ...config, embeddedAdapter: { strict: true } }
    const path = `/embedded?${routing}&giou=&giocs1=`
    const ordinaryPage = web(path)
    expect(readWebEmbeddedContext(ordinaryPage.browser, strict, () => time)).toBeNull()
    expect(ordinaryPage.storage.size).toBe(0)
    const miniPage = web(path, new Map(), 'Mozilla/5.0 MicroMessenger miniProgram')
    expect(readWebEmbeddedContext(miniPage.browser, strict, () => time)).toMatchObject({ strict: true, deviceId: undefined,
      sessionId: undefined, userId: null, userKey: undefined })
    expect(readWebEmbeddedContext(web(`/embedded?${routing}`).browser, config, () => time)).toMatchObject({ userId: null, userKey: null })
  })

  it('ignores only optional inherited dimensions and accepts the mini-program extraParams key casing', () => {
    const page = web(`/embedded?${hostQuery}&giolanguage=zh-CN&gioscreenHeight=850&giodeviceModel=host-model&giooperatingSystem=host-os`)
    const context = readWebEmbeddedContext(page.browser, { ...config, embeddedAdapter: { ignoreFields: [
      'domain', 'platform', 'language', 'projectId', 'dataSourceId', 'dataCollect', 'deviceId', 'sessionId', 'userId', 'userKey',
    ] } }, () => time)!
    expect(context).toMatchObject({ dataSourceId: 'mini-source', deviceId: 'mini-device', sessionId: 'mini-S1', userId: 'mini-user', userKey: 'mini-key', collecting: true })
    expect(context.dimensions).toEqual({ deviceModel: 'host-model', operatingSystem: 'host-os', screenHeight: '850' })
  })

  it('restores a routing-only stop after cleanup without reusing a previous host identity', () => {
    const first = web(`/embedded?${hostQuery}`)
    const active = readWebEmbeddedContext(first.browser, config, () => time)!
    const stopped = web(`/embedded?${routing}&giodatacollect=false`, first.storage)
    const halted = readWebEmbeddedContext(stopped.browser, config, () => time)!
    expect(halted).toMatchObject({ routingOnly: true, collecting: false, dataSourceId: 'mini-source', deviceId: undefined, sessionId: undefined, newDevice: undefined })
    expect(stopped.location.search).toBe('')
    expect(active.ownsSession()).toBe(false)
    active.renew()
    expect(stopped.storage.has(firstVisitKey)).toBe(false)
    expect(readWebEmbeddedContext(stopped.browser, config, () => time)).toMatchObject({ collecting: false, routingOnly: true, deviceId: undefined })
  })

  it('accepts a full Mini Program 4.6.1 stop snapshot and invalidates collecting pages of the same session', () => {
    const first = web(`/embedded?${hostQuery}`)
    const active = readWebEmbeddedContext(first.browser, config, () => time)!
    const stopped = web(`/embedded?${hostQuery.replace('giodatacollect=true', 'giodatacollect=FALSE')}`, first.storage)
    expect(readWebEmbeddedContext(stopped.browser, config, () => time)).toMatchObject({ collecting: false, routingOnly: false, sessionId: 'mini-S1' })
    expect(active.ownsSession()).toBe(false)
  })

  it.each([false, true])('rejects renewal after another page took ownership, even if query cache is missing (%s)', removeQuery => {
    let now = time
    const first = web(`/embedded?${hostQuery}`)
    const original = readWebEmbeddedContext(first.browser, config, () => now)!
    const second = web(`/embedded?${hostQuery.replace('mini-S1', 'mini-S2').replace('gionewdevice=true', 'gionewdevice=false')}`, first.storage)
    const latest = readWebEmbeddedContext(second.browser, config, () => now)!
    if (removeQuery) first.storage.delete(queryKey)
    now += 60_000
    original.renew()
    expect(original.ownsSession()).toBe(false)
    expect(original.newDevice).toBe(false)
    expect(latest.ownsSession()).toBe(true)
    expect(JSON.parse(first.storage.get(firstVisitKey)!).value).toEqual({ ...firstVisit, sessionId: 'mini-S2', newDevice: false })
  })

  it('shares renewal for the same session and keeps an expired first-visit flag false', () => {
    let now = time
    const first = web(`/embedded?${hostQuery}`)
    const original = readWebEmbeddedContext(first.browser, config, () => now)!
    now += 20 * 60_000
    const second = readWebEmbeddedContext(first.browser, config, () => now)!
    second.renew()
    now += 11 * 60_000
    expect(original.newDevice).toBe(true)
    now = time + 50 * 60_000
    expect(original.newDevice).toBe(false)
    original.renew()
    expect(JSON.parse(first.storage.get(firstVisitKey)!).value).toEqual({ ...firstVisit, newDevice: false, expiresAt: now + sessionExpiresMs })
    expect(readWebEmbeddedContext(first.browser, config, () => now)?.newDevice).toBe(false)
  })

  it.each([true, { ...firstVisit, sessionId: 'other-session' }, { ...firstVisit, expiresAt: 'bad' }])('does not restore or migrate a first-visit record without valid matching ownership (%j)', record => {
    const page = web('/embedded')
    cache(page.storage, queryKey, storedQuery)
    cache(page.storage, firstVisitKey, record)
    const context = readWebEmbeddedContext(page.browser, config, () => time)!
    expect(context.newDevice).toBeUndefined()
    context.renew()
    expect(JSON.parse(page.storage.get(firstVisitKey)!).value).toEqual(record)
  })

  it('retains the fresh snapshot when browser storage is denied and does not remove the reload source', () => {
    const page = web(`/embedded?${hostQuery}`)
    Object.defineProperty(page.browser, 'localStorage', { get() { throw new Error('denied') } })
    const context = readWebEmbeddedContext(page.browser, config, () => time)!
    expect(context).toMatchObject({ deviceId: 'mini-device', newDevice: true })
    expect(context.ownsSession()).toBe(true)
    context.renew()
    expect(page.location.search).toBe(`?${hostQuery}`)
  })
})
