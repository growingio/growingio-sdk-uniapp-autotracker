import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { modulesDir, npmDir, root, sdkName, sourceHash } from './release-layout.js'
import { isMiniProgramTarget, MINI_PROGRAM_PROFILES, MINI_PROGRAM_TARGETS } from '../src/constants/miniprogram.js'
import type { MiniProgramTarget } from '../src/types/index.js'

// 默认使用 lockfile 中的 CLI。可显式指定 HBuilderX 的 uniapp-cli-vite 目录做第二套验证。
const compilerRoot = resolve(process.env.GIO_UNI_COMPILER_ROOT ?? root)
const compilerRequire = createRequire(join(compilerRoot, 'package.json'))
const cli = compilerRequire.resolve('@dcloudio/vite-plugin-uni/bin/uni.js')
const cliRequire = createRequire(cli)
const compilerVersion = compilerRequire('@dcloudio/vite-plugin-uni/package.json').version as string
const arguments_ = process.argv.slice(2)
assert.ok(arguments_.length === 0 || arguments_.length === 2 && arguments_[0] === '--targets', '用法：check-miniprogram [--targets mp-baidu,mp-toutiao]')
const selectedTargets = arguments_[1]
const requestedTargets = selectedTargets?.split(',') ?? MINI_PROGRAM_TARGETS
assert.ok(requestedTargets.length > 0 && requestedTargets.every(isMiniProgramTarget), '仅允许选择已实现的小程序目标')
const targets = [...new Set(requestedTargets)] as MiniProgramTarget[]
const templates: Readonly<Record<MiniProgramTarget, string>> = {
  'mp-weixin': '.wxml', 'mp-alipay': '.axml', 'mp-baidu': '.swan', 'mp-toutiao': '.ttml',
  'mp-qq': '.qml', 'mp-kuaishou': '.ksml', 'mp-jd': '.jxml', 'mp-xhs': '.xhsml',
}
const state = JSON.parse(await readFile(join(root, 'dist/build-state.json'), 'utf8')) as { sourceHash: string }
assert.equal(state.sourceHash, await sourceHash(), '源码已变化，请先重新构建 SDK')
const temporary = await mkdtemp(join(tmpdir(), 'gio-mini-consumers-'))
const reportDir = join(root, 'test-results/miniprogram-build')
await mkdir(reportDir, { recursive: true })
const results: Array<{ channel: string; target: string; mode: string; instrumented: boolean; compilerVersion: string }> = []
let runtimeConsumers = 0

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
  // 走同一 DCloud 开发环境初始化，但单次构建后退出；不把生产 build --mode 当作开发构建。
  const developmentRunner = join(temporary, 'development.cjs')
  await writeFile(developmentRunner, `
require(${JSON.stringify(cliRequire.resolve('@dcloudio/uni-cli-shared/dist/alias'))});
require(${JSON.stringify(cliRequire.resolve('@dcloudio/uni-cli-shared/dist/polyfill'))});
const options={platform:process.env.UNI_PLATFORM,mode:'development',logLevel:'warn'};
require(${JSON.stringify(compilerRequire.resolve('@dcloudio/vite-plugin-uni/dist/cli/utils.js'))}).initEnv('dev',options);
require(${JSON.stringify(compilerRequire.resolve('@dcloudio/vite-plugin-uni/dist/cli/build.js'))}).build(options).then(()=>{console.log('development_compile_passed');process.exit(0)}).catch(error=>{console.error(error);process.exit(1)});
`)
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
    await writeFile(join(project, 'package.json'), JSON.stringify({ private: true, dependencies: Object.fromEntries(targets.map(target => [`@dcloudio/uni-${target}`, compilerVersion])) }))
    await cp(join(root, 'test/fixtures/miniprogram/App.vue'), join(project, 'App.vue'))
    for (const [name, page] of [['home', 'home'], ['detail', 'detail']] as const) {
      await mkdir(join(project, 'pages', name), { recursive: true })
      const source = await readFile(join(root, 'test/fixtures/miniprogram', `${page}.vue`), 'utf8')
      await writeFile(join(project, 'pages', name, 'index.vue'), source.replaceAll("'gio-uniapp-autotracker'", JSON.stringify(entry)))
    }
    await mkdir(join(project, 'subpackage'), { recursive: true })
    const subpage = await readFile(join(root, 'test/fixtures/miniprogram/detail.vue'), 'utf8')
    await writeFile(join(project, 'subpackage/detail.vue'), subpage.replaceAll("'gio-uniapp-autotracker'", JSON.stringify(entry)))
    await writeFile(join(project, 'pages.json'), JSON.stringify({
      pages: [{ path: 'pages/home/index', style: { navigationBarTitleText: '首页' } }, { path: 'pages/detail/index' }],
      subPackages: [{ root: 'subpackage', pages: [{ path: 'detail' }] }],
      tabBar: { list: [{ pagePath: 'pages/home/index', text: '首页' }, { pagePath: 'pages/detail/index', text: '详情' }] },
    }))
    await writeFile(join(project, 'manifest.json'), JSON.stringify({ name: 'SDK compile fixture', appid: '__UNI__SDK_FIXTURE', versionName: '0.1.0', versionCode: '100', vueVersion: '3', ...Object.fromEntries(targets.map(target => [target, { appid: target === 'mp-weixin' ? 'touristappid' : 'fixture' }])) }))
    const main = await readFile(join(root, 'demo/main.ts'), 'utf8')
    await writeFile(join(project, 'main.ts'), main.replace("'@/uni_modules/gio-uniapp-autotracker/index.js'", JSON.stringify(entry)))
    for (const file of ['sdk-state.ts', 'miniprogram-config.ts']) await cp(join(root, 'demo', file), join(project, file))
    for (const target of targets) {
      for (const mode of ['production', 'development']) {
        for (const instrumented of [true, false]) {
          await writeFile(join(project, 'vite.config.mjs'), `import uni from '@dcloudio/vite-plugin-uni'; import { gioUniappAutoTrack } from ${JSON.stringify(viteEntry)}; export default {plugins:[${instrumented ? 'gioUniappAutoTrack(),' : ''}(uni.default??uni)()]}`)
          const output = join(project, 'output', target, mode, instrumented ? 'auto' : 'basic')
          const name = `${compilerVersion}-${channel}-${target}-${mode}-${instrumented ? 'auto' : 'basic'}`
          const env = { ...process.env, NODE_ENV: mode, UNI_PLATFORM: target, UNI_CLI_CONTEXT: project, VITE_ROOT_DIR: project, UNI_INPUT_DIR: project, UNI_OUTPUT_DIR: output }
          run(process.execPath, mode === 'production' ? [cli, 'build', '-p', target, '--minify', 'esbuild'] : [developmentRunner], project, env, name)
          const template = await readFile(join(output, 'pages/home/index' + templates[target]), 'utf8')
          const page = await readFile(join(output, 'pages/home/index.js'), 'utf8')
          assert.ok(template.includes(target === 'mp-alipay' ? 'onTap' : 'bindtap'))
          assert.ok(template.includes(target === 'mp-alipay' ? 'onBlur' : 'bindblur'))
          assert.equal(/schemaVersion:\s*2/.test(page), instrumented, '探针必须来自已安装的编译插件')
          assert.ok(template.includes('data-growing-track'))
          const subtemplate = await readFile(join(output, 'subpackage/detail' + templates[target]), 'utf8')
          const subscript = await readFile(join(output, 'subpackage/detail.js'), 'utf8')
          assert.ok(subtemplate.length > 0)
          assert.equal(/schemaVersion:\s*2/.test(subscript), instrumented, '分包页面必须保持相同插桩策略')
          const appConfig = JSON.parse(await readFile(join(output, 'app.json'), 'utf8'))
          assert.ok(appConfig.tabBar, '必须输出内置 tabBar 配置')
          assert.ok(JSON.stringify(appConfig).includes('subpackage'), '必须保留分包声明')
          results.push({ channel, target, mode, instrumented, compilerVersion })
          console.log(`mini_compile_passed:${channel}:${target}:${mode}:${instrumented ? 'auto' : 'basic'}`)
        }
      }
      // 真实交付包在独立进程中运行：自动选择目标、生命周期、协议、内存队列和后台发送。
      await writeFile(join(project, 'consumer.mjs'), `
import assert from 'node:assert/strict'; import gdp from ${JSON.stringify(nodeEntry)};
const sent=[], hooks=[], stored=new Map(); let tracker; const advanced=process.argv[2]==='advanced';
if(advanced){stored.set('_growing_uid_','legacy-device');stored.set('_growing_userId_','legacy-user');}
globalThis.uni={getSystemInfoSync:()=>({uniPlatform:${JSON.stringify(target)},platform:'ios',version:'10.0'}),getStorageSync:key=>stored.get(key),setStorageSync:(key,value)=>stored.set(key,value),removeStorageSync:key=>stored.delete(key),getNetworkType:options=>options.success({networkType:'wifi'}),request:options=>{sent.push(...JSON.parse(options.data));options.success({statusCode:204});}};
gdp('registerPlugins',[{name:'consumer',install:value=>{tracker=value}}]);
assert.equal(gdp('init','account','source',{uniVue:{mixin:value=>hooks.push(value)},appId:'fixture',...(advanced?{forceLogin:true,legacyMiniProgramIdentity:{appId:'fixture',accountId:'account',dataSourceId:'source'}}:{})}),true);
hooks[0].onLaunch.call({$mpType:'app'},{path:'pages/home',scene:1001}); hooks[0].onShow.call({$mpType:'app'},{path:'pages/home',scene:1001});
const page={$mpType:'page',$scope:{route:'pages/home'}}; hooks[0].onLoad.call(page,{a:'1'});hooks[0].onShow.call(page);
assert.equal(await tracker.whenReady(),true);assert.equal(gdp('track','mini_consumer_event'),true);
if(advanced){assert.equal(sent.length,0);assert.equal(gdp('getGioInfo'),null);assert.ok(tracker.queuedEvents().every(event=>event.deviceId==='legacy-device'&&event.userId==='legacy-user'));assert.equal(gdp('identify','assigned-device'),true);assert.equal(gdp('identify','other'),false);assert.equal(new URLSearchParams(gdp('getGioInfo')).get('giou'),'assigned-device');}
else{assert.equal(new URLSearchParams(gdp('getGioInfo')).get('gioplatform'),${JSON.stringify(MINI_PROGRAM_PROFILES[target].platform)});}
hooks[0].onHide.call({$mpType:'app'});
assert.deepEqual(sent.map(event=>event.eventType),['VISIT','PAGE','CUSTOM','APP_CLOSED']);assert.ok(sent.every(event=>event.platform===${JSON.stringify(MINI_PROGRAM_PROFILES[target].platform)} && event.domain==='fixture' && !('orientation' in event) && !('appState' in event)));
assert.ok([...stored.keys()].every(key=>!key.includes(':session')&&!key.includes(':queue')));if(advanced){assert.ok(sent.every(event=>event.deviceId==='assigned-device'));assert.equal(stored.get('_growing_uid_'),'legacy-device');}console.log('mini_consumer_passed:'+ (advanced?'advanced':'default'));
`)
      run(process.execPath, [join(project, 'consumer.mjs')], project, process.env, `${compilerVersion}-${channel}-${target}-runtime`)
      runtimeConsumers++
      run(process.execPath, [join(project, 'consumer.mjs'), 'advanced'], project, process.env, `${compilerVersion}-${channel}-${target}-advanced-runtime`)
      runtimeConsumers++
    }
  }
  const reportSuffix = selectedTargets === undefined ? '' : `-targets-${targets.join('_')}`
  assert.equal(await sourceHash(), state.sourceHash, '编译过程中源码发生变化，结果不能用于当前交付')
  await writeFile(join(reportDir, `${compilerVersion}${reportSuffix}.json`), JSON.stringify({ sourceHash: state.sourceHash, compilerVersion, targets, results, runtimeConsumers, deviceAcceptance: false }, null, 2) + '\n')
  console.log(`miniprogram_checked:${compilerVersion}:${results.length}_builds:${runtimeConsumers}_runtime_consumers`)
} finally {
  await Promise.all(logs)
  await rm(temporary, { recursive: true, force: true })
}
