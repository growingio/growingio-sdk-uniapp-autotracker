import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick, reactive } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AutoTrackCall } from '../../src/plugins/gioEventAutoTracking/contract.js'
import type { ProtocolEvent } from '../../src/core/dataStore/protocol.js'
import type { AppRuntimeHost } from '../../src/platform/index.js'
import type { TrackerRuntime } from '../../src/core/growingIO.js'
import { compileAutoTrackSfc, mountAutoTrackSfc } from '../support/autotrack-fixture.js'

type Hooks = {
  onLaunch(this: Record<string, unknown>, options: unknown): void
  onShow(this: Record<string, unknown>, options: unknown): void
  onHide(this: Record<string, unknown>): void
  onLoad(this: Record<string, unknown>, query: unknown): void
  onUnload(this: Record<string, unknown>): void
}
type Fixture = ReturnType<typeof mountAutoTrackSfc>
const fixtures: Fixture[] = []
afterEach(() => { fixtures.splice(0).forEach(fixture => fixture.unmount()); vi.unstubAllGlobals() })

/** 释放固定轮数的微任务，等待初始化和持久化等受控异步工作。 */
async function settle(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }

/** 装配真实 demo 组件与受控宿主，捕获实际协议事件用于场景验收。 */
async function demo(route: string, initialNetwork = 'wifi') {
  vi.resetModules()
  vi.stubGlobal('__GIO_AUTOTRACK_VERIFICATION__', true)
  vi.stubGlobal('gdp', undefined)
  vi.stubGlobal('document', { activeElement: null })
  const received: ProtocolEvent[] = []
  const storage = new Map<string, unknown>()
  let network = initialNetwork
  const host: AppRuntimeHost = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => { storage.set(key, value) },
    removeStorageSync: key => { storage.delete(key) },
    getDeviceInfo: () => ({ platform: 'android', devicePixelRatio: 3, brand: 'Demo', model: 'Demo' }),
    getSystemInfoSync: () => ({ screenWidth: 390, screenHeight: 844 }),
    getAppBaseInfo: () => ({ appName: 'Demo', appVersion: '1.0', packageName: 'com.example.demo' }),
    getNetworkType: options => { options.success({ networkType: network }) },
    // 有意不提供网络状态订阅，验证回前台时仍能恢复上传。
    request: options => {
      if (network === 'none') { options.fail({ errMsg: 'offline' }); return }
      received.push(...JSON.parse(options.data) as ProtocolEvent[])
      options.success({ statusCode: 204 })
    },
  }
  vi.stubGlobal('uni', host)
  const { default: gdp } = await import('../../index.js')
  const { dispatchAutoTrack } = await import('../../autotrack.js')
  // 测试仅借内部实例等待状态恢复，demo 页面仍使用公开命令。
  let tracker!: TrackerRuntime
  let hooks!: Hooks
  expect(gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }, { name: 'demo-test-readiness', install: instance => { tracker = instance } }])).toBe(true)
  expect(gdp('init', 'demo-account', 'demo-source', { idMapping: true, uniVue: { mixin: next => { hooks = next as unknown as Hooks } } })).toBe(true)
  hooks.onLaunch.call({}, { path: `pages/${route}/${route}` })
  hooks.onShow.call({}, { path: `pages/${route}/${route}` })
  const page = { $mpType: 'page', $page: { route: `pages/${route}/${route}` } }
  hooks.onLoad.call(page, {})
  hooks.onShow.call(page, {})
  await tracker.whenReady()
  await settle()
  const dataCollectionState = reactive({ enabled: true })
  let probeCount = 0
  const dispatch = (probe: unknown, event: unknown) => { probeCount++; return dispatchAutoTrack(probe as AutoTrackCall, event) }
  const source = readFileSync(resolve(import.meta.dirname, `../../demo/pages/${route}/${route}.vue`), 'utf8')
  const modules: Record<string, unknown> = {
    '../../sdk-state': { dataCollectionState },
  }
  for (const name of ['auto-track-script-setup', 'auto-track-setup-alias', 'uni-link', 'auto-track-boundary-emit']) {
    const componentSource = readFileSync(resolve(import.meta.dirname, `../../demo/components/${name}/${name}.vue`), 'utf8')
    modules[`@/components/${name}/${name}.vue`] = { default: compileAutoTrackSfc(componentSource, dispatch).component }
  }
  // uni-link 须挂载真实 navigator 并执行 emit，不能用原生标签替身跳过组件逻辑。
  const fixture = mountAutoTrackSfc(source, dispatch, modules, true, ['uni-link'])
  fixtures.push(fixture)
  expect(fixture.transformed.warnings).toEqual([])
  return { fixture, received, host, hooks, page, gdp, dataCollectionState, dispatch, probeCount: () => probeCount, setNetwork: (value: string) => { network = value } }
}

