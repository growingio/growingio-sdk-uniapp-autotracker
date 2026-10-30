import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { dist, files, hashes, metadata, modulesDir, npmDir, sdkName, sourceHash } from './release-layout.js'

const state = JSON.parse(await readFile(join(dist, 'build-state.json'), 'utf8')) as { sourceHash: string; npm: Record<string, string>; uni: Record<string, string> }
assert.equal(state.sourceHash, await sourceHash(), '源码或发布配置已变化，请重新构建')
for (const [directory, expected, channel] of [[npmDir, state.npm, 'npm'], [modulesDir, state.uni, 'uni_modules']] as const) {
  assert.deepEqual(await hashes(directory), expected, `${channel} 产物被修改或含旧文件`)
  const entries = await files(directory)
  for (const required of ['index.js', 'index.d.ts', 'autotrack.js', 'autotrack.d.ts', 'vite.js', 'vite.d.ts', 'vite-runtime.js', 'LICENSE', 'THIRD_PARTY_LICENSES.txt']) assert.ok(entries.includes(required), required)
  assert.ok(entries.every((file) => !file.endsWith('.ts') || file.endsWith('.d.ts')), '不能交付 TS 源码')
  assert.ok(entries.every((file) => !/(^|\/)(?:demo|test|scripts|node_modules|\.git|\.env)(?:\/|$)/.test(file)), '包含开发文件')
  const rootFiles = new Set(['index.js', 'index.d.ts', 'autotrack.js', 'autotrack.d.ts', 'vite.js', 'vite.d.ts', 'vite-runtime.js', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'])
  assert.ok(entries.every((file) => rootFiles.has(file)
    || /^src\/(?:adapters|constants|core|platform|plugins|types|utils)\/(?:[A-Za-z0-9-]+\/)*[A-Za-z0-9-]+\.(?:js|d\.ts)$/.test(file)
    || file === 'src/compiler/vite.d.ts' || /^doc\/[a-z0-9-]+\.md$/.test(file)), '文件不在交付白名单内')
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  assert.equal(pkg.name, sdkName)
  assert.equal(pkg.version, metadata.version)
  assert.equal(pkg.private, false)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dependencies, undefined, '编译器依赖必须随 Vite 工具打包')
  assert.equal(pkg.devDependencies, undefined)
  for (const entry of ['.', './vite', './autotrack']) {
    assert.ok(entries.includes(pkg.exports[entry].types.slice(2)))
    assert.ok(entries.includes(pkg.exports[entry].import.slice(2)))
  }
  const runtime = await build({ entryPoints: [join(directory, 'index.js'), join(directory, 'autotrack.js')], outdir: 'unused', bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true })
  assert.ok(Object.keys(runtime.metafile.inputs).every((file) => !file.includes('node_modules/') && !file.endsWith('vite-runtime.js')), '编译依赖进入了 App 运行时')
}
assert.deepEqual(Object.keys(state.npm), Object.keys(state.uni))
for (const file of Object.keys(state.npm)) {
  if (file !== 'vite.js' && file !== 'package.json') assert.equal(state.npm[file], state.uni[file], `两种渠道代码不一致:${file}`)
}
console.log(`release_checked:${metadata.version}`)
