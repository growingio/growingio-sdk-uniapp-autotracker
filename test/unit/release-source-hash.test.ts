import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sourceHash } from '../../scripts/release-layout.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'gio-release-hash-'))
  temporary.push(directory)
  for (const path of ['src', 'doc', 'scripts', 'test', '.github/workflows', 'demo']) await mkdir(join(directory, path), { recursive: true })
  for (const file of ['index.ts', 'autotrack.ts', 'vite.ts', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', 'tsconfig.dev.json', 'vitest.config.ts', 'README.md', 'LICENSE',
    'demo/main.ts', 'demo/sdk-state.ts', 'demo/miniprogram-config.ts']) await writeFile(join(directory, file), 'fixture')
  return directory
}

describe('release source evidence', () => {
  it.each(['main.ts', 'sdk-state.ts', 'miniprogram-config.ts'])('invalidates prior compiler evidence when demo/%s changes', async file => {
    const directory = await fixture()
    const before = await sourceHash(directory)
    await writeFile(join(directory, 'demo', file), 'changed consumer input')
    expect(await sourceHash(directory)).not.toBe(before)
  })

  it('keeps generated demo modules out of the source evidence to avoid a self-reference', async () => {
    const directory = await fixture()
    const before = await sourceHash(directory)
    const generated = join(directory, 'demo/uni_modules/sdk')
    await mkdir(generated, { recursive: true }); await writeFile(join(generated, 'index.js'), 'generated SDK')
    expect(await sourceHash(directory)).toBe(before)
  })
})