let eventSequence = 0
/** 依据当前渲染节点构造 dataset 和目标快照，避免使用过期静态元数据。 */
function nativeEvent(fixture: Fixture, id: string, name = 'onClick', detail: unknown = {}) {
  const node = fixture.elements().find(element => element.props.id === id)
  if (!node) throw new Error(`demo_control_missing:${id}`)
  const dataset = Object.fromEntries(Object.entries(node.props).filter(([key]) => key.startsWith('data-'))
    .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]))
  const target = { id, type: node.type, dataset }
  return { type: name.slice(2).toLowerCase(), timeStamp: eventSequence += 20, currentTarget: target, target, detail, stopPropagation: vi.fn(), preventDefault: vi.fn() }
}
/** 触发目标节点的真实监听器，并保留其业务返回结果。 */
function fireEvent(fixture: Fixture, id: string, name: string, event: unknown) {
  const node = fixture.elements().find(element => element.props.id === id)
  const handler = node?.props[name]
  if (typeof handler !== 'function') throw new Error(`demo_handler_missing:${id}:${name}`)
  return handler(event)
}
/** 按控件标识生成宿主事件后触发实际编译监听器。 */
function fire(fixture: Fixture, id: string, name = 'onClick', detail: unknown = {}) {
  return fireEvent(fixture, id, name, nativeEvent(fixture, id, name, detail))
}
/** 从接收事件中筛选指定业务事件名，供场景关联断言。 */
function named(events: ProtocolEvent[], name: string): ProtocolEvent[] { return events.filter(event => event.eventName === name) }

