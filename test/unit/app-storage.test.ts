import { describe, expect, it } from 'vitest'

import { AppStoragePort, type AppStorageApi } from '../../src/platform/uni.js'

/** 创建同步存储宿主替身，供端口的成功与失败分类验证。 */
function api(overrides: Partial<AppStorageApi> = {}): AppStorageApi {
  return {
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
    ...overrides,
  }
}

describe('AppStoragePort', () => {
  it.each([new Error('permission denied'), 'host error'])('写入和删除失败 %s 不向调用方抛错', async (error) => {
    const storage = new AppStoragePort(api({ setStorageSync: () => { throw error }, removeStorageSync: () => { throw error } }))
    const failure = { kind: 'failed', message: error instanceof Error ? error.message : undefined }
    await expect(storage.write('state', 'identity', 'value')).resolves.toEqual(failure)
    await expect(storage.remove('state', 'identity')).resolves.toEqual(failure)
  })
  it('is a persistent queue adapter and preserves string-only boundary values', async () => {
    const storage = new AppStoragePort(api({ getStorageSync: () => '{"version":1}' }))
    expect(storage.persistentQueue).toBe(true)
    await expect(storage.read('state', 'gio:v1:a:identity')).resolves.toStrictEqual({ kind: 'value', value: '{"version":1}' })
    await expect(new AppStoragePort(api({ getStorageSync: () => 1 })).read('state', 'key')).resolves.toStrictEqual({ kind: 'corrupt', message: 'storage_value_not_string' })
  })

  it('normalizes missing and host read failures', async () => {
    await expect(new AppStoragePort(api({ getStorageSync: () => '' })).read('state', 'key')).resolves.toStrictEqual({ kind: 'missing' })
    await expect(new AppStoragePort(api({ getStorageSync: () => { throw new Error('blocked') } })).read('state', 'key')).resolves.toStrictEqual({ kind: 'unavailable', message: 'blocked' })
  })

  it('maps writes/removes, including a capacity failure', async () => {
    const calls: string[] = []
    const storage = new AppStoragePort(api({
      setStorageSync: (key, value) => { calls.push(`${key}:${value}`) },
      removeStorageSync: (key) => { calls.push(`remove:${key}`) },
    }))
    await expect(storage.write('queue', 'key', 'value')).resolves.toStrictEqual({ kind: 'ok' })
    await expect(storage.remove('queue', 'key')).resolves.toStrictEqual({ kind: 'ok' })
    expect(calls).toStrictEqual(['key:value', 'remove:key'])
    await expect(new AppStoragePort(api({ setStorageSync: () => { throw new Error('storage quota full') } })).write('queue', 'key', 'value')).resolves.toStrictEqual({ kind: 'quota', message: 'storage quota full' })
  })
})
