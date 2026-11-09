import { readIdentityRecord, serializeIdentityRecord, type Identity, type SessionSnapshot } from '../userStore.js'
import type { StoragePort, StorageWrite } from '../../types/index.js'
import type { EventSequenceSnapshot } from '../dataStore/index.js'
import { EventQueue, type QueueEntry } from '../queue.js'

export const GIO_STORAGE_PREFIX = 'gio:v1:'

export type StorageKeys = Readonly<{
  identity: string
  session: string
  meta: string
  queue: string
}>

/** 为同一数据源生成身份、会话、序号和队列的独立存储键。 */
export function storageKeys(dataSourceId: string, mini?: Readonly<{ target: string; appId: string; accountId: string }>): StorageKeys {
  const prefix = mini === undefined ? `${GIO_STORAGE_PREFIX}${dataSourceId}:`
    : `gio:mp:v1:${[mini.target, mini.appId, mini.accountId, dataSourceId].map(value => encodeURIComponent(value)).join(':')}:`
  return { identity: `${prefix}identity`, session: `${prefix}session`, meta: `${prefix}meta`, queue: `${prefix}queue:v1` }
}

type PendingWrite<Value> = {
  value: Value
  result: Promise<StorageWrite>
  resolve: (result: StorageWrite) => void
}

/** 每个键独占一个写入槽位；新快照合并到唯一待写项，避免乱序回退与无界 Promise 链。 */
class LatestStorageWriter<Value = string> {
  private writing = false
  private pending: PendingWrite<Value> | null = null

  /** 注入当前键的编码写入过程，键之间不互相等待。 */
  public constructor(private readonly commit: (value: Value) => Promise<StorageWrite>) {}

  /** 捕获不可变值；同一待写批次共用最终最新快照的写入结果。 */
  public persist(value: Value): Promise<StorageWrite> {
    if (this.pending !== null) {
      this.pending.value = value
      return this.pending.result
    }
    let resolveResult: (result: StorageWrite) => void = () => undefined
    const result = new Promise<StorageWrite>(resolve => { resolveResult = resolve })
    const next = { value, result, resolve: resolveResult }
    if (this.writing) this.pending = next
    else {
      this.writing = true
      void this.write(next)
    }
    return result
  }

  /** 当前写入无论成功或失败，都继续处理最新待写值。 */
  private async write(next: PendingWrite<Value>): Promise<void> {
    try { next.resolve(await this.commit(next.value)) }
    catch { next.resolve({ kind: 'failed' }) }
    const pending = this.pending
    this.pending = null
    if (pending !== null) void this.write(pending)
    else this.writing = false
  }
}

export type IdentityHydration = Readonly<{
  identity: Identity
  source: 'restored' | 'legacy' | 'generated' | 'corrupt' | 'unavailable'
}>

export type DeviceIdFactory = () => string

/** 调用内部设备标识工厂创建匿名身份，拒绝空标识。 */
function generatedIdentity(factory: DeviceIdFactory): Identity {
  const deviceId = factory()
  if (typeof deviceId !== 'string' || deviceId.length === 0) throw new Error('device_id_factory_returned_empty')
  return { deviceId, userId: null, userKey: null }
}

/** 恢复一份身份记录，损坏清理仅限本 SDK 当前命名空间的键。 */
export class IdentityPersistence {
  private readonly writer = new LatestStorageWriter(value => this.storage.write('state', this.key, value))
  /** 绑定数据源命名空间、宿主存储和设备标识工厂。 */
  public constructor(
    private readonly storage: StoragePort,
    private readonly key: string,
    private readonly dataSourceId: string,
    private readonly deviceIdFactory: DeviceIdFactory,
    private readonly legacyIdentity?: () => Identity | null,
  ) {}

  /** 恢复有效身份；缺失或损坏时生成新身份，损坏清理仅限当前键。 */
  public async hydrate(): Promise<IdentityHydration> {
    const read = await this.storage.read('state', this.key)
    if (read.kind === 'missing') {
      let legacy: Identity | null | undefined
      try { legacy = this.legacyIdentity?.() } catch { legacy = null }
      if (legacy != null) {
        await this.persist(legacy)
        return { identity: legacy, source: 'legacy' }
      }
      return this.generateAndPersist('generated')
    }
    if (read.kind === 'unavailable') return { identity: generatedIdentity(this.deviceIdFactory), source: 'unavailable' }
    if (read.kind === 'corrupt') {
      await this.storage.remove('state', this.key)
      return this.generateAndPersist('corrupt')
    }
    if (read.kind !== 'value') return { identity: generatedIdentity(this.deviceIdFactory), source: 'unavailable' }

    const decoded = readIdentityRecord(read.value, this.dataSourceId)
    if (decoded.kind === 'corrupt') {
      await this.storage.remove('state', this.key)
      return this.generateAndPersist('corrupt')
    }
    return { identity: decoded.identity, source: 'restored' }
  }

  /** 按当前身份信封编码后写入对应存储键。 */
  public persist(identity: Identity): Promise<StorageWrite> {
    return this.writer.persist(serializeIdentityRecord(identity, this.dataSourceId))
  }

