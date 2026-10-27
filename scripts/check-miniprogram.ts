import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { modulesDir, npmDir, root, sdkName, sourceHash } from './release-layout.js'

// 默认使用 lockfile 中的 CLI。可显式指定 HBuilderX 的 uniapp-cli-vite 目录做第二套验证。
const compilerRoot = resolve(process.env.GIO_UNI_COMPILER_ROOT ?? root)
const compilerRequire = createRequire(join(compilerRoot, 'package.json'))
const cli = compilerRequire.resolve('@dcloudio/vite-plugin-uni/bin/uni.js')
const compilerVersion = compilerRequire('@dcloudio/vite-plugin-uni/package.json').version as string
const state = JSON.parse(await readFile(join(root, 'dist/build-state.json'), 'utf8')) as { sourceHash: string }
assert.equal(state.sourceHash, await sourceHash(), '源码已变化，请先重新构建 SDK')
const temporary = await mkdtemp(join(tmpdir(), 'gio-mini-consumers-'))
const reportDir = join(root, 'test-results/miniprogram-build')
await mkdir(reportDir, { recursive: true })
const results: Array<{ channel: string; target: string; instrumented: boolean; compilerVersion: string }> = []

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string): void {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  // writeFile 的 Promise 在上层串行等待，日志不会依赖子进程成功才保留。
  logs.push(writeFile(join(reportDir, `${name}.log`), output))
  assert.equal(result.status, 0, `${name}: ${result.error?.message ?? output}`)
  assert.ok(!/(?:^|\n)(?:Error:|SyntaxError:|x Build failed|Build failed with errors)/.test(output), `${name}: ${output}`)
}
const logs: Promise<void>[] = []

