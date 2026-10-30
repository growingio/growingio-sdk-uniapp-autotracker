import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSystemContext, StoragePort } from '../../src/types/index.js'
import { dispatchAutoTrack, installAutoTrackDispatcher } from '../../src/plugins/gioEventAutoTracking/index.js'
import { createPageLifecycleBridge } from '../../src/adapters/uniapp.js'
import { TrackerRuntime } from '../../src/core/growingIO.js'
import { createMockCollector, type MockCollector } from '../support/mock-collector.js'
import { mountAutoTrackSfc, testAutoTrackProfile } from '../support/autotrack-fixture.js'
import type { AutoTrackCall } from '../../src/plugins/gioEventAutoTracking/contract.js'

const system: AppSystemContext = {
  platform: 'Android', platformVersion: '14', domain: 'com.example.app', appState: 'FOREGROUND', appName: 'Example',
  networkState: 'WIFI', screenWidth: 1080, screenHeight: 1920, deviceBrand: 'Google', deviceModel: 'Pixel',
  deviceType: 'PHONE', appVersion: '1.0.0', language: 'zh-CN', sdkVersion: '0.1.0',
}
/** 创建具备持久队列语义的内存存储端口，用于受控完整链路。 */
function storage(): StoragePort {
  const entries = new Map<string, string>()
  return {
    persistentQueue: true,
    read: async (_, key) => entries.has(key) ? { kind: 'value', value: entries.get(key) as string } : { kind: 'missing' },
    write: async (_, key, value) => { entries.set(key, value); return { kind: 'ok' } },
    remove: async (_, key) => { entries.delete(key); return { kind: 'ok' } },
  }
}
/** 提供稳定设备、时间和标识依赖，使报文断言可重复。 */
function trackerDependencies() {
  return {
    storage: storage(), systemContext: { load: async () => system }, clock: { now: () => 100 },
    timezone: { getOffsetMinutes: () => -480 }, deviceIdFactory: () => 'device-1', sessionIdFactory: () => 'session-1',
    orientation: () => 'PORTRAIT' as const,
  }
}
/** 注册并初始化 SDK，再建立 App 与首屏页面上下文。 */
async function show(tracker: TrackerRuntime) {
  tracker.registerPlugins({ name: 'gioEventAutoTracking' })
  tracker.init({ accountId: 'account', dataSourceId: 'source' })
  tracker.onAppShow({ path: '/home', query: '' })
  tracker.onPageLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
  tracker.onPageShow('home#1', null)
  await tracker.whenReady()
}
const collectors: MockCollector[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(collectors.splice(0).map((collector) => collector.close())) })

