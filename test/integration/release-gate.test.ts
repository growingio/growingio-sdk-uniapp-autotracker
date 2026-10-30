import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const { scripts, packageManager } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string>; packageManager: string }

/** 在临时工程运行真实发布编排，以记录器替代外部副作用并模拟指定步骤失败。 */
function runGate(command: string, failAt?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'gio-release-gate-'))
  try {
    const bin = join(directory, 'node_modules/.bin')
    mkdirSync(bin, { recursive: true })
    // 保留真实发布命令的编排，用记录步骤的进程替代耗时检查和有外部副作用的打包/发布。
    const runner = `#!/usr/bin/env node
const fs = require('node:fs');
const names = { 'scripts/prepare-release.ts': 'pack', 'scripts/publish-release.ts': 'publish' };
const step = names[process.argv[2]] || process.argv[2];
fs.appendFileSync('steps.log', step + '\\n');
if (process.env.GIO_TEST_FAIL_STEP === step) process.exit(17);
`
    writeFileSync(join(directory, 'step.cjs'), runner)
    writeFileSync(join(bin, 'tsx'), runner, { mode: 0o755 })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({
      private: true,
      packageManager,
      scripts: { ...scripts,
        typecheck: 'node step.cjs types', 'test:coverage': 'node step.cjs tests',
        'build:sdk': 'node step.cjs build', 'release:check': 'node step.cjs artifacts',
      },
    }))
    const result = spawnSync('pnpm', ['run', command], {
      cwd: directory, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, GIO_TEST_FAIL_STEP: failAt ?? '' },
    })
    if (result.error) throw result.error
    return { status: result.status, steps: readFileSync(join(directory, 'steps.log'), 'utf8').trim().split('\n') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('打包发布前强制代码测试门禁', () => {
  it('真实类型配置检查测试与发布脚本，且首次运行不依赖生成包', () => {
    const output = join(root, 'test-results')
    mkdirSync(output, { recursive: true })
    const directory = mkdtempSync(join(output, 'typecheck-gate-'))
    try {
      for (const file of ['tsconfig.json', 'tsconfig.dev.json']) {
        writeFileSync(join(directory, file), readFileSync(join(root, file)))
      }
      for (const path of ['scripts', 'test/unit', 'test/type']) mkdirSync(join(directory, path), { recursive: true })
      const checked = ['scripts/fixture.ts', 'test/unit/fixture.test.ts']
      for (const file of checked) writeFileSync(join(directory, file), 'const value: string = 123; export { value }')
      // 这两份示例需要构建后的产物，应只由 release:check 检查。
      for (const file of ['gdp-compiled-consumer.ts', 'autotrack-consumer.ts']) {
        writeFileSync(join(directory, 'test/type', file), "import { artifact } from './missing-published-artifact.js'; void artifact")
      }
      const check = () => {
        const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', join(directory, 'tsconfig.dev.json')], {
          cwd: directory, encoding: 'utf8', timeout: 15_000,
        })
        if (result.error) throw result.error
        return result
      }
      const rejected = check()
      expect(rejected.status).not.toBe(0)
      for (const file of checked) expect(rejected.stdout).toContain(`${file}(1,7): error TS2322`)
      for (const file of checked) writeFileSync(join(directory, file), "const value: string = 'valid'; export { value }")
      const accepted = check()
      expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 30_000)

  const preparation = ['types', 'tests', 'build', 'pack', 'artifacts']
  it('打包依次运行类型、测试、构建、压缩包生成与交付包验证', () => {
    expect(runGate('release:prepare')).toEqual({ status: 0, steps: preparation })
  })

  it.each(preparation)('%s 失败立即停止，后续步骤不能继续', (step) => {
    const result = runGate('release:prepare', step)
    expect(result.status).not.toBe(0)
    expect(result.steps).toEqual(preparation.slice(0, preparation.indexOf(step) + 1))
  })

  it('直接调用发布入口也先检查源码及已有交付包，不重新生成待发布包', () => {
    expect(runGate('release:publish')).toEqual({ status: 0, steps: ['types', 'tests', 'artifacts', 'publish'] })
  })

  it.each(['types', 'tests', 'artifacts'])('发布入口在 %s 失败时不能执行 npm 发布步骤', (step) => {
    const result = runGate('release:publish', step)
    expect(result.status).not.toBe(0)
    expect(result.steps).not.toContain('publish')
  })
})
