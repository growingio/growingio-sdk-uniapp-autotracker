import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { dist, hashes, metadata, modulesDir, npmDir, root, runtimeEntries, sdkName, sourceHash } from './release-layout.js'
import { MINI_PROGRAM_TARGETS } from '../src/constants/miniprogram.js'

// 只清理固定生成目录；公开入口和 src 中的开发源码不受影响。
for (const output of [join(dist, 'build'), npmDir, modulesDir]) await rm(output, { recursive: true, force: true })
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' })
await mkdir(npmDir, { recursive: true })
for (const entry of runtimeEntries) await cp(join(dist, 'build', entry), join(npmDir, entry), { recursive: true })
// 编译器只交付其公开声明和独立打包产物，App 运行时代码保留 src 中的领域目录。
await rm(join(npmDir, 'src/compiler'), { recursive: true, force: true })
await mkdir(join(npmDir, 'src/compiler'), { recursive: true })
await cp(join(dist, 'build/src/compiler/vite.d.ts'), join(npmDir, 'src/compiler/vite.d.ts'))
await cp(join(dist, 'build/vite.d.ts'), join(npmDir, 'vite.d.ts'))

const bundled = await build({
  entryPoints: [join(root, 'vite.ts')], outfile: join(npmDir, 'vite-runtime.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', mainFields: ['main'],
  metafile: true, legalComments: 'eof',
  // 仅使用 SFC parse；独立 ESM 入口不包含 Node 模板预处理器的可选依赖。
  alias: { '@vue/compiler-sfc': join(root, 'node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js') },
  // 编译器中的 Node 内置模块保留原生加载，其余依赖全部随编译插件交付。
  banner: { js: "import { createRequire as gioCreateRequire } from 'node:module'; const require = gioCreateRequire(import.meta.url);" },
})
const licenseRoots = new Set<string>()
for (const input of Object.keys(bundled.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue
  let directory = dirname(resolve(root, input))
  while (directory !== root && directory !== dirname(directory)) {
    if (existsSync(join(directory, 'package.json'))) { licenseRoots.add(directory); break }
    directory = dirname(directory)
  }
}
const notices: string[] = []
for (const directory of [...licenseRoots].sort()) {
  const dependency = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; version: string; license?: string }
  const licenses = (await readdir(directory)).filter((name) => /^licen[cs]e(?:\.|$)/i.test(name))
  notices.push(`${dependency.name}@${dependency.version}\n${dependency.license ?? ''}\n${(await Promise.all(licenses.map((name) => readFile(join(directory, name), 'utf8')))).join('\n')}`)
}
await writeFile(join(npmDir, 'THIRD_PARTY_LICENSES.txt'), notices.join('\n\n----------------\n\n'))
for (const entry of ['README.md', 'LICENSE', 'doc']) await cp(join(root, entry), join(npmDir, entry), { recursive: true })

const packageJson = {
  name: sdkName, version: metadata.version, description: metadata.description, type: 'module', private: false,
  license: 'GPL-3.0-only', repository: { type: 'git', url: 'https://github.com/growingio/gio-uniapp-autotracker.git' },
  engines: { node: '>=20.19.0' }, main: './index.js', types: './index.d.ts',
  exports: Object.fromEntries(['.', './vite', './autotrack'].map((entry) => {
    const name = entry === '.' ? 'index' : entry.slice(2)
    return [entry, { types: `./${name}.d.ts`, import: `./${name}.js` }]
  })),
  files: ['*.js', '*.d.ts', 'src', 'doc', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'],
  publishConfig: { registry: 'https://registry.npmjs.org/', access: 'public' },
}
await writeFile(join(npmDir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
await cp(npmDir, modulesDir, { recursive: true })
for (const [directory, runtimeImport] of [[npmDir, `${sdkName}/autotrack`], [modulesDir, `@/uni_modules/${sdkName}/autotrack.js`]] as const) {
  await writeFile(join(directory, 'vite.js'), `import { gioUniappAutoTrack as create } from './vite-runtime.js'\nexport function gioUniappAutoTrack(options) {\n  return create(typeof options === 'string' ? options : { ...options, runtimeImport: options?.runtimeImport ?? ${JSON.stringify(runtimeImport)} })\n}\n`)
}
await writeFile(join(modulesDir, 'package.json'), `${JSON.stringify({
  ...packageJson, id: sdkName, displayName: 'GrowingIO uni-app SDK', keywords: ['GrowingIO', '统计', 'uni-app'],
  uni_modules: { dependencies: [], encrypt: [], platforms: { client: { 'uni-app': {
    vue: { vue2: 'x', vue3: '-' }, app: { vue: '-', nvue: 'x', android: '-', ios: '-', harmony: '-' },
    web: { chrome: 'x', safari: 'x' }, mp: Object.fromEntries(MINI_PROGRAM_TARGETS.map(target => [target.slice(3), '-'])),
  } } } },
}, null, 2)}\n`)

// 清单记录同一次构建的实际文件，用于检查遗漏、旧文件和两渠道的公共代码一致性。
await writeFile(join(dist, 'build-state.json'), JSON.stringify({ sourceHash: await sourceHash(), npm: await hashes(npmDir), uni: await hashes(modulesDir) }, null, 2))
const demoModule = join(root, 'demo/uni_modules', sdkName)
await rm(demoModule, { recursive: true, force: true })
await cp(modulesDir, demoModule, { recursive: true })
console.log(`sdk_built:${metadata.version}`)