describe('实际 demo 页面中的修复场景', () => {
  it('括号箭头保留返回值，业务和自动事件各执行一次', async () => {
    const { fixture, received } = await demo('autotrack')
    expect(fire(fixture, 'arrow-grouped', 'onTap')).toBe(1)
    expect(fire(fixture, 'arrow-object', 'onTap')).toEqual({ saved: 2 })
    expect(fire(fixture, 'arrow-nested', 'onTap')).toBe(3)
    expect((fixture.instance as unknown as { actionCount: number }).actionCount).toBe(3)
    expect(received.filter(event => event.eventType === 'VIEW_CLICK').map(event => event.xpath)).toEqual([
      'arrow-grouped#onGroupedArrow', 'arrow-object#onObjectArrow', 'arrow-nested#onNestedArrow',
    ])
  })

  it('字符串和数字隐私标记都生效，敏感输入在读取值前被拦截', async () => {
    const { fixture, received } = await demo('autotrack')
    for (const id of ['track-string-one', 'track-number-one']) fire(fixture, id, 'onBlur', { value: 'demo-public-value' })
    let reads = 0
    const detail = { get value() { reads++; return 'demo-private-value' } }
    for (const id of ['sensitive-string-one', 'sensitive-number-one']) fire(fixture, id, 'onBlur', detail)
    for (const id of ['ignore-string-one', 'ignore-number-one']) fire(fixture, id, 'onTap')
    expect(reads).toBe(0)
    expect((fixture.instance as unknown as { actionCount: number }).actionCount).toBe(6)
    expect(received.filter(event => event.eventType.startsWith('VIEW_'))).toMatchObject([
      { eventType: 'VIEW_CHANGE', xpath: 'track-string-one#onInputComplete', textValue: 'demo-public-value' },
      { eventType: 'VIEW_CHANGE', xpath: 'track-number-one#onInputComplete', textValue: 'demo-public-value' },
    ])
    expect(JSON.stringify(received)).not.toContain('demo-private-value')
  })

  it.each(['identity-same', 'identity-different'])('%s 三步身份标记可核对真实会话边界', async id => {
    const { fixture, received } = await demo('user')
    const pagesBefore = received.filter(event => event.eventType === 'PAGE').length
    expect(fire(fixture, id)).toBe(true)
    const events = named(received, 'review_identity_step')
    expect(events).toHaveLength(3)
    expect(new Set(events.map(event => (event.attributes as Record<string, string>).runId)).size).toBe(1)
    expect(events.map(event => (event.attributes as Record<string, string>).phase)).toEqual(['login_a', 'logout', id === 'identity-same' ? 'login_a' : 'login_b'])
    expect(events.map(event => event.userId)).toEqual(['demo-review-user-a', undefined, id === 'identity-same' ? 'demo-review-user-a' : 'demo-review-user-b'])
    expect(events[0]?.sessionId).toBe(events[1]?.sessionId)
    if (id === 'identity-same') expect(events[2]?.sessionId).toBe(events[0]?.sessionId)
    else expect(events[2]?.sessionId).not.toBe(events[0]?.sessionId)
    expect(received.filter(event => event.eventType === 'PAGE')).toHaveLength(pagesBefore)
    expect(received.some(event => event.eventType === 'VIEW_CLICK')).toBe(false)
  })

  it('非法编码按钮拒绝参数并留下身份未改变的前后事件证据', async () => {
    const { fixture, received } = await demo('user')
    expect(fire(fixture, 'identity-invalid-utf16')).toBe(true)
    const events = named(received, 'review_identity_encoding')
    expect(events).toHaveLength(2)
    expect(events.every(event => event.userId === 'demo-review-user-a' && event.sessionId === events[0]?.sessionId)).toBe(true)
    expect(JSON.stringify(received)).not.toContain('\\ud800')
  })

  it('采集暂停期间无事件，恢复按钮重建 PAGE 时间且同步页面状态', async () => {
    let time = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    const { fixture, received, dataCollectionState } = await demo('datacollect')
    expect(fire(fixture, 'collection-pause')).toBe(true)
    expect(dataCollectionState.enabled).toBe(false)
    await nextTick()
    expect(fixture.elements().find(node => node.props.id === 'collection-pause')?.props.disabled).toBe(true)
    time = 15_000
    expect(fire(fixture, 'collection-resume')).toBe(true)
    expect(dataCollectionState.enabled).toBe(true)
    expect(named(received, 'review_collection_blocked')).toEqual([])
    const before = named(received, 'review_collection_before_pause')[0]!
    const resumed = named(received, 'review_collection_resumed')[0]!
    const page = received.filter(event => event.eventType === 'PAGE').at(-1)!
    expect(page.timestamp).toBe(15_000)
    expect(page.timestamp).toBeGreaterThan(before.timestamp as number)
    expect(resumed).toMatchObject({ timestamp: 15_000, sessionId: page.sessionId, path: page.path })
    expect(resumed).not.toHaveProperty('pageShowTimestamp')
    expect(resumed.sessionId).not.toBe(before.sessionId)
    expect(resumed.attributes).toMatchObject({ runId: (before.attributes as Record<string, string>).runId, pausedMs: '5000' })
    await nextTick()
    expect(fixture.elements().find(node => node.props.id === 'collection-resume')?.props.disabled).toBe(true)
    expect(received.some(event => event.eventType === 'VIEW_CLICK')).toBe(false)
  })

  it('采集关闭时身份场景停止并提示未完成，不继续切到另一个账号', async () => {
    const { fixture, gdp, received } = await demo('user')
    expect(gdp('setOptions', { dataCollect: false })).toBe(true)
    expect(fire(fixture, 'identity-different')).toBe(false)
    expect(named(received, 'review_identity_step')).toEqual([])
    expect((fixture.instance as unknown as { result: string }).result).toContain('login_a 停止')
    expect(gdp('setOptions', { dataCollect: true })).toBe(true)
    expect(gdp('track', 'confirm_partial_identity')).toBe(true)
    expect(named(received, 'confirm_partial_identity')[0]?.userId).toBe('demo-review-user-a')
  })

  it('离线启动且宿主缺少网络监听时，真实回前台路径恢复两条页面标记', async () => {
    const { fixture, received, hooks, setNetwork } = await demo('lifecycle', 'none')
    expect(fire(fixture, 'network-recovered')).toBe(false)
    expect(fire(fixture, 'network-offline')).toBe(true)
    expect(fire(fixture, 'network-offline')).toBe(false)
    expect(named(received, 'review_network_step')).toEqual([])
    hooks.onHide.call({})
    setNetwork('wifi')
    hooks.onShow.call({}, { path: 'pages/lifecycle/lifecycle' })
    await settle()
    expect(fire(fixture, 'network-recovered')).toBe(true)
    const events = named(received, 'review_network_step')
    expect(events).toHaveLength(2)
    expect(events.map(event => (event.attributes as Record<string, string>).phase)).toEqual(['offline', 'recovered'])
    expect((events[0]?.attributes as Record<string, string>).runId).toBe((events[1]?.attributes as Record<string, string>).runId)
    expect(events[1]?.networkState).toBe('WIFI')
    expect((fixture.instance as unknown as { networkResult: string }).networkResult).toContain('未确认网络或发送结果')
  })

  it('屏幕按钮展示物理像素证据，DPR=3 的手机仍为 PHONE', async () => {
    const { fixture, received } = await demo('lifecycle')
    expect(fire(fixture, 'screen-context')).toBe(true)
    expect(named(received, 'review_screen_context')).toMatchObject([
      { screenWidth: 1170, screenHeight: 2532, deviceType: 'PHONE', attributes: { logicalWidth: '390', logicalHeight: '844', devicePixelRatio: '3', expectedWidth: '1170', expectedHeight: '2532' } },
    ])
    expect((fixture.instance as unknown as { screenResult: string }).screenResult).toContain('1170 × 2532')
  })

  it('宿主读数异常或缺少 DPR 时明确提示无法核对，不发送推测值', async () => {
    const { fixture, received, host } = await demo('lifecycle')
    host.getDeviceInfo = () => { throw new Error('unavailable') }
    expect(fire(fixture, 'screen-context')).toBe(false)
    expect(named(received, 'review_screen_context')).toEqual([])
    expect((fixture.instance as unknown as { screenResult: string }).screenResult).toContain('无法独立核对')
  })

  it('隐私开关反复切换使用最新 dataset，ignore/sensitive 优先且不读取原文', async () => {
    const { fixture, received } = await demo('autotrack')
    const inputEvents = () => received.filter(event => event.xpath === 'privacy-dynamic-input#onInputComplete')
    fire(fixture, 'privacy-dynamic-click', 'onTap')
    fire(fixture, 'privacy-dynamic-input', 'onBlur', { value: 'not-authorized' })
    expect(inputEvents()).toHaveLength(1)
    expect(inputEvents()[0]).not.toHaveProperty('textValue')
    fire(fixture, 'privacy-track-toggle', 'onChange', { value: true })
    await nextTick()
    fire(fixture, 'privacy-dynamic-input', 'onBlur', { value: 'demo-allowed' })
    let reads = 0
    const privateDetail = { get value() { reads++; return 'demo-secret' } }
    for (const toggle of ['privacy-ignore-toggle', 'privacy-sensitive-toggle']) {
      fire(fixture, toggle, 'onChange', { value: true })
      await nextTick()
      fire(fixture, 'privacy-dynamic-click', 'onTap')
      fire(fixture, 'privacy-dynamic-input', 'onBlur', privateDetail)
      fire(fixture, toggle, 'onChange', { value: false })
      await nextTick()
    }
    fire(fixture, 'privacy-dynamic-click', 'onTap')
    fire(fixture, 'privacy-dynamic-input', 'onBlur', { value: 'demo-restored' })
    fire(fixture, 'privacy-track-toggle', 'onChange', { value: false })
    await nextTick()
    fire(fixture, 'privacy-dynamic-input', 'onBlur', privateDetail)
    expect(reads).toBe(0)
    expect(inputEvents().map(event => event.textValue)).toEqual([undefined, 'demo-allowed', 'demo-restored', undefined])
    expect(received.filter(event => event.xpath === 'privacy-dynamic-click#onDynamicPrivacyAction')).toHaveLength(2)
    expect(JSON.stringify(received)).not.toMatch(/demo-secret|not-authorized/)
  })

  it.each([0, 1, 2, 3])('禁用标记选项 %s 不开启 ignore/sensitive/track', async selected => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, 'false-marker-selector', 'onChange', { value: selected })
    await nextTick()
    fire(fixture, 'false-marker-click', 'onTap')
    fire(fixture, 'false-marker-input', 'onBlur', { get value() { throw new Error('未经允许不能读取') } })
    expect(received.filter(event => event.eventType.startsWith('VIEW_'))).toMatchObject([
      { eventType: 'VIEW_CLICK', xpath: 'false-marker-click#onDynamicPrivacyAction' },
      { eventType: 'VIEW_CHANGE', xpath: 'false-marker-input#onInputComplete' },
    ])
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE')[0]).not.toHaveProperty('textValue')
  })

  it('原生 picker 未返回有效下标时保留当前隐私标记选项', async () => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, 'false-marker-selector', 'onChange', { value: 2 })
    for (const value of [undefined, null, '', false, Number.NaN, -1, 4, 'invalid']) {
      fire(fixture, 'false-marker-selector', 'onChange', { value })
      expect((fixture.instance as unknown as { falseMarkerIndex: number }).falseMarkerIndex).toBe(2)
    }
    expect(received.some(event => event.eventType.startsWith('VIEW_'))).toBe(false)
  })

  it('备用原生点击入口可依次切换四种禁用标记，且自身不采集', async () => {
    const { fixture, received } = await demo('autotrack')
    for (const expected of [1, 2, 3, 0]) {
      fire(fixture, 'false-marker-next', 'onTap')
      expect((fixture.instance as unknown as { falseMarkerIndex: number }).falseMarkerIndex).toBe(expected)
    }
    expect(received.some(event => event.eventType.startsWith('VIEW_'))).toBe(false)
  })

  it('静态 password 与动态 type/password 在所有状态下都保守拦截', async () => {
    const { fixture, received } = await demo('autotrack')
    let reads = 0
    const detail = { get value() { reads++; return 'must-not-read' } }
    fire(fixture, 'password', 'onBlur', detail)
    for (const enabled of [false, true, false]) {
      fire(fixture, 'dynamic-type-toggle', 'onChange', { value: enabled })
      fire(fixture, 'dynamic-password-toggle', 'onChange', { value: enabled })
      await nextTick()
      fire(fixture, 'dynamic-type-input', 'onBlur', detail)
      fire(fixture, 'dynamic-password-input', 'onBlur', detail)
    }
    expect(reads).toBe(0)
    expect(received.some(event => event.eventType.startsWith('VIEW_'))).toBe(false)
  })

  it.each([
    ['input-change', 'onChange', 'onInputChange'],
    ['input-confirm', 'onConfirm', 'onInputConfirm'],
    ['textarea-confirm', 'onConfirm', 'onInputConfirm'],
  ])('%s 的独立完成事件可采集并执行业务一次', async (id, listener, method) => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, id, listener, { value: 'demo-completion' })
    expect((fixture.instance as unknown as { actionCount: number }).actionCount).toBe(1)
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE')).toMatchObject([
      { xpath: `${id}#${method}`, textValue: 'demo-completion' },
    ])
  })

  it.each([
    ['input-all-completions', ['onConfirm', 'onBlur'], { change: 0, blur: 1, confirm: 1 }],
    ['textarea-all-completions', ['onBlur'], { change: 0, blur: 1, confirm: 0 }],
  ] as const)('%s 在原生 change 缺失时仍采集一次完成事件', async (id, listeners, counts) => {
    const { fixture, received } = await demo('autotrack')
    for (const name of listeners) fire(fixture, id, name, { value: 'demo-native-completion' })
    expect((fixture.instance as unknown as { completionCounts: unknown }).completionCounts).toEqual(counts)
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE')).toMatchObject([
      { xpath: `${id}#onCompletionBlur`, textValue: 'demo-native-completion' },
    ])
  })

  it.each(['input-all-completions', 'textarea-all-completions'])('%s 只插桩 blur，但保留三个原生业务回调', async id => {
    const { fixture, received } = await demo('autotrack')
    for (const name of ['onBlur', 'onConfirm', 'onChange']) fire(fixture, id, name, { value: 'demo-three-events' })
    expect((fixture.instance as unknown as { completionCounts: unknown }).completionCounts).toEqual({ change: 1, blur: 1, confirm: 1 })
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE')).toMatchObject([
      { xpath: `${id}#onCompletionBlur`, textValue: 'demo-three-events' },
    ])
  })

  it('picker 字面量文案与动态下标回退都经过真实页面到协议', async () => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, 'picker-literal-string', 'onChange', { value: '1' })
    fire(fixture, 'picker-literal-object', 'onChange', { value: '1' })
    fire(fixture, 'picker-static-columns', 'onChange', { value: [1, 1] })
    fire(fixture, 'city', 'onChange', { value: '1' })
    fire(fixture, 'columns', 'onChange', { value: [1, 0] })
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE').map(event => event.textValue)).toEqual(['上海', '方案乙', '华南||下午', '1', '1||0'])
  })

  it('swiper 的文案回退、自动播放拦截及 track 放行下标都可验证', async () => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, 'banner', 'onChange', { current: 0, source: 'touch' })
    fire(fixture, 'banner', 'onChange', { current: 1, source: 'autoplay' })
    fire(fixture, 'tracked-autoplay-toggle', 'onTap')
    await nextTick()
    fire(fixture, 'banner-tracked', 'onChange', { current: 0, source: 'touch' })
    fire(fixture, 'banner-tracked', 'onChange', { current: 1, source: 'autoplay' })
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE').map(event => event.textValue)).toEqual(['轮播文案', '0', '1'])
    expect((fixture.instance as unknown as { trackedAutoplay: boolean }).trackedAutoplay).toBe(true)
  })

  it('长文本、特殊字符与清空操作只在真实完成事件时产生预期字段', async () => {
    const { fixture, received } = await demo('autotrack')
    const state = fixture.instance as unknown as { boundaryText: string; lastAction: string }
    for (const control of ['text-fill-long', 'text-fill-special', 'text-clear']) {
      const before = received.filter(event => event.eventType === 'VIEW_CHANGE').length
      fire(fixture, control, 'onTap')
      await nextTick()
      expect(received.filter(event => event.eventType === 'VIEW_CHANGE')).toHaveLength(before)
      fire(fixture, 'boundary-text', 'onBlur', { value: state.boundaryText })
      expect(state.lastAction).not.toContain(state.boundaryText || 'never-present')
    }
    const events = received.filter(event => event.eventType === 'VIEW_CHANGE')
    expect(events.map(event => event.textValue)).toEqual(['A'.repeat(100), '演示<&>"\' 第二行 内容', undefined])
    expect(events[2]).not.toHaveProperty('textValue')
  })

  it('取消全部多选仍生成事件且业务显示已清空', async () => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, 'tags', 'onChange', { value: ['A', 'B'] })
    fire(fixture, 'tags', 'onChange', { value: [] })
    expect(received.filter(event => event.eventType === 'VIEW_CHANGE').map(event => event.textValue)).toEqual(['A||B', undefined])
    expect((fixture.instance as unknown as { selectedTags: unknown; lastAction: string }).selectedTags).toEqual([])
    expect((fixture.instance as unknown as { lastAction: string }).lastAction).toContain('已全部取消')
  })

  it('列表复用节点在重排、修改元数据、增删和恢复后采集最新值', async () => {
    const { fixture, received } = await demo('autotrack')
    fire(fixture, 'sku-1', 'onTap')
    fire(fixture, 'list-reverse', 'onTap')
    await nextTick()
    fire(fixture, 'sku-1', 'onTap')
    const reused = fixture.elements().find(node => node.props.id === 'sku-2')
    fire(fixture, 'list-update', 'onTap')
    await nextTick()
    expect(fixture.elements().find(node => node.props.id === 'sku-2-r1')).toBe(reused)
    fire(fixture, 'sku-2-r1', 'onTap')
    fire(fixture, 'list-add', 'onTap')
    await nextTick()
    fire(fixture, 'sku-3', 'onTap')
    fire(fixture, 'list-remove', 'onTap')
    await nextTick()
    expect(fixture.elements().some(node => node.props.id === 'sku-2-r1')).toBe(false)
    fire(fixture, 'sku-3', 'onTap')
    fire(fixture, 'list-reset', 'onTap')
    await nextTick()
    fire(fixture, 'sku-1', 'onTap')
    expect(received.filter(event => event.eventType === 'VIEW_CLICK')).toMatchObject([
      { xpath: 'sku-1#onListAction', textValue: '商品一', index: 1 },
      { xpath: 'sku-1#onListAction', textValue: '商品一', index: 2 },
      { xpath: 'sku-2-r1#onListAction', textValue: '演示商品第 1 版', index: 1, hyperlink: '/pages/route/route?from=updated&revision=1' },
      { xpath: 'sku-3#onListAction', index: 3 },
      { xpath: 'sku-3#onListAction', index: 2 },
      { xpath: 'sku-1#onListAction', textValue: '商品一', index: 1 },
    ])
  })

  it('同一次冒泡的父子主目标不同，两个业务和事件都保留', async () => {
    const { fixture, received } = await demo('autotrack')
    const event = nativeEvent(fixture, 'bubble-child', 'onTap')
    fireEvent(fixture, 'bubble-child', 'onTap', event)
    event.currentTarget = nativeEvent(fixture, 'bubble-parent', 'onTap').currentTarget
    fireEvent(fixture, 'bubble-parent', 'onTap', event)
    expect((fixture.instance as unknown as { actionCount: number }).actionCount).toBe(2)
    expect(received.filter(event => event.eventType === 'VIEW_CLICK').map(event => event.xpath)).toEqual(['bubble-child#onBubbleChild', 'bubble-parent#onBubbleParent'])
  })

  it('重复探针去重，连续独立点击及页面返回仍保留', async () => {
    const { fixture, received, dispatch, hooks, page } = await demo('autotrack')
    const first = nativeEvent(fixture, 'repeat-action', 'onTap')
    fireEvent(fixture, 'repeat-action', 'onTap', first)
    expect(dispatch({ schemaVersion: 2, source: 'template', kind: 'click', eventName: 'onRepeatAction', elementType: 'button' }, first)).toBe(false)
    fire(fixture, 'repeat-action', 'onTap')
    fire(fixture, 'repeat-action', 'onTap')
    hooks.onHide.call(page)
    hooks.onShow.call(page, {})
    fireEvent(fixture, 'repeat-action', 'onTap', first)
    expect((fixture.instance as unknown as { actionCount: number }).actionCount).toBe(4)
    expect(received.filter(event => event.xpath === 'repeat-action#onRepeatAction')).toHaveLength(4)
  })

  it('关闭采集不影响点击/输入业务，恢复后 VIEW 关联新 PAGE', async () => {
    let time = 20_000
    vi.spyOn(Date, 'now').mockImplementation(() => time)
    const { fixture, received } = await demo('datacollect')
    fire(fixture, 'collection-pause')
    fire(fixture, 'collection-view-click')
    fire(fixture, 'collection-view-input', 'onBlur', { value: 'demo-disabled' })
    expect(received.some(event => event.eventType.startsWith('VIEW_'))).toBe(false)
    time = 25_000
    fire(fixture, 'collection-resume')
    await nextTick()
    fire(fixture, 'collection-view-click')
    fire(fixture, 'collection-view-input', 'onBlur', { value: 'demo-enabled' })
    const state = fixture.instance as unknown as { viewClickCount: number; viewInputCount: number }
    expect([state.viewClickCount, state.viewInputCount]).toEqual([2, 2])
    const views = received.filter(event => event.eventType.startsWith('VIEW_'))
    expect(views).toHaveLength(2)
    const page = received.filter(event => event.eventType === 'PAGE').at(-1)!
    expect(views.every(event => event.sessionId === page.sessionId && event.path === page.path)).toBe(true)
    expect(views[1]).toMatchObject({ textValue: 'demo-enabled', timestamp: 25_000 })
    for (const event of views) expect(event).not.toHaveProperty('pageShowTimestamp')
    expect(JSON.stringify(received)).not.toContain('demo-disabled')
  })

  it('uni-link 真实 navigator 与父组件监听执行两个探针，只产生一个事件', async () => {
    const { fixture, received, probeCount } = await demo('autotrack')
    const navigator = fixture.elements().find(node => node.type === 'navigator')!
    const handler = navigator.props.onClick as (event: unknown) => void
    expect(typeof handler).toBe('function')
    const before = probeCount()
    const target = { dataset: { title: 'uni-link 动态链接', src: '/pages/route/route?from=uni-link&case=dynamic' } }
    handler({ type: 'click', timeStamp: 100, currentTarget: target, target })
    expect(probeCount() - before).toBe(2)
    expect(received.filter(event => event.eventType === 'VIEW_CLICK')).toMatchObject([
      { xpath: '#openURL', hyperlink: '/pages/route/route?from=uni-link&case=dynamic' },
    ])
  })

  it('负向边界页无编译告警，真实组件 emit 和全部原业务回调仍执行', async () => {
    const { fixture, received } = await demo('autotrack-boundary')
    expect(fixture.transformed.warnings).toEqual([])
    for (const id of ['boundary-reference', 'boundary-computed', 'boundary-emit-inner']) fire(fixture, id, 'onTap')
    fire(fixture, 'boundary-dynamic', 'onClick')
    const stopped = nativeEvent(fixture, 'boundary-stop', 'onTap')
    fireEvent(fixture, 'boundary-stop', 'onTap', stopped)
    expect(stopped.stopPropagation).toHaveBeenCalledOnce()
    fire(fixture, 'boundary-input', 'onInput', { value: 'demo-typing' })
    expect((fixture.instance as unknown as { count: number }).count).toBe(6)
    expect(received.some(event => event.eventType.startsWith('VIEW_'))).toBe(false)
    expect(JSON.stringify(received)).not.toContain('demo-typing')
  })
})