try {
  for (const channel of ['npm', 'uni_modules'] as const) {
    const project = join(temporary, channel)
    await mkdir(join(project, 'node_modules'), { recursive: true })
    for (const name of await readdir(join(compilerRoot, 'node_modules'))) {
      if (!name.startsWith('.') && name !== sdkName) await symlink(join(compilerRoot, 'node_modules', name), join(project, 'node_modules', name), 'dir')
    }
    if (channel === 'npm') await cp(npmDir, join(project, 'node_modules', sdkName), { recursive: true })
    else await cp(modulesDir, join(project, 'uni_modules', sdkName), { recursive: true })
    const entry = channel === 'npm' ? sdkName : `@/uni_modules/${sdkName}/index.js`
    const nodeEntry = channel === 'npm' ? sdkName : `./uni_modules/${sdkName}/index.js`
    const viteEntry = channel === 'npm' ? `${sdkName}/vite` : `./uni_modules/${sdkName}/vite.js`
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, dependencies: Object.fromEntries(['weixin', 'alipay'].map(target => [`@dcloudio/uni-mp-${target}`, compilerVersion])) }))
    await cp(join(root, 'test/fixtures/miniprogram/App.vue'), join(project, 'App.vue'))
    for (const [name, page] of [['home', 'home'], ['detail', 'detail']] as const) {
      await mkdir(join(project, 'pages', name), { recursive: true })
      const source = await readFile(join(root, 'test/fixtures/miniprogram', `${page}.vue`), 'utf8')
      await writeFile(join(project, 'pages', name, 'index.vue'), source.replaceAll("'gio-uniapp-autotracker'", JSON.stringify(entry)))
    }
    await writeFile(join(project, 'pages.json'), JSON.stringify({ pages: [{ path: 'pages/home/index', style: { navigationBarTitleText: '首页' } }, { path: 'pages/detail/index' }] }))
    await writeFile(join(project, 'manifest.json'), JSON.stringify({ name: 'SDK compile fixture', appid: '__UNI__SDK_FIXTURE', versionName: '0.1.0', versionCode: '100', vueVersion: '3', 'mp-weixin': { appid: 'touristappid' }, 'mp-alipay': { appid: '2026102700000001' } }))
    await writeFile(join(project, 'main.ts'), `import { createSSRApp } from 'vue'; import App from './App.vue'; import gdp from ${JSON.stringify(entry)}; export function createApp() { const app = createSSRApp(App); gdp('registerPlugins', [{name:'gioEventAutoTracking'}]); gdp('init','fixture-account','fixture-source',{uniVue:app,appId:'fixture',dataCollect:false}); return {app} }`)
    for (const target of ['mp-weixin', 'mp-alipay']) {
      for (const instrumented of [true, false]) {
        await writeFile(join(project, 'vite.config.mjs'), `import uni from '@dcloudio/vite-plugin-uni'; import { gioUniappAutoTrack } from ${JSON.stringify(viteEntry)}; export default {plugins:[${instrumented ? 'gioUniappAutoTrack(),' : ''}(uni.default??uni)()]}`)
        const output = join(project, 'output', target)
        const name = `${compilerVersion}-${channel}-${target}-${instrumented ? 'auto' : 'basic'}`
        const env = { ...process.env, NODE_ENV: 'production', UNI_PLATFORM: target, UNI_CLI_CONTEXT: project, VITE_ROOT_DIR: project, UNI_INPUT_DIR: project, UNI_OUTPUT_DIR: output }
        run(process.execPath, [cli, 'build', '-p', target], project, env, name)
        const template = await readFile(join(output, 'pages/home/index' + (target === 'mp-weixin' ? '.wxml' : '.axml')), 'utf8')
        const page = await readFile(join(output, 'pages/home/index.js'), 'utf8')
        assert.ok(template.includes(target === 'mp-weixin' ? 'bindtap' : 'onTap'))
        assert.ok(template.includes(target === 'mp-weixin' ? 'bindblur' : 'onBlur'))
        assert.equal(/schemaVersion:\s*2/.test(page), instrumented, '探针必须来自已安装的编译插件')
        assert.ok(template.includes('data-growing-track'))
        results.push({ channel, target, instrumented, compilerVersion })
      }
      // 真实交付包在独立进程中运行：自动选择目标、生命周期、协议、内存队列和后台发送。
      await writeFile(join(project, 'consumer.mjs'), `
import assert from 'node:assert/strict'; import gdp from ${JSON.stringify(nodeEntry)};
const sent=[], hooks=[], stored=new Map(); let tracker;
globalThis.uni={getSystemInfoSync:()=>({uniPlatform:${JSON.stringify(target)},platform:'ios',version:'10.0'}),getStorageSync:key=>stored.get(key),setStorageSync:(key,value)=>stored.set(key,value),removeStorageSync:key=>stored.delete(key),getNetworkType:options=>options.success({networkType:'wifi'}),request:options=>{sent.push(...JSON.parse(options.data));options.success({statusCode:204});}};
gdp('registerPlugins',[{name:'consumer',install:value=>{tracker=value}}]);
assert.equal(gdp('init','account','source',{uniVue:{mixin:value=>hooks.push(value)},appId:'fixture'}),true);
hooks[0].onLaunch.call({$mpType:'app'},{path:'pages/home',scene:1001}); hooks[0].onShow.call({$mpType:'app'},{path:'pages/home',scene:1001});
const page={$mpType:'page',$scope:{route:'pages/home'}}; hooks[0].onLoad.call(page,{a:'1'});hooks[0].onShow.call(page);
assert.equal(await tracker.whenReady(),true);assert.equal(gdp('track','mini_consumer_event'),true);hooks[0].onHide.call({$mpType:'app'});
assert.deepEqual(sent.map(event=>event.eventType),['VISIT','PAGE','CUSTOM','APP_CLOSED']);assert.ok(sent.every(event=>event.platform===${JSON.stringify(target === 'mp-weixin' ? 'MinP' : 'alip')} && event.domain==='fixture' && !('orientation' in event) && !('appState' in event)));
assert.ok([...stored.keys()].every(key=>!key.includes(':session')&&!key.includes(':queue')));console.log('mini_consumer_passed');
`)
      run(process.execPath, [join(project, 'consumer.mjs')], project, process.env, `${compilerVersion}-${channel}-${target}-runtime`)
    }
  }
  await writeFile(join(reportDir, `${compilerVersion}.json`), JSON.stringify({ sourceHash: state.sourceHash, compilerVersion, results, runtimeConsumers: 4, deviceAcceptance: false }, null, 2) + '\n')
  console.log(`miniprogram_checked:${compilerVersion}:${results.length}_builds:4_runtime_consumers`)
} finally {
  await Promise.all(logs)
  await rm(temporary, { recursive: true, force: true })
}
