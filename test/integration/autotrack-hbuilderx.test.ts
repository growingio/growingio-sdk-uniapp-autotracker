import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

// HBuilderX 会给 @vue/shared 设置全局模块别名；单独测试正常 pnpm 解析无法覆盖混用版本的问题。
const probe = `
  require('tsx/cjs');
  const { createRequire } = require('node:module');
  const Module = require('node:module');
  const vueRequire = createRequire(require.resolve('vue'));
  const sharedPath = vueRequire.resolve('@vue/shared');
  const original = Module._resolveFilename;
  Module._resolveFilename = function(request, ...args) {
    return original.call(this, request === '@vue/shared' ? sharedPath : request, ...args);
  };
  const { transformAutoTrackSfc } = require('./src/compiler/vite.ts');
  const result = transformAutoTrackSfc('<script setup>const save = e => e</script><template><template v-if="true"><button @tap="save($event)"/></template></template>');
  if (!result.changed || result.warnings.length > 0) throw new Error('autotrack_transform_failed');
  console.log('hbuilderx_shared_alias_passed');
`

describe('HBuilderX compiler dependency boundary', () => {
  it('transforms an SFC with the host Vue shared alias in effect', () => {
    expect(execFileSync(process.execPath, ['--input-type=commonjs', '-e', probe], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    }).trim()).toBe('hbuilderx_shared_alias_passed')
  })
})
