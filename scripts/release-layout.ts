import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const dist = join(root, 'dist')
export const sdkName = 'gio-uniapp-autotracker'
export const npmDir = join(dist, 'npm')
export const modulesDir = join(dist, 'uni_modules', sdkName)
export const archivesDir = join(dist, 'release')
export const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  name: string; version: string; description: string
}
export const runtimeEntries = ['index.js', 'index.d.ts', 'autotrack.js', 'autotrack.d.ts', 'src']

/** 递归列举目录中的普通文件并排序，拒绝符号链接等非普通交付项。 */
export async function files(directory: string, prefix = ''): Promise<string[]> {
  const output: string[] = []
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) output.push(...await files(directory, path))
    else if (entry.isFile()) output.push(path)
    else throw new Error(`release_non_regular_file:${path}`)
  }
  return output.sort()
}

/** 计算交付目录中每个文件的摘要，用于双渠道与实际安装文件核对。 */
export async function hashes(directory: string): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all((await files(directory)).map(async (file) => [file,
    createHash('sha256').update(await readFile(join(directory, file))).digest('hex')])))
}

/** 对源码、测试、文档和发布配置共同计算构建依据，阻止复用过期交付包。 */
export async function sourceHash(baseDirectory = root): Promise<string> {
  const inputs = ['index.ts', 'autotrack.ts', 'vite.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.dev.json', 'vitest.config.ts', 'README.md', 'LICENSE',
    // 编译矩阵直接使用这些 demo 源码；不扫描生成的 demo/uni_modules，避免构建摘要自引用。
    'demo/main.ts', 'demo/sdk-state.ts', 'demo/miniprogram-config.ts']
  // 测试与门禁配置也属于本次构建依据，改动后不能沿用旧交付包的检查结果。
  for (const directory of ['src', 'doc', 'scripts', 'test', '.github/workflows']) inputs.push(...(await files(join(baseDirectory, directory))).map((file) => `${directory}/${file}`))
  const hash = createHash('sha256')
  for (const file of inputs.sort()) hash.update(file).update('\0').update(await readFile(join(baseDirectory, file))).update('\0')
  return hash.digest('hex')
}
