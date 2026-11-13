import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// SDK modules resolve exclusively from the installed/extracted delivery package.
const [sdkDirectory, compilerDirectory, target, verification = 'absent'] = process.argv.slice(2)
assert.ok(sdkDirectory && compilerDirectory && target)
assert.ok(['absent', 'false'].includes(verification))
if (verification === 'false') globalThis.__GIO_AUTOTRACK_VERIFICATION__ = false
else assert.equal('__GIO_AUTOTRACK_VERIFICATION__' in globalThis, false)
process.env.UNI_PLATFORM = target
const compilerFixture = mkdtempSync(join(tmpdir(), 'gio-mini-production-template-'))
process.on('exit', () => rmSync(compilerFixture, { recursive: true, force: true }))
writeFileSync(join(compilerFixture, 'manifest.json'), JSON.stringify({ name: 'production-consumer', appid: '__UNI__PRODUCTION', vueVersion: '3', [target]: { appid: 'production-fixture' } }))
writeFileSync(join(compilerFixture, 'pages.json'), JSON.stringify({ pages: [{ path: 'pages/home' }] }))
process.env.UNI_INPUT_DIR = compilerFixture
process.env.UNI_OUTPUT_DIR = join(compilerFixture, 'output')
const sdk = resolve(sdkDirectory)
const sdkMetadata = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'))
const runtimeImport = sdkMetadata.id ? `@/uni_modules/${sdkMetadata.id}/autotrack.js` : `${sdkMetadata.name}/autotrack`
const { default: gdp } = await import(pathToFileURL(join(sdk, 'index.js')).href)
const { dispatchAutoTrack } = await import(pathToFileURL(join(sdk, 'autotrack.js')).href)
const { gioUniappAutoTrack } = await import(pathToFileURL(join(sdk, 'vite.js')).href)
const compilerRequire = createRequire(join(resolve(compilerDirectory), 'package.json'))
const platformFile = compilerRequire.resolve(`@dcloudio/uni-${target}/dist/uni.compiler.js`)
const platformRequire = createRequire(platformFile)
let platformOptions
// Capture the real platform template options at the Vite-registration seam;
// the compiler, platform transforms, and Vue event invoker remain unmodified.
const registration = options => { platformOptions = options; return [] }
const load = name => name === '@dcloudio/uni-mp-vite'
  ? { ...platformRequire(name), default: registration, __esModule: true } : platformRequire(name)
const module = { exports: {} }
new Function('require', 'module', 'exports', '__filename', '__dirname', readFileSync(platformFile, 'utf8'))(load, module, module.exports, platformFile, dirname(platformFile))
assert.ok(platformOptions?.template)
const { compile } = platformRequire('@dcloudio/uni-mp-compiler')
const { parse } = platformRequire('@vue/compiler-sfc')
const { isMiniProgramNativeTag } = platformRequire('@dcloudio/uni-shared')
const runtime = platformRequire('@dcloudio/uni-mp-vue/dist/vue.runtime.esm.js')
const plugin = gioUniappAutoTrack()
const sent = [], hooks = [], stored = new Map(), business = []
let tracker, stamp = 0
globalThis.uni = {
  getSystemInfoSync: () => ({ uniPlatform: target, platform: 'ios', version: '10.0' }),
  getStorageSync: key => stored.get(key) ?? '',
  setStorageSync: (key, value) => stored.set(key, value), removeStorageSync: key => stored.delete(key),
  getNetworkType: options => options.success({ networkType: 'wifi' }),
  request: options => { assert.equal(options.dataType, 'text'); sent.push(...JSON.parse(options.data)); options.success({ statusCode: 204 }); options.complete() },
}
gdp('registerPlugins', [{ name: 'gioEventAutoTracking' }, { name: 'production-consumer', install: value => { tracker = value } }])
assert.equal(gdp('init', 'account', 'source', { uniVue: { mixin: value => hooks.push(value) }, appId: 'production-fixture', appVersion: '1.0.0', uploadInterval: 0 }), true)
const app = { $mpType: 'app' }, page = { $mpType: 'page', $scope: { route: 'pages/home' } }
hooks[0].onLaunch.call(app, { path: 'pages/home' }); hooks[0].onShow.call(app, { path: 'pages/home' })
hooks[0].onLoad.call(page, {}); hooks[0].onShow.call(page)
assert.equal(await tracker.whenReady(), true)

