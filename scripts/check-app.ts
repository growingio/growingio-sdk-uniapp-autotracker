import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { modulesDir, npmDir, root, sdkName, sourceHash } from './release-layout.js'

assert.ok(process.env.GIO_UNI_COMPILER_ROOT, '请通过 GIO_UNI_COMPILER_ROOT 指定具备 App 编译组件的 uniapp-cli-vite 目录')
const compilerRoot = resolve(process.env.GIO_UNI_COMPILER_ROOT)
const require = createRequire(join(compilerRoot, 'package.json'))
const cli = require.resolve('@dcloudio/vite-plugin-uni/bin/uni.js')
const compilerVersion = require('@dcloudio/vite-plugin-uni/package.json').version as string
const state = JSON.parse(await readFile(join(root, 'dist/build-state.json'), 'utf8')) as { sourceHash: string }
assert.equal(state.sourceHash, await sourceHash(), '源码已变化，请先重新构建 SDK')
const temporary = await mkdtemp(join(tmpdir(), 'gio-app-consumers-'))
const reportDir = join(root, 'test-results/app-build')
await mkdir(reportDir, { recursive: true })
const results: Array<{ channel: string; runtime: string; compilerVersion: string }> = []
try {
  for (const channel of ['npm', 'uni_modules']) {
    const project = join(temporary, channel)
    await mkdir(join(project, 'node_modules'), { recursive: true })
    for (const name of await readdir(join(compilerRoot, 'node_modules'))) {
      if (!name.startsWith('.') && name !== sdkName) await symlink(join(compilerRoot, 'node_modules', name), join(project, 'node_modules', name), 'dir')
    }
    if (channel === 'npm') await cp(npmDir, join(project, 'node_modules', sdkName), { recursive: true })
    else await cp(modulesDir, join(project, 'uni_modules', sdkName), { recursive: true })
    const entry = channel === 'npm' ? sdkName : `@/uni_modules/${sdkName}/index.js`
    const vite = channel === 'npm' ? `${sdkName}/vite` : `./uni_modules/${sdkName}/vite.js`
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { '@dcloudio/uni-app-plus': compilerVersion } }))
    await writeFile(join(project, 'manifest.json'), JSON.stringify({ name: 'SDK App compile fixture', appid: '__UNI__SDK_FIXTURE', versionName: '0.1.0', versionCode: '100', vueVersion: '3' }))
    await writeFile(join(project, 'App.vue'), '<script>export default {}</script>')
    await writeFile(join(project, 'index.html'), '<div id="app"></div><script type="module" src="/main.js"></script>')
    await mkdir(join(project, 'pages/home'), { recursive: true })
    await writeFile(join(project, 'pages.json'), JSON.stringify({ pages: [{ path: 'pages/home/index' }] }))
    await writeFile(join(project, 'pages/home/index.vue'), `<script setup lang="ts">import gdp from ${JSON.stringify(entry)};const save=()=>gdp('track','app_compile');</script><template><view><button id="save" @tap="save($event)">Save</button></view></template>`)
    await writeFile(join(project, 'vite.config.mjs'), `import uni from '@dcloudio/vite-plugin-uni';import {gioUniappAutoTrack} from ${JSON.stringify(vite)};export default {plugins:[gioUniappAutoTrack(),(uni.default??uni)()]}`)
    for (const runtime of ['app', 'unimp']) {
      await writeFile(join(project, 'main.js'), `import {createSSRApp} from 'vue';import App from './App.vue';import gdp from ${JSON.stringify(entry)};export function createApp(){const app=createSSRApp(App);gdp('registerPlugins',[{name:'gioEventAutoTracking'},${runtime === 'unimp' ? "{name:'gioHybridAdapter',options:{transport:'native-module'}}" : "{name:'gioNativeIdentifiers',options:{fields:['oaid','idfa']}}"}]);gdp('init','account','source',{uniVue:app,${runtime === 'unimp' ? "runtime:'unimp',appId:'guest'" : 'forceLogin:true'}});return {app}}`)
      const output = join(project, 'output', runtime)
      const result = spawnSync(process.execPath, [cli, 'build', '-p', 'app', '--minify', 'esbuild'], {
        cwd: project, env: { ...process.env, NODE_ENV: 'production', UNI_PLATFORM: 'app', UNI_CLI_CONTEXT: project, VITE_ROOT_DIR: project, UNI_INPUT_DIR: project, UNI_OUTPUT_DIR: output },
        encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
      })
      const log = `${result.stdout ?? ''}${result.stderr ?? ''}`
      await writeFile(join(reportDir, `${compilerVersion}-${channel}-${runtime}.log`), log)
      assert.equal(result.status, 0, `${channel}/${runtime}: ${result.error?.message ?? log}`)
      assert.ok(!/(?:^|\n)(?:Error:|SyntaxError:|x Build failed|Build failed with errors)/.test(log), log)
      assert.ok(!log.includes('[gio-uniapp-autotrack]'), 'App 样例不应产生插桩告警')
      const service = await readFile(join(output, 'app-service.js'), 'utf8')
      assert.match(service, /schemaVersion:\s*2,\s*source:\s*["']template["']/, 'App 页面必须包含已交付编译插件的模板探针')
      assert.equal(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).id, '__UNI__SDK_FIXTURE', '必须生成 App manifest')
      assert.ok(service.includes(runtime === 'unimp' ? 'GrowingIOUniMPBridge' : 'GrowingIOUniAppEnhance'))
      results.push({ channel, runtime, compilerVersion })
      console.log(`app_compile_passed:${channel}:${runtime}:${compilerVersion}`)
    }
  }
  assert.equal(await sourceHash(), state.sourceHash, '编译期间源码发生变化')
  await writeFile(join(reportDir, `${compilerVersion}.json`), JSON.stringify({ sourceHash: state.sourceHash, compilerVersion, results, deviceAcceptance: false }, null, 2) + '\n')
} finally { await rm(temporary, { recursive: true, force: true }) }
