import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfigFromFile } from 'vite'
import type { UniAppAutoTrackVitePlugin } from '../src/compiler/vite.js'
import { archivesDir, hashes, metadata, modulesDir, npmDir, root, sdkName } from './release-layout.js'

const release = JSON.parse(await readFile(join(archivesDir, 'release.json'), 'utf8')) as { npmFile: string; npmIntegrity: string; uniFile: string; uniSha256: string; version: string }
assert.equal(release.version, metadata.version)
assert.equal(`sha512-${createHash('sha512').update(await readFile(join(archivesDir, release.npmFile))).digest('base64')}`, release.npmIntegrity)
assert.equal(createHash('sha256').update(await readFile(join(archivesDir, release.uniFile))).digest('hex'), release.uniSha256)
const temporary = await mkdtemp(join(tmpdir(), 'gio-sdk-consumers-'))
try {
  for (const channel of ['npm', 'uni_modules']) {
    const project = join(temporary, channel)
    await mkdir(project)
    const projectMetadata = { name: 'isolated-sdk-consumer', private: true }
    await writeFile(join(project, 'package.json'), JSON.stringify(projectMetadata))
    if (channel === 'npm') {
      execFileSync('npm', ['install', join(archivesDir, release.npmFile), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--cache', join(temporary, 'cache')], { cwd: project, stdio: 'pipe' })
    } else {
      execFileSync('tar', ['-xzf', join(archivesDir, release.uniFile), '-C', project])
    }
    const installed = channel === 'npm' ? join(project, 'node_modules', sdkName) : join(project, 'uni_modules', sdkName)
    assert.deepEqual(await hashes(installed), await hashes(channel === 'npm' ? npmDir : modulesDir), `${channel} 实际安装文件与验证过的构建产物不一致`)
    const entry = channel === 'npm' ? sdkName : `./uni_modules/${sdkName}/index.js`
    const vite = channel === 'npm' ? `${sdkName}/vite` : `./uni_modules/${sdkName}/vite.js`
    const autotrack = channel === 'npm' ? `${sdkName}/autotrack` : `./uni_modules/${sdkName}/autotrack.js`
    const runtimeImport = channel === 'npm' ? `${sdkName}/autotrack` : `@/uni_modules/${sdkName}/autotrack.js`
    // 真正解包到仓库外，不能借用仓库 node_modules 或直接导入 TS 源码。
    await writeFile(join(project, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import gdp from ${JSON.stringify(entry)};
import { gioUniappAutoTrack } from ${JSON.stringify(vite)};
import { dispatchAutoTrack } from ${JSON.stringify(autotrack)};
const requests = [], hooks = [], values = new Map();
globalThis.uni = {
  getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, value), removeStorageSync: key => values.delete(key),
  getDeviceInfo: () => ({ platform: 'android', osVersion: '14' }), getSystemInfoSync: () => ({}), getAppBaseInfo: () => ({ appVersion: '2.0' }),
  getNetworkType: options => options.success({ networkType: 'wifi' }),
  request: options => { requests.push(JSON.parse(options.data)); options.success({ statusCode: 204 }); }
};
let tracker;
const hostURL = globalThis.URL; globalThis.URL = undefined;
assert.equal(gdp('registerPlugins', [{ name: 'consumer-check', install: value => { tracker = value } }]), true);
assert.equal(gdp('init', 'account', 'source', { uniVue: { mixin: value => hooks.push(value) }, serverUrl: 'collector.example/', sdkVersion: 'caller-override' }), true);
assert.equal(gdp('setUserId', 'early-user'), true);
hooks[0].onLaunch.call({}, { path: 'pages/home' }); hooks[0].onShow.call({}, { path: 'pages/home' });
assert.equal(await tracker.whenReady(), true);
globalThis.URL = hostURL;
assert.equal(requests.length, 1);
assert.equal(requests.flat()[0].eventType, 'VISIT');
assert.deepEqual(tracker.queuedEvents(), []);
assert.equal(gdp('track', 'immediate_consumer_event'), true);
assert.equal(requests.length, 2);
assert.equal(requests.flat().at(-1).eventName, 'immediate_consumer_event');
hooks[0].onHide.call({});
assert.equal(requests.length, 3);
assert.equal(requests.flat().at(-1).eventType, 'APP_CLOSED');
assert.deepEqual(tracker.queuedEvents(), []);
assert.equal(requests.flat()[0].sdkVersion, ${JSON.stringify(metadata.version)});
assert.equal(requests.flat()[0].userId, 'early-user');
const call = { kind: 'click' }; let forwarded;
tracker.autoTrack = value => { forwarded = value; return true };
assert.equal(dispatchAutoTrack(call), true); assert.equal(forwarded, call);
const plugin = gioUniappAutoTrack();
const result = plugin.transform.call({ warn: warning => { throw new Error(warning) } }, '<script setup>const save = e => e</script><template><button @click="save($event)" /></template>', 'page.vue');
assert.ok(result.code.includes(${JSON.stringify(runtimeImport)}));
console.log('consumer_passed:${channel}');
`)
    execFileSync(process.execPath, [join(project, 'consumer.mjs')], { cwd: project, stdio: 'inherit', timeout: 30_000 })
    await writeFile(join(project, 'hybrid-consumer.mjs'), `
import assert from 'node:assert/strict'; import gdp from ${JSON.stringify(entry)};
const hooks=[],requests=[],events=[],errors=[]; let tracker,userId=null,userKey=null;
const flush=async()=>{for(let n=0;n<40;n++)await Promise.resolve()};
globalThis.uni={requireNativePlugin:name=>{assert.equal(name,'GrowingIOUniMPBridge');return{invoke:(request,done)=>{
 requests.push(request); const {version,requestId,instanceId,generation}=request; const header={version,requestId,instanceId,generation};
 if(request.method==='hello'){done({...header,status:'ok',connectionId:'native-connection',payload:{hostType:'native',appId:'guest',accountId:'account',dataSourceId:'source',idMapping:true,platform:'Android',nativeSdkVersion:'4.4.0',host:{dataCollect:true,containerVisible:true},events:['PAGE','CUSTOM','VIEW_CLICK','VIEW_CHANGE','LOGIN_USER_ATTRIBUTES'],identityWrite:true}});return;}
 if(request.method==='setUserId'){userId=request.payload.userId;userKey=request.payload.userKey??null;}
 else if(request.method==='clearUserId'){userId=null;userKey=null;}
 else{assert.equal(request.method,'dispatchEvent');const event=request.payload.event;for(const field of ['deviceId','sessionId','eventSequenceId','domain','platform','userId'])assert.equal(field in event,false);events.push({...event,userId,userKey});}
 done({...header,connectionId:'native-connection',status:request.method==='dispatchEvent'?'accepted':'ok',host:{dataCollect:true,containerVisible:true}});
}}}};
assert.equal(gdp('registerPlugins',[{name:'gioHybridAdapter',options:{transport:'native-module',onError:error=>errors.push(error)}},{name:'capture',install:value=>{tracker=value}}]),true);
assert.equal(gdp('init','account','source',{uniVue:{mixin:value=>hooks.push(value)},runtime:'unimp',appId:'guest',idMapping:true}),true);
assert.equal(requests.length,0);hooks[0].onShow.call({$mpType:'component'},{});assert.equal(requests.length,0);
hooks[0].onShow.call({$mpType:'app'},{});const page={$mpType:'page',$page:{route:'pages/home'}};hooks[0].onLoad.call(page,{q:'中文'});hooks[0].onShow.call(page,{});await flush();assert.equal(tracker.ready(),true);
assert.equal(gdp('setUserId','A','key'),true);assert.equal(gdp('track','E1'),true);assert.equal(gdp('clearUserId'),true);assert.equal(gdp('track','E2'),true);await flush();
assert.deepEqual(events.map(event=>event.eventType),['PAGE','CUSTOM','CUSTOM']);assert.deepEqual(events.slice(1).map(event=>[event.eventName,event.userId,event.userKey]),[['E1','A','key'],['E2',null,null]]);
assert.equal(gdp('getGioInfo'),null);assert.equal(gdp('identify','device'),false);assert.equal(gdp('setLocation',1,2),false);await flush();assert.equal(errors.at(-1).code,'location_owned_by_host');
hooks[0].onHide.call({$mpType:'app'});console.log('hybrid_consumer_passed:${channel}');
`)
    execFileSync(process.execPath, [join(project, 'hybrid-consumer.mjs')], { cwd: project, stdio: 'inherit', timeout: 30_000 })
    await writeFile(join(project, 'advanced-consumer.mjs'), `
import assert from 'node:assert/strict';import gdp from ${JSON.stringify(entry)};
const stored=new Map(),hooks=[],sent=[];let tracker;
globalThis.uni={
 getStorageSync:key=>stored.get(key),setStorageSync:(key,value)=>stored.set(key,value),removeStorageSync:key=>stored.delete(key),
 getDeviceInfo:()=>({platform:'android',osVersion:'14'}),getSystemInfoSync:()=>({}),getAppBaseInfo:()=>({packageName:'example.app'}),
 getNetworkType:options=>options.success({networkType:'wifi'}),request:options=>{sent.push(...JSON.parse(options.data));options.success({statusCode:204});},
 requireNativePlugin:name=>{
  assert.equal(name,'GrowingIOUniAppEnhance');
  return {getIdentifiers:(request,done)=>{assert.deepEqual(request,{version:1,fields:['oaid']});done({version:1,identifiers:{oaid:'native-oaid'}});}};
 }
};
gdp('registerPlugins',[{name:'gioNativeIdentifiers',options:{fields:['oaid']}},{name:'capture',install:value=>{tracker=value}}]);
assert.equal(gdp('init','account','source',{uniVue:{mixin:value=>hooks.push(value)},forceLogin:true}),true);hooks[0].onShow.call({},{});await tracker.whenReady();
assert.equal(gdp('track','waiting'),true);assert.equal(sent.length,0);assert.equal(gdp('getGioInfo'),null);assert.equal(gdp('identify','assigned-device'),true);assert.ok(sent.every(event=>event.deviceId==='assigned-device'));
assert.equal(new URLSearchParams(gdp('getGioInfo')).get('giou'),'assigned-device');gdp('setUserId','A');gdp('setUserId','B');assert.ok(sent.some(event=>event.eventType==='VISIT'&&event.oaid==='native-oaid'));assert.ok(sent.filter(event=>event.eventType!=='VISIT').every(event=>!('oaid'in event)));
assert.equal(gdp('setOptions',{dataCollect:false}),true);assert.deepEqual(Object.fromEntries(new URLSearchParams(gdp('getGioInfo'))),{gioappid:'example.app',gioprojectid:'account',giodatasourceid:'source',giodatacollect:'false'});
hooks[0].onHide.call({});console.log('advanced_consumer_passed:${channel}');
`)
    execFileSync(process.execPath, [join(project, 'advanced-consumer.mjs')], { cwd: project, stdio: 'inherit', timeout: 30_000 })
    await writeFile(join(project, 'consumer.mts'), `import gdp from ${JSON.stringify(entry)};\nimport { gioUniappAutoTrack } from ${JSON.stringify(vite)};\nimport { dispatchAutoTrack } from ${JSON.stringify(autotrack)};\ngdp('track', 'typed', { value: 0 });\ngdp('identify', 'assigned');\nconst info: string | null = gdp('getGioInfo');\ngdp('registerPlugins', [{name:'gioHybridAdapter',options:{onReady:state=>{void state.identityBlocked},onError:error=>{void error.outcome}}},{name:'gioNativeIdentifiers',options:{fields:['oaid']}}]);\ngdp('init','account','source',{runtime:'unimp',appId:'guest',uniVue:{mixin:()=>{}}});\ngioUniappAutoTrack();\nvoid dispatchAutoTrack;void info;\n`)
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.mts'], { cwd: project, stdio: 'inherit', timeout: 30_000 })

    // 验证工具使用仓库锁定的 Vite；SDK 解析仍只能来自仓库外安装的交付包。
    for (const mode of ['commonjs', 'module'] as const) {
      await writeFile(join(project, 'package.json'), JSON.stringify({ ...projectMetadata, ...(mode === 'module' ? { type: 'module' } : {}) }))
      const configFile = join(project, `vite.${mode}.config.ts`)
      const source = mode === 'commonjs'
        ? `export default async () => { const { gioUniappAutoTrack } = await import(${JSON.stringify(vite)}); return { plugins: [gioUniappAutoTrack()] } }`
        : `import { gioUniappAutoTrack } from ${JSON.stringify(vite)}; export default { plugins: [gioUniappAutoTrack()] }`
      await writeFile(configFile, source)
      const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configFile, project, 'silent')
      assert.ok(loaded, 'Vite 配置未加载')
      const plugin = loaded.config.plugins?.[0] as UniAppAutoTrackVitePlugin
      assert.equal(plugin.name, 'gio-uniapp-autotrack')
      const transformed = plugin.transform.call({
        /** 将独立消费者的插桩告警升级为失败，避免检查静默漏过。 */
        warn: warning => { throw new Error(warning) }
      }, '<script setup>const save = e => e</script><template><button @click="save($event)" /></template>', 'page.vue')
      assert.ok(transformed?.code.includes(runtimeImport), `${channel}/${mode} 探针入口错误`)
      console.log(`vite_config_passed:${channel}:${mode}`)
    }
  }
} finally { await rm(temporary, { recursive: true, force: true }) }