function listener(template, bindings = {}) {
  const sfc = `<template>${template}</template>`
  const transformed = plugin.transform.call({ warn: warning => { throw new Error(warning) } }, sfc, '/production.vue')
  assert.ok(transformed?.code)
  assert.ok(transformed.code.includes(JSON.stringify(runtimeImport)), 'compiled probe must reference this delivery channel dispatcher')
  const alias = transformed.code.match(/dispatchAutoTrack as (\w+)/)?.[1]
  assert.ok(alias)
  const scope = {}, errors = []
  const instance = { ctx: { $mpPlatform: target, $scope: scope }, $ei: 0, type: {}, parent: null,
    appContext: { config: { errorHandler: error => { errors.push(error) } } } }
  const compiled = compile(parse(transformed.code).descriptor.template.content, {
    ...platformOptions.template.compilerOptions, filename: '/production.vue', prefixIdentifiers: true, mode: 'module', isNativeTag: isMiniProgramNativeTag,
    miniProgram: { ...platformOptions.template, emitFile: () => {} },
  })
  const javascript = compiled.code.replace(/^import \{([^}]+)\} from "vue"\s*/gm,
    (_, names) => `const {${names.replace(/\s+as\s+/g, ':')}}=__runtime;\n`).replace('export function render', 'function render')
  const render = new Function('__runtime', `"use strict";${javascript};return render;`)(runtime)
  const save = function (...args) { business.push({ receiver: this, args }); return args[0] }
  runtime.setCurrentRenderingInstance(instance)
  try { render({ [alias]: dispatchAutoTrack, save, actions: { save }, options: ['zero', 'one'], ...bindings }, []) }
  finally { runtime.setCurrentRenderingInstance(null) }
  const invoker = Object.values(scope)[0]
  assert.equal(typeof invoker, 'function')
  return {
    compiled: compiled.code,
    fire(event) { const result = invoker(event); assert.deepEqual(errors, []); return result },
    direct(event) { return invoker.value(event) },
  }
}
function event(type, value, dataset = {}, extra = {}) {
  // Each call is a separate gesture; only the explicit duplicate test reuses an event.
  stamp += 20
  return { type, timeStamp: stamp, target: { id: 'control', dataset }, currentTarget: { id: 'control', dataset }, detail: { value, ...extra } }
}
const views = () => sent.filter(item => item.eventType === 'VIEW_CLICK' || item.eventType === 'VIEW_CHANGE')
const click = listener('<button id="control" @tap="actions.save"/>')
const tap = event('tap', undefined, { eventsync: true })
assert.equal(click.fire(tap), tap)
assert.equal(click.fire(tap), tap)
assert.equal(business.length, 2)
assert.equal(business[0].receiver, undefined)
assert.equal(views().length, 1, 'ordinary production build must emit one deduplicated VIEW_CLICK')
assert.equal(views()[0].xpath, 'control#actions.save')

