import { describe, expect, it, vi } from 'vitest'
import type { StoragePort, StorageRead } from '../../src/types/index.js'
import { IdentityPersistence } from '../../src/core/storage/index.js'
import { serializeIdentityRecord } from '../../src/core/userStore.js'
import { MetaPersistence } from '../../src/core/storage/index.js'
import { SessionPersistence } from '../../src/core/storage/index.js'
import { QueuePersistence } from '../../src/core/storage/index.js'
import { EventQueue } from '../../src/core/queue.js'

/** 记录分区读写和删除操作，确认各类缓存故障不会越界清理。 */
function backend(read: StorageRead) {
  const write = vi.fn<StoragePort['write']>().mockResolvedValue({ kind: 'ok' })
  const remove = vi.fn<StoragePort['remove']>().mockResolvedValue({ kind: 'ok' })
  const port: StoragePort = { persistentQueue: true, read: async () => read, write, remove }
  return { port, write, remove }
}

describe('核心存储失败与恢复边界', () => {
  it.each(['missing', 'unavailable', 'corrupt'] as const)('宿主返回 %s 时各记录独立恢复且只清理自己的键', async (kind) => {
    const store = backend({ kind })
    const identity = await new IdentityPersistence(store.port, 'identity', 'source', () => 'new-device').hydrate()
    expect(identity).toMatchObject({ identity: { deviceId: 'new-device' }, source: kind === 'missing' ? 'generated' : kind })
    expect(await new SessionPersistence(store.port, 'session').hydrate()).toEqual({ source: kind, snapshot: null })
    expect(await new MetaPersistence(store.port, 'meta').hydrate()).toEqual({ source: kind, snapshot: { eventSequenceId: 0 } })
    expect(await new QueuePersistence(store.port, 'queue').hydrate(new EventQueue())).toBe(kind)
    expect(store.remove.mock.calls).toEqual(kind === 'corrupt'
      ? [['state', 'identity'], ['state', 'session'], ['state', 'meta'], ['queue', 'queue']] : [])
    expect(store.write).toHaveBeenCalledTimes(kind === 'unavailable' ? 0 : 1)
  })

  it.each([null, [], { version: 2 }, { version: 1, expiresAt: 1, value: {} }, { version: 1, expiresAt: null, value: null }])(
    '拒绝无效持久化结构 %j，不将损坏记录带入运行状态', async (record) => {
      const store = backend({ kind: 'value', value: JSON.stringify(record) })
      expect(await new SessionPersistence(store.port, 'session').hydrate()).toMatchObject({ source: 'corrupt', snapshot: null })
      expect(await new MetaPersistence(store.port, 'meta').hydrate()).toMatchObject({ source: 'corrupt', snapshot: { eventSequenceId: 0 } })
      expect(await new QueuePersistence(store.port, 'queue').hydrate(new EventQueue())).toBe('corrupt')
      expect(store.remove.mock.calls).toEqual([['state', 'session'], ['state', 'meta'], ['queue', 'queue']])
    },
  )

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('拒绝非法持久化序列号 %s，且不写入存储', async (eventSequenceId) => {
    const store = backend({ kind: 'missing' })
    expect(await new MetaPersistence(store.port, 'meta').persist({ eventSequenceId })).toMatchObject({ kind: 'failed' })
    expect(store.write).not.toHaveBeenCalled()
  })

  it.each([-1, NaN, Infinity])('拒绝非法会话关闭时间 %s，且不写入存储', async (lastCloseTime) => {
    const store = backend({ kind: 'missing' })
    expect(await new SessionPersistence(store.port, 'session').persist({ sessionId: 'session', lastCloseTime })).toMatchObject({ kind: 'failed' })
    expect(store.write).not.toHaveBeenCalled()
  })

  it.each(['missing', 'legacy-device'] as const)('身份生成或迁移（%s）遇到写入异常仍保留本次进程可用身份', async (mode) => {
    const store = backend(mode === 'missing' ? { kind: 'missing' } : {
      kind: 'value', value: serializeIdentityRecord({ deviceId: 'device-old-preview', userId: 'user', userKey: null }, 'source'),
    })
    store.write.mockRejectedValue(new Error('storage unavailable'))
    expect(await new IdentityPersistence(store.port, 'identity', 'source', () => 'new-device').hydrate()).toMatchObject({
      source: 'generated', identity: { deviceId: 'new-device', userId: mode === 'missing' ? null : 'user' },
    })
    expect(store.write).toHaveBeenCalledOnce()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('队列写入抛错后，后续写入仍执行且版本只按成功写入递增', async () => {
    const store = backend({ kind: 'missing' })
    store.write.mockRejectedValueOnce(new Error('disk failure'))
    const persistence = new QueuePersistence(store.port, 'queue')
    const queue = new EventQueue()
    const failed = persistence.persist(queue)
    const recovered = persistence.persist(queue)
    expect(await failed).toEqual({ kind: 'failed' })
    expect(await recovered).toEqual({ kind: 'ok' })
    expect(persistence.currentRevision()).toBe(1)
    expect(store.write.mock.calls.map(([, , value]) => JSON.parse(value).revision)).toEqual([1, 1])
    expect(await persistence.persist(queue)).toEqual({ kind: 'ok' })
    expect(persistence.currentRevision()).toBe(2)
  })
})
