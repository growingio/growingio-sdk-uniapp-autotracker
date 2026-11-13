import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformAutoTrackSfc } from '../src/compiler/vite.js'
import { loadConfigFromFile } from 'vite'
import { MINI_PROGRAM_TARGETS } from '../src/constants/miniprogram.js'

const root = resolve(import.meta.dirname, '..')
const manifestTemplate = JSON.parse(readFileSync(resolve(root, 'demo/manifest.example.json'), 'utf8'))
assert.ok(!Object.hasOwn(manifestTemplate['app-harmony'].distribute, 'signingConfigs'), 'demo 模板必须将签名配置留在本机')
const required = [
  'demo/App.vue',
  'demo/miniprogram-config.ts',
  'autotrack.ts',
  'demo/vite.config.ts',
  'demo/pages/index/index.vue',
  'demo/pages/custom-event/custom-event.vue',
  'demo/pages/user/user.vue',
  'demo/pages/lifecycle/lifecycle.vue',
  'demo/pages/autotrack/autotrack.vue',
  'demo/components/auto-track-script-setup/auto-track-script-setup.vue',
  'demo/components/auto-track-setup-alias/auto-track-setup-alias.vue',
  'demo/components/uni-link/uni-link.vue',
  'demo/components/auto-track-boundary-emit/auto-track-boundary-emit.vue',
  'demo/pages/autotrack-boundary/autotrack-boundary.vue',
  'demo/pages/route/route.vue',
  'demo/pages/datacollect/datacollect.vue',
]

for (const file of required) {
  if (!existsSync(resolve(root, file))) throw new Error(`missing demo file: ${file}`)
}

const main = readFileSync(resolve(root, 'demo/main.ts'), 'utf8')
if (!main.includes("@/uni_modules/gio-uniapp-autotracker/index.js") || !main.includes("gdp('registerPlugins'") || !main.includes("gdp('init', 'demo-account', 'demo-source'") || !main.includes('uniVue: app') || main.includes('dataCollect: false')) {
  throw new Error('demo main.ts must use the gdp command entry, register autotracking, and start with collection enabled')
}
if (main.includes('deviceIdFactory') || main.includes('sessionIdFactory') || main.includes('createGioTracker')) {
  throw new Error('demo main.ts must not provide SDK-owned device, session, or host runtime internals')
}

const app = readFileSync(resolve(root, 'demo/App.vue'), 'utf8')
if (app.includes('createAppLifecycleBridge') || app.includes('createPageLifecycleBridge')) {
  throw new Error('demo App.vue must not contain SDK lifecycle bridge code')
}
for (const file of required.filter((file) => file.endsWith('.vue'))) {
  const source = readFileSync(resolve(root, file), 'utf8')
  if (source.includes('page-lifecycle') || source.includes("from '../../analytics'") || source.includes('$gio')) {
    throw new Error(`demo page must not import lifecycle or expose a tracker instance: ${file}`)
  }
  // App 构建会改写函数引用；计算成员调用只能回退原生事件名，是验收页唯一预期的提示。
  const expected = file === 'demo/pages/autotrack/autotrack.vue' ? 'event_name_fallback' : ''
  const warnings = transformAutoTrackSfc(source, undefined, { references: true }).warnings.map(warning => warning.code).join(', ')
  if (warnings !== expected) throw new Error(`demo must compile without unexpected collection warnings: ${file}: ${warnings}`)
}

for (const file of ['demo/main.ts', 'demo/vite.config.ts']) {
  const source = readFileSync(resolve(root, file), 'utf8')
  if (source.includes('../index.js') || source.includes('../vite.js')) {
    throw new Error(`demo must not import SDK source across the repository boundary: ${file}`)
  }
}

const vite = readFileSync(resolve(root, 'demo/vite.config.ts'), 'utf8')
const autoTrack = vite.indexOf('gioUniappAutoTrack')
const uni = vite.lastIndexOf('uniPlugin()')
if (autoTrack < 0 || uni < 0 || autoTrack > uni || !vite.includes('gioUniappAutoTrack()')) {
  throw new Error('demo Vite auto-track plugin must be configured before uni() with the compiled dispatcher import')
}
if (!vite.includes("./uni_modules/gio-uniapp-autotracker/vite.js")) {
  throw new Error('demo Vite config must import the compiled SDK package')
}

const compiledPackage = resolve(root, 'demo/uni_modules/gio-uniapp-autotracker')
for (const file of ['index.js', 'index.d.ts', 'vite.js', 'autotrack.js', 'package.json']) {
  if (!existsSync(resolve(compiledPackage, file))) throw new Error(`missing compiled SDK artifact: ${file}`)
}
if (/from\s+['"][^'"]+\.ts['"]/.test(readFileSync(resolve(compiledPackage, 'index.js'), 'utf8'))) {
  throw new Error('demo must consume compiled JavaScript, not TypeScript source')
}
const compiledTypes = readFileSync(resolve(compiledPackage, 'index.d.ts'), 'utf8')
if (!compiledTypes.includes('declare global') || !compiledTypes.includes('const gdp: GdpCommand')) {
  throw new Error('SDK root type entry must declare the global gdp command for application pages')
}
for (const declaration of ['interface GdpCommand', 'type GioGdpInitOptions', 'type GioUniVueApp', 'type GioAttributes', 'type GioPlugin']) {
  if (!compiledTypes.includes(declaration)) throw new Error(`SDK root type entry is missing customer declaration: ${declaration}`)
}