describe('SFC to mock collector pipeline', () => {
  it('keeps idless bubbling clicks, consent boundaries and removed value consent correct through compiled listeners and wire events', async () => {
    const received: Readonly<Record<string, unknown>>[] = []
    let now = 100
    let sessionNumber = 0
    const tracker = new TrackerRuntime({
      ...trackerDependencies(), autoTrackProfile: testAutoTrackProfile,
      clock: { now: () => now }, sessionIdFactory: () => `session-${++sessionNumber}`,
      upload: {
        runtime: { now: () => now, random: () => 0, setTimeout, clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
        transport: { dispatch: (request, done) => { received.push(...JSON.parse(request.body)); done({ kind: 'success', status: 204 }) } },
      },
    })
    await show(tracker)
    installAutoTrackDispatcher(tracker)
    const business = vi.fn(event => event)
    const fixture = mountAutoTrackSfc(`<script setup>import { business } from 'fixture'; const attributes = { 'data-growing-track': null }</script><template><view @tap="business($event)"><button @tap="business($event)"/></view><switch data-growing-track v-bind="attributes" @change="business($event)"/></template>`, (probe, event) => dispatchAutoTrack(probe as AutoTrackCall, event), { fixture: { business } })
    try {
      const child = { dataset: {} }
      const parent = { dataset: {} }
      const native = { type: 'tap', timeStamp: 100, currentTarget: child, target: child }
      fixture.fire(1, 'onTap', native)
      fixture.fire(1, 'onTap', native)
      native.currentTarget = parent
      fixture.fire(0, 'onTap', native)
      expect(received.filter(event => event.eventType === 'VIEW_CLICK')).toHaveLength(2)
      tracker.setDataCollect(false)
      now = 1_000
      tracker.setDataCollect(true)
      // 即使包装事件仍位于旧时间窗内，也应关联恢复后新建的 PAGE。
      fixture.fire(0, 'onTap', { ...native, timeStamp: 101 })
      const read = vi.fn(() => ({ value: true }))
      fixture.fire(0, 'onChange', { currentTarget: { dataset: {} }, get detail() { return read() } })
      expect(read).not.toHaveBeenCalled()
      const views = received.filter(event => typeof event.eventType === 'string' && event.eventType.startsWith('VIEW_'))
      expect(views).toMatchObject([
        { eventType: 'VIEW_CLICK', xpath: '#business', timestamp: 100, sessionId: 'session-1' },
        { eventType: 'VIEW_CLICK', xpath: '#business', timestamp: 100, sessionId: 'session-1' },
        { eventType: 'VIEW_CLICK', xpath: '#business', timestamp: 1_000, sessionId: 'session-2' },
        { eventType: 'VIEW_CHANGE', xpath: '#business', timestamp: 1_000, sessionId: 'session-2' },
      ])
      for (const event of received) expect(event).not.toHaveProperty('pageShowTimestamp')
      expect(views.at(-1)).not.toHaveProperty('textValue')
      expect(views.every(event => !('targetId' in event) && !('eventName' in event) && !('source' in event))).toBe(true)
      expect(business).toHaveBeenCalledTimes(5)
    } finally { fixture.unmount() }
  })
  it('executes compiled listeners through the production dispatcher, protocol and HTTP transport', async () => {
    const received: Readonly<Record<string, unknown>>[] = []
    const collector = await createMockCollector({ onAcceptedEvents: (events) => received.push(...events) })
    collectors.push(collector)
    const requests: Promise<unknown>[] = []
    const tracker = new TrackerRuntime({
      ...trackerDependencies(), autoTrackProfile: testAutoTrackProfile,
      upload: {
        runtime: { now: () => 100, random: () => 0, setTimeout, clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
        transport: { dispatch: (request, done) => {
          requests.push(fetch(request.url, { method: request.method, headers: request.headers, body: request.body })
            .then((response) => done({ kind: 'success', status: response.status })).catch(() => done({ kind: 'network' })))
        } },
      },
    })
    installAutoTrackDispatcher(tracker)
    tracker.registerPlugins({ name: 'gioEventAutoTracking' })
    tracker.init({ accountId: 'account', dataSourceId: 'source', serverUrl: collector.baseUrl })
    tracker.onAppShow({ path: '/home', query: '' })
    tracker.onPageLoad({ instanceId: 'home#1', route: 'pages/home/index', query: '', referralPage: null })
    tracker.onPageShow('home#1', null)
    await tracker.whenReady()
    const business = vi.fn((e) => e)
    const fixture = mountAutoTrackSfc(`<script setup>
      import { business } from 'fixture'
      const options = [{ label: 'first' }, { label: 'second' }]; const cities = ['杭州', '上海'];
      const items = [{ id:'sku-1', title:'one' }, { id:'sku-2', title:'two' }]; const link = '/docs';
      </script><template><view>
      <template v-for="(item, i) in items" :key="item.id"><button :id="item.id" :data-title="item.title" :data-index="i + 1" @tap="business($event)"/></template>
      <button @click="business($event)"/><input data-growing-track @blur="business($event)"/><input id="password" type="password" data-growing-track @blur="business($event)"/>
      <picker :range="options" range-key="label" data-growing-track @change="business($event)"/>
      <picker-view data-growing-track @change="business($event)"><picker-view-column><view v-for="city in cities">{{city}}</view></picker-view-column></picker-view>
      <switch data-growing-track @change="business($event)"/><swiper data-title="banner" @change="business($event)"/>
      <uni-link :href="link"/>
      </view></template>`, (probe, event) => dispatchAutoTrack(probe as AutoTrackCall, event), { fixture: { business } })
    try {
      const first = { type: 'tap', timeStamp: 100, currentTarget: { id: 'sku-1', dataset: { title: 'live one', index: '1' } } }
      expect(fixture.fire(0, 'onTap', first)).toBe(first)
      fixture.fire(0, 'onTap', first)
      fixture.fire(1, 'onTap', { type: 'tap', timeStamp: 101, currentTarget: { id: 'sku-2', dataset: { title: 'two', index: '2' } } })
      fixture.fire(0, 'onClick', { currentTarget: {}, target: { id: 'child' } })
      fixture.fire(0, 'onBlur', { currentTarget: { id: 'input' }, detail: { value: 0 } })
      fixture.fire(1, 'onBlur', { currentTarget: { id: 'password', dataset: { growingTrack: true } }, detail: { value: 'must-not-leak' } })
      fixture.fire(0, 'onChange', { currentTarget: { id: 'picker' }, detail: { value: 1 } })
      fixture.fire(1, 'onChange', { currentTarget: { id: 'cities' }, detail: { value: [0] } })
      fixture.fire(2, 'onChange', { currentTarget: { id: 'switch' }, detail: { value: false } })
      fixture.fire(3, 'onChange', { currentTarget: { id: 'banner' }, detail: { current: 0, source: 'touch' } })
      fixture.fire(3, 'onChange', { currentTarget: { id: 'banner' }, detail: { current: 1, source: 'autoplay' } })
      fixture.fire(1, 'onClick', { currentTarget: { dataset: { src: '/docs' } } })
      createPageLifecycleBridge(tracker, 'home#1').onTabItemTap({ index: 0, text: 'Home', pagePath: 'pages/home/index' })
      // 此完整链路用例验证 App 退后台时立即刷新的行为。
      // 并发、超时和退避等调度边界由受控定时器用例分别验证。
      expect(tracker.onAppHide()).toBe(true)
      await expect.poll(() => received.filter((event) => event.eventType === 'VIEW_CLICK' || event.eventType === 'VIEW_CHANGE').length).toBe(11)
      const views = received.filter((event) => event.eventType === 'VIEW_CLICK' || event.eventType === 'VIEW_CHANGE')
      expect(views).toEqual(expect.arrayContaining([
        expect.objectContaining({ xpath: 'sku-1#business', textValue: 'live one', index: 1 }),
        expect.objectContaining({ xpath: 'sku-2#business', textValue: 'two', index: 2 }),
        expect.objectContaining({ xpath: '#business' }),
        expect.objectContaining({ xpath: 'input#business', textValue: '0' }),
        expect.objectContaining({ eventType: 'VIEW_CHANGE', xpath: 'password#business' }),
        expect.objectContaining({ xpath: 'picker#business', textValue: '1' }),
        expect.objectContaining({ xpath: 'cities#business', textValue: '0' }),
        expect.objectContaining({ xpath: 'switch#business', textValue: 'false' }),
        expect.objectContaining({ xpath: 'banner#business', textValue: 'banner' }),
        expect.objectContaining({ xpath: '#openURL', hyperlink: '/docs' }),
        expect.objectContaining({ xpath: '#onTabItemTap', index: 1, hyperlink: 'pages/home/index' }),
      ]))
      expect(views.find(event => event.xpath === 'password#business')).not.toHaveProperty('textValue')
      expect(JSON.stringify(received)).not.toMatch(/must-not-leak|\/view\[|\/input\[|\/tabBar\[/)
      expect(views.every((event) => !('eventName' in event) && !('schemaVersion' in event) && !('source' in event))).toBe(true)
      expect(views.filter((event) => event.eventType === 'VIEW_CHANGE').every((event) => !('index' in event) && !('hyperlink' in event))).toBe(true)
      expect(business).toHaveBeenCalledTimes(11)
      expect(collector.requests.every((request) => request.accepted)).toBe(true)
    } finally {
      fixture.unmount()
      await Promise.all(requests)
    }
  })
  it('enforces readiness, plugin, page, consent and schema gates without leaking private diagnostics', async () => {
    const logs: string[] = []
    const tracker = new TrackerRuntime({ ...trackerDependencies(), autoTrackProfile: testAutoTrackProfile,
      logger: { debug: (message) => logs.push(message), info: () => {}, success: () => {}, warn: () => {}, error: () => {} } })
    const probe = { schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save' } as const
    expect(tracker.autoTrack(probe, {})).toBe(false)
    await show(tracker)
    expect(tracker.autoTrack({ schemaVersion: 1, kind: 'click', xpath: '/old' } as unknown as AutoTrackCall, {})).toBe(false)
    expect(tracker.autoTrack(probe, { currentTarget: { dataset: { growingIgnore: true } } })).toBe(false)
    tracker.setDataCollect(false)
    expect(tracker.autoTrack(probe, {})).toBe(false)
    tracker.setDataCollect(true)
    const native = { type: 'tap', timeStamp: 10 }
    expect(tracker.autoTrack(probe, native)).toBe(true)
    expect(tracker.autoTrack(probe, native)).toBe(false)
    tracker.onPageHide('home#1')
    expect(tracker.autoTrack(probe, {})).toBe(false)
    tracker.onPageShow('home#1', null)
    expect(tracker.autoTrack(probe, native)).toBe(true)
    expect(logs).toEqual([])
    const noPlugin = new TrackerRuntime({ ...trackerDependencies(), autoTrackProfile: testAutoTrackProfile })
    noPlugin.init({ accountId: 'account', dataSourceId: 'source' })
    await noPlugin.whenReady()
    expect(noPlugin.autoTrack(probe)).toBe(false)
  })
  it('allows a demo verification build without changing its production acceptance status', async () => {
    vi.stubGlobal('__GIO_AUTOTRACK_VERIFICATION__', true)
    const tracker = new TrackerRuntime(trackerDependencies())
    await show(tracker)
    expect(tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save' })).toBe(true)
    expect(tracker.queuedEvents().at(-1)).toMatchObject({ eventType: 'VIEW_CLICK', xpath: '#save' })
  })

  it.each(['Android', 'iOS', 'HarmonyOS'] as const)('keeps unverified %s capabilities disabled in the real runtime', async (platform) => {
    const tracker = new TrackerRuntime({ ...trackerDependencies(), systemContext: { load: async () => ({ ...system, platform }) } })
    await show(tracker)
    expect(tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save' })).toBe(false)
    expect(tracker.autoTrack({ schemaVersion: 2, source: 'template', kind: 'change', eventName: 'save', elementType: 'switch' })).toBe(false)
    expect(createPageLifecycleBridge(tracker, 'home#1').onTabItemTap({ index: 0 })).toBe(false)
    expect(tracker.queuedEvents().map((event) => event.eventType)).toEqual(['VISIT', 'PAGE'])
  })
})