  /** 首次生成身份后尽力持久化，使下次冷启动可恢复；写入失败不阻塞初始化。 */
  private async generateAndPersist(source: 'generated' | 'corrupt'): Promise<IdentityHydration> {
    const identity = generatedIdentity(this.deviceIdFactory)
    try {
      await this.persist(identity)
    } catch {
      // 写入失败不阻塞初始化，下次启动按实际存储结果重新恢复。
    }
    return { identity, source }
  }
}

export type SessionHydration = Readonly<{ snapshot: SessionSnapshot | null; source: 'restored' | 'missing' | 'corrupt' | 'unavailable' }>

/** 校验非空会话标识及有效后台时间，拒绝不完整的缓存结构。 */
function validSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, unknown>>
  return typeof record.sessionId === 'string' && record.sessionId.length > 0
    && (record.lastCloseTime === null || (typeof record.lastCloseTime === 'number' && Number.isFinite(record.lastCloseTime) && record.lastCloseTime >= 0))
}

/** 将会话快照封装为带版本的持久记录。 */
function encodeSession(snapshot: SessionSnapshot): string {
  return JSON.stringify({ version: 1, expiresAt: null, value: snapshot })
}

/** 会话故障与身份、序号记录隔离，不执行大范围宿主存储清理。 */
export class SessionPersistence {
  private readonly writer = new LatestStorageWriter(value => this.storage.write('state', this.key, value))
  /** 绑定会话专属存储键，使会话故障与其他状态隔离。 */
  public constructor(private readonly storage: StoragePort, private readonly key: string) {}

  /** 恢复合法会话信封，损坏时仅删除当前会话记录并返回空快照。 */
  public async hydrate(): Promise<SessionHydration> {
    const read = await this.storage.read('state', this.key)
    if (read.kind === 'missing') return { snapshot: null, source: 'missing' }
    if (read.kind === 'unavailable') return { snapshot: null, source: 'unavailable' }
    if (read.kind === 'corrupt') {
      await this.storage.remove('state', this.key)
      return { snapshot: null, source: 'corrupt' }
    }
    if (read.kind !== 'value') return { snapshot: null, source: 'unavailable' }
    try {
      const record: unknown = JSON.parse(read.value)
      if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error('session_record_corrupt')
      const envelope = record as Readonly<Record<string, unknown>>
      if (envelope.version !== 1 || envelope.expiresAt !== null || !validSessionSnapshot(envelope.value)) throw new Error('session_record_corrupt')
      return { snapshot: envelope.value, source: 'restored' }
    } catch {
      await this.storage.remove('state', this.key)
      return { snapshot: null, source: 'corrupt' }
    }
  }

  /** 先验证会话快照，再写入带版本的记录；非法值不修改存储。 */
  public persist(snapshot: SessionSnapshot): Promise<StorageWrite> {
    if (!validSessionSnapshot(snapshot)) return Promise.resolve({ kind: 'failed', message: 'invalid_session_snapshot' })
    return this.writer.persist(encodeSession(snapshot))
  }
}

export type MetaHydration = Readonly<{ snapshot: EventSequenceSnapshot; source: 'restored' | 'missing' | 'corrupt' | 'unavailable' }>

/** 确认全局序号为非负安全整数。 */
function validMetaSnapshot(value: unknown): value is EventSequenceSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const sequence = (value as Record<string, unknown>).eventSequenceId
  return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0
}

/** 独立持久化全局序号，避免身份或会话故障导致编号重置。 */
export class MetaPersistence {
  private readonly writer = new LatestStorageWriter(value => this.storage.write('state', this.key, value))
  /** 绑定事件序号专属存储键。 */
  public constructor(private readonly storage: StoragePort, private readonly key: string) {}

  /** 独立恢复事件序号；缺失或不可用时从零开始，损坏时清理当前键。 */
  public async hydrate(): Promise<MetaHydration> {
    const read = await this.storage.read('state', this.key)
    if (read.kind === 'missing') return { snapshot: { eventSequenceId: 0 }, source: 'missing' }
    if (read.kind === 'unavailable') return { snapshot: { eventSequenceId: 0 }, source: 'unavailable' }
    if (read.kind === 'corrupt') return this.corrupt()
    if (read.kind !== 'value') return { snapshot: { eventSequenceId: 0 }, source: 'unavailable' }
    try {
      const parsed: unknown = JSON.parse(read.value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('meta_corrupt')
      const record = parsed as Record<string, unknown>
      if (record.version !== 1 || record.expiresAt !== null || !validMetaSnapshot(record.value)) throw new Error('meta_corrupt')
      return { snapshot: record.value, source: 'restored' }
    } catch {
      return this.corrupt()
    }
  }

  /** 只持久化合法的序号快照，避免污染下次启动状态。 */
  public persist(snapshot: EventSequenceSnapshot): Promise<StorageWrite> {
    if (!validMetaSnapshot(snapshot)) return Promise.resolve({ kind: 'failed', message: 'invalid_meta_snapshot' })
    return this.writer.persist(JSON.stringify({ version: 1, expiresAt: null, value: snapshot }))
  }

  /** 删除损坏的序号记录并明确返回重置来源。 */
  private async corrupt(): Promise<MetaHydration> {
    await this.storage.remove('state', this.key)
    return { snapshot: { eventSequenceId: 0 }, source: 'corrupt' }
  }
}

type PersistedQueue = Readonly<{ version: 1; revision: number; entries: readonly QueueEntry[] }>

export type QueueHydration = 'restored' | 'missing' | 'corrupt' | 'unavailable'

/** 初步检查队列信封的版本、修订号和条目数组，具体事件由队列继续验证。 */
function validRecord(value: unknown): value is PersistedQueue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Readonly<Record<string, unknown>>
  return record.version === 1 && typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
    && record.revision >= 0 && Array.isArray(record.entries)
}

