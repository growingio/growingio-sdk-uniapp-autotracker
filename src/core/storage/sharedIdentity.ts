import type { StorageRead, StorageWrite } from '../../types/index.js'
import { assignedDeviceId, isWithinLimit, type Identity } from '../userStore.js'
import type { DeviceIdFactory, IdentityHydration } from './index.js'

const fields = ['deviceId', 'userId', 'userKey', 'lastUserId'] as const
export type IdentityField = typeof fields[number]
export type SharedIdentityKeys = Readonly<Record<IdentityField, string>>

export interface SharedIdentityStorage {
  read(key: string): StorageRead
  write(key: string, value: string): StorageWrite
  remove(key: string): StorageWrite
  canWrite?(key: string, value: string): boolean
}

type IdentityValues = Readonly<Record<IdentityField, string | null>>

/** The independent SDKs keep one string per identity field. Null represents an absent key. */
export class SharedIdentityPersistence {
  public constructor(private readonly storage: SharedIdentityStorage, private readonly keys: SharedIdentityKeys) {}

  public hydrate(factory: DeviceIdFactory, override?: Partial<Identity>, readOnly = false): IdentityHydration {
    const values = this.readValues()
    const stored = values.deviceId || null
    const deviceId = override?.deviceId ?? stored ?? assignedDeviceId(factory())
    if (deviceId === null) throw new Error('invalid_shared_device_id')
    const updates = { ...override, deviceId }
    if (!readOnly && (!this.canPersist(updates) || !this.writeValues(values, updates))) throw new Error('shared_identity_write_failed')
    const identity = readOnly ? this.identity({ ...values, deviceId }) : this.current()
    return { identity, source: stored === null && override?.deviceId === undefined ? 'generated' : 'restored' }
  }

  public current(): Identity {
    return this.identity(this.readValues())
  }

  public persist(expected: Identity, updates: Partial<Identity>): boolean {
    if (!this.canPersist(updates)) return false
    const values = this.readValues()
    const actual = this.identity(values)
    if (fields.some(field => actual[field] !== expected[field])) return false
    return this.writeValues(values, updates)
  }

  public canPersist(updates: Partial<Identity>): boolean {
    return fields.every(field => {
      const value = updates[field]
      if (value === undefined) return true
      if (field === 'deviceId' ? typeof value !== 'string' || value === '' || !isWithinLimit(value)
        : value !== null && (typeof value !== 'string' || !isWithinLimit(value))) return false
      return this.storage.canWrite?.(this.keys[field], value ?? '') !== false
    })
  }

  public renew(expected: Identity): void {
    const values = this.readValues()
    const actual = this.identity(values)
    if (fields.some(field => actual[field] !== expected[field])) return
    for (const field of fields) {
      const key = this.keys[field]
      const value = values[field]
      if (value && this.matches(key, value)) this.storage.write(key, value)
    }
  }

  private readValues(): IdentityValues {
    const values = { deviceId: null, userId: null, userKey: null, lastUserId: null } as Record<IdentityField, string | null>
    for (const field of fields) {
      const entry = this.storage.read(this.keys[field])
      if (entry.kind === 'missing') continue
      if (entry.kind !== 'value' || !isWithinLimit(entry.value)) {
        throw new Error(entry.kind === 'value' ? 'invalid_shared_identity' : entry.message ?? `shared_identity_${entry.kind}`)
      }
      values[field] = entry.value
    }
    return values
  }

  private identity(values: IdentityValues): Identity {
    if (!values.deviceId) throw new Error('missing_shared_device_id')
    return { deviceId: values.deviceId, userId: values.userId || null, userKey: values.userKey || null, lastUserId: values.lastUserId || null }
  }

  private writeValues(before: IdentityValues, updates: Partial<Identity>): boolean {
    const changes = fields.flatMap(field => {
      const value = updates[field]
      return value !== undefined && (value ?? '') !== before[field] ? [{ key: this.keys[field], before: before[field], value: value ?? '' }] : []
    })
    const applied: typeof changes = []
    for (const change of changes) {
      if (!this.matches(change.key, change.before)) {
        this.restore(applied)
        return false
      }
      applied.push(change)
      if (this.storage.write(change.key, change.value).kind !== 'ok' || !this.matches(change.key, change.value)) {
        this.restore(applied)
        return false
      }
    }
    return true
  }

  private matches(key: string, value: string | null): boolean {
    const entry = this.storage.read(key)
    return entry.kind === 'value' ? entry.value === value : entry.kind === 'missing' && (value === null || value === '')
  }

  private restore(changes: ReadonlyArray<{ key: string; before: string | null; value: string }>): void {
    for (const change of [...changes].reverse()) {
      if (!this.matches(change.key, change.value)) continue
      if (change.before === null) this.storage.remove(change.key)
      else this.storage.write(change.key, change.before)
    }
  }
}