for (const [template, type, value, expected, extra = {}] of [
  ['<input data-growing-track @blur="save($event)"/>', 'blur', 'allowed-input', 'allowed-input'],
  ['<textarea data-growing-track @blur="save($event)"/>', 'blur', 'allowed-textarea', 'allowed-textarea'],
  ['<switch data-growing-track @change="save($event)"/>', 'change', true, 'true'],
  ['<slider data-growing-track @change="save($event)"/>', 'change', 23, '23'],
  ['<radio-group data-growing-track @change="save($event)"/>', 'change', 'A', 'A'],
  ['<checkbox-group data-growing-track @change="save($event)"/>', 'change', ['A', 'B'], 'A||B'],
  ['<picker :range="options" data-growing-track @change="save($event)"/>', 'change', 1, 'one'],
  ['<picker-view data-growing-track @change="save($event)"><picker-view-column><view v-for="item in options">{{item}}</view></picker-view-column></picker-view>', 'change', [1], 'one'],
  ['<swiper data-growing-track @change="save($event)"/>', 'change', undefined, '1', { current: 1, source: 'touch' }],
]) {
  const before = views().length
  const fixture = listener(template)
  fixture.fire(event(type, value, { growingTrack: true, eventsync: true }, extra))
  assert.equal(views().length, before + 1, `${template}\n${fixture.compiled}`)
  assert.equal(views().at(-1).eventType, 'VIEW_CHANGE')
  assert.equal(views().at(-1).textValue, expected)
}
for (const attribute of ['password', 'password="false"']) {
  let reads = 0
  const fixture = listener(`<input ${attribute} data-growing-track @blur="save($event)"/>`)
  const native = event('blur', undefined, { growingTrack: true })
  Object.defineProperty(native.detail, 'value', { get() { reads++; return 'PRIVATE_SENTINEL' } })
  const before = views().length
  fixture.direct(native)
  assert.equal(reads, 0)
  assert.equal(views().length, before + 1)
  assert.equal('textValue' in views().at(-1), false)
}
for (const attribute of ['data-growing-ignore', 'data-growing-sensitive']) {
  const before = views().length
  let reads = 0
  const native = event('blur', undefined, { growingTrack: true })
  Object.defineProperty(native.detail, 'value', { get() { reads++; return 'PRIVATE_SENTINEL' } })
  listener(`<input ${attribute} data-growing-track @blur="save($event)"/>`).direct(native)
  assert.equal(views().length, before)
  assert.equal(reads, 0)
}
const unauthorized = listener('<input @blur="save($event)"/>')
unauthorized.fire(event('blur', 'PRIVATE_SENTINEL', { eventsync: true }))
assert.equal('textValue' in views().at(-1), false)
let privateReads = 0
const unicodePicker = listener('<picker :range="数据.items" data-growing-track @change="(数据)=>save(数据)"/>', { 数据: { items: ['zero', 'one'] } })
const unicodeEvent = event('change', 1, { growingTrack: true })
Object.defineProperty(unicodeEvent, 'items', { get() { privateReads++; return ['PRIVATE_SENTINEL'] } })
unicodePicker.direct(unicodeEvent)
assert.equal(privateReads, 0)
assert.equal(views().at(-1).textValue, 'one')
hooks[0].onTabItemTap.call(page, { index: 0, text: '首页', pagePath: 'pages/home' })
assert.equal(views().at(-1).xpath, '#onTabItemTap')
assert.equal(views().at(-1).index, 1)
assert.equal(gdp('setOptions', { dataCollect: false }), true)
const paused = views().length
click.fire(event('tap', undefined, { eventsync: true }))
assert.equal(views().length, paused)
assert.equal(gdp('setOptions', { dataCollect: true }), true)
click.fire(event('tap', undefined, { eventsync: true }))
assert.equal(views().length, paused + 1)
hooks[0].onHide.call(page)
click.fire(event('tap', undefined, { eventsync: true }))
assert.equal(views().length, paused + 1)
hooks[0].onHide.call(app)
assert.equal(JSON.stringify(sent).includes('PRIVATE_SENTINEL'), false)
assert.ok(views().every(item => item.domain === 'production-fixture' && item.path === 'pages/home'))
const platforms = { 'mp-weixin': 'MinP', 'mp-alipay': 'alip', 'mp-baidu': 'baidup', 'mp-toutiao': 'bytedance', 'mp-qq': 'qq', 'mp-kuaishou': 'kuaishoup', 'mp-jd': 'jdp', 'mp-xhs': 'xhsp' }
assert.ok(sent.every(item => item.platform === platforms[target] && item.dataSourceId === 'source'))
assert.equal(tracker.queuedEvents().length, 0)
console.log(`mini_production_autotrack_passed:${target}:${verification}:${views().length}_events`)