/** 将队列快照及其修订号编码到同一 JSON 信封。 */
function encodeQueue(revision: number, entries: string): string {
  return `{"version":1,"revision":${revision},"entries":${entries}}`
}

/** 合并写入所需的最小定时器端口。 */
export type QueuePersistenceThrottle = Readonly<{
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
  delayMs: number
}>

/** App 队列默认的合并写入窗口：突发事件只整队写一次，且写入不在业务调用栈内同步执行。 */
export const APP_QUEUE_PERSIST_DELAY_MS = 1_000

/** 串行写入并合并尚未开始的快照；内存最多保留一份在写和一份待写内容。 */
export class QueuePersistence {
  private revision = 0
  private readonly writer = new LatestStorageWriter<() => string>(snapshot => this.write(snapshot()))
  private scheduled: { handle: unknown; queue: EventQueue } | null = null

  /** 绑定队列存储键，并建立按顺序执行的写入链；提供 throttle 时 request 在窗口结束后合并写入。 */
  public constructor(private readonly storage: StoragePort, private readonly key: string, private readonly throttle?: QueuePersistenceThrottle) {}

  /** 请求持久化：无 throttle 时立即写入；有 throttle 时窗口内多次请求只写一次最新快照。 */
  public request(queue: EventQueue): void {
    if (this.throttle === undefined || this.throttle.delayMs <= 0) { void this.persist(queue); return }
    if (this.scheduled !== null) { this.scheduled.queue = queue; return }
    const scheduled: { handle: unknown; queue: EventQueue } = { handle: undefined, queue }
    this.scheduled = scheduled
    scheduled.handle = this.throttle.setTimeout(() => {
      if (this.scheduled !== scheduled) return
      this.scheduled = null
      void this.persist(scheduled.queue)
    }, this.throttle.delayMs)
  }

  /** 立即写入尚在合并窗口内的快照，用于进入后台等可能被系统挂起或回收的时刻。 */
  public flush(queue?: EventQueue): Promise<StorageWrite> | null {
    const scheduled = this.scheduled
    if (scheduled === null && queue === undefined) return null
    if (scheduled !== null) {
      this.scheduled = null
      try { this.throttle?.clearTimeout(scheduled.handle) } catch { /* 定时器取消失败时由已清空的标记阻止重复写入。 */ }
    }
    return this.persist(queue ?? scheduled!.queue)
  }

  /** 是否存在尚未写入的合并请求。 */
  public pending(): boolean { return this.scheduled !== null }

  /** 完整校验后恢复队列与修订号，损坏记录仅在本键范围内清理。 */
  public async hydrate(queue: EventQueue): Promise<QueueHydration> {
    const read = await this.storage.read('queue', this.key)
    if (read.kind === 'missing') return 'missing'
    if (read.kind === 'unavailable') return 'unavailable'
    if (read.kind === 'corrupt') {
      await this.storage.remove('queue', this.key)
      return 'corrupt'
    }
    if (read.kind !== 'value') return 'unavailable'
    try {
      const parsed: unknown = JSON.parse(read.value)
      if (!validRecord(parsed) || !queue.restore(parsed.entries)) throw new Error('queue_record_corrupt')
      this.revision = parsed.revision
      // 部分条目无效或超出容量时，立即写回清理后的快照，下次启动不再重复校验这些条目。
      if (queue.lastRestoreDropped() > 0) void this.persist(queue)
      return 'restored'
    } catch {
      await this.storage.remove('queue', this.key)
      return 'corrupt'
    }
  }

  /** 捕获不可变条目快照，仅在实际写入时编码；合并掉的中间快照不重复编码整队列。 */
  public persist(queue: EventQueue): Promise<StorageWrite> {
    return this.writer.persist(queue.captureSerializedEntries())
  }

  /** 唯一写入槽位失败后仍继续最新待写快照，修订号保持安全整数。 */
  private async write(entries: string): Promise<StorageWrite> {
    const revision = this.revision === Number.MAX_SAFE_INTEGER ? 1 : this.revision + 1
    const result = await this.storage.write('queue', this.key, encodeQueue(revision, entries))
    if (result.kind === 'ok') this.revision = revision
    return result
  }

  /** 读取最近一次成功持久化的队列修订号。 */
  public currentRevision(): number {
    return this.revision
  }
}
