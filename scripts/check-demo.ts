import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformAutoTrackSfc } from '../src/compiler/vite.js'

const root = resolve(import.meta.dirname, '..')
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
  const warnings = transformAutoTrackSfc(source).warnings
  if (warnings.length > 0) throw new Error(`demo must compile without collection warnings: ${file}: ${warnings.map(warning => warning.code).join(', ')}`)
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

const viteConfig = readFileSync(resolve(root, 'demo/vite.config.ts'), 'utf8')
if (!viteConfig.includes('__GIO_AUTOTRACK_VERIFICATION__: true')) throw new Error('demo must explicitly enable the autotrack verification build')

const autoTrackPage = readFileSync(resolve(root, 'demo/pages/autotrack/autotrack.vue'), 'utf8')
const transformed = transformAutoTrackSfc(autoTrackPage, '@/uni_modules/gio-uniapp-autotracker/autotrack.js')
if (!transformed.changed || transformed.warnings.length > 0 || !transformed.code.includes('dispatchAutoTrack as gioAutoTrack') || !transformed.code.includes('ignored:&quot;&quot;') || !transformed.code.includes('sensitive:true') || !transformed.code.includes('schemaVersion:2') || !transformed.code.includes('eventName:&quot;openURL&quot;') || transformed.code.includes('xpath:')) {
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
for (const marker of ['currentTarget 无 id', 'v-if 用例', 'v-show 用例', '<auto-track-script-setup', '<auto-track-setup-alias', 'data-growing-sensitive', '<uni-link', 'input-all-completions', 'privacy-ignore-toggle', 'bubble-child', 'picker-static-columns', 'banner-tracked', 'boundary-text', 'list-update', 'boundary-route']) {
  if (!autoTrackPage.includes(marker)) throw new Error(`auto-track showcase is missing acceptance case: ${marker}`)
}

const boundary = transformAutoTrackSfc(readFileSync(resolve(root, 'demo/pages/autotrack-boundary/autotrack-boundary.vue'), 'utf8'))
if (!boundary.changed || boundary.warnings.length > 0) {
  throw new Error('auto-track boundary page must explicitly exclude unsupported listeners and compile without warnings')
}

console.log('demo showcase structure is valid')