const pageConfig = JSON.parse(readFileSync(resolve(root, 'demo/pages.json'), 'utf8')) as Readonly<{ pages?: readonly { path?: unknown }[] }>
for (const route of ['custom-event', 'user', 'lifecycle', 'autotrack', 'route', 'datacollect', 'autotrack-boundary']) {
  if (!pageConfig.pages?.some((page) => page.path === `pages/${route}/${route}`)) throw new Error(`pages.json is missing ${route}`)
}

const configEnvironment = ['UNI_PLATFORM', 'UNI_INPUT_DIR', 'UNI_CLI_CONTEXT', 'UNI_OUTPUT_DIR'] as const
const previousEnvironment = Object.fromEntries(configEnvironment.map(key => [key, process.env[key]]))
process.env.UNI_INPUT_DIR = resolve(root, 'demo')
process.env.UNI_CLI_CONTEXT = resolve(root, 'demo')
process.env.UNI_OUTPUT_DIR = resolve(root, 'demo/unpackage/config-check')
try {
  for (const platform of [...MINI_PROGRAM_TARGETS, 'app', 'app-plus', 'app-harmony']) {
    process.env.UNI_PLATFORM = platform
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, resolve(root, 'demo/vite.config.ts'), resolve(root, 'demo'), 'silent')
    assert.ok(loaded, `demo Vite config failed to load: ${platform}`)
    if (platform.startsWith('mp-')) assert.equal(loaded.config.define?.__GIO_AUTOTRACK_VERIFICATION__, undefined, '小程序 demo 必须直接验证生产默认配置')
    else assert.equal(loaded.config.define?.__GIO_AUTOTRACK_VERIFICATION__, true, 'App demo 保持原验证配置')
  }
} finally {
  for (const key of configEnvironment) {
    if (previousEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = previousEnvironment[key]
  }
}

const autoTrackPage = readFileSync(resolve(root, 'demo/pages/autotrack/autotrack.vue'), 'utf8')
const transformed = transformAutoTrackSfc(autoTrackPage, '@/uni_modules/gio-uniapp-autotracker/autotrack.js', { references: true })
if (!transformed.changed || transformed.warnings.some(warning => warning.code !== 'event_name_fallback') || !transformed.code.includes('eventName:&quot;onReferenceAction&quot;') || !transformed.code.includes('dispatchAutoTrack as gioAutoTrack') || !transformed.code.includes('ignored:&quot;&quot;') || !transformed.code.includes('sensitive:true') || !transformed.code.includes('schemaVersion:2') || !transformed.code.includes('eventName:&quot;openURL&quot;') || transformed.code.includes('xpath:')) {
  throw new Error('auto-track showcase must compile without warnings to dispatcher calls that preserve ignore and sensitive markers')
}
for (const file of [
  'demo/components/auto-track-script-setup/auto-track-script-setup.vue',
  'demo/components/auto-track-setup-alias/auto-track-setup-alias.vue',
  'demo/components/uni-link/uni-link.vue',
  'demo/components/auto-track-boundary-emit/auto-track-boundary-emit.vue',
]) {
  const result = transformAutoTrackSfc(readFileSync(resolve(root, file), 'utf8'), '@/uni_modules/gio-uniapp-autotracker/autotrack.js')
  if (!result.changed || result.warnings.length > 0) throw new Error(`auto-track demo component must compile without warnings: ${file}`)
}
for (const marker of ['currentTarget 无 id', 'v-if 用例', 'v-show 用例', '<auto-track-script-setup', '<auto-track-setup-alias', 'data-growing-sensitive', '<uni-link', 'input-all-completions', 'privacy-ignore-toggle', 'bubble-child', 'picker-static-columns', 'banner-tracked', 'boundary-text', 'list-update', 'boundary-route', 'reference-action', 'computed-action', 'modifier-stop']) {
  if (!autoTrackPage.includes(marker)) throw new Error(`auto-track showcase is missing acceptance case: ${marker}`)
}

const boundary = transformAutoTrackSfc(readFileSync(resolve(root, 'demo/pages/autotrack-boundary/autotrack-boundary.vue'), 'utf8'))
if (!boundary.changed || boundary.warnings.length > 0) {
  throw new Error('auto-track boundary page must explicitly exclude unsupported listeners and compile without warnings')
}

console.log('demo showcase structure is valid')
