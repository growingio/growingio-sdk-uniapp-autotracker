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
type IdentityRecovery = Readonly<{ version: 1; keys: SharedIdentityKeys; before: IdentityValues; after: IdentityValues }>

/** The independent SDKs keep one string per identity field. Null represents an absent key. */
export class SharedIdentityPersistence {
  private readonly recoveryKey: string | null

  public constructor(private readonly storage: SharedIdentityStorage, private readonly keys: SharedIdentityKeys, recoverMiniProgramWrites = false) {
    // This scope follows the actual shared keys, which deliberately outlive account/source configuration changes.
    this.recoveryKey = recoverMiniProgramWrites
      ? `gio:mp:v1:shared-identity:${fields.map(field => encodeURIComponent(keys[field])).join(':')}:pending`
      : null
  }

  public hydrate(factory: DeviceIdFactory, override?: Partial<Identity>, readOnly = false): IdentityHydration {
    const pending = this.readRecovery()
    const values = pending === null ? this.readValues() : this.recover(pending)
    const stored = values.deviceId || null
    const deviceId = override?.deviceId ?? stored ?? assignedDeviceId(factory())
    if (deviceId === null) throw new Error('invalid_shared_device_id')
    const updates = { ...override, deviceId }
    if (!readOnly && (!this.canPersist(updates) || !this.writeValues(values, updates))) throw new Error('shared_identity_write_failed')
    const identity = readOnly ? this.identity({ ...values, deviceId }) : this.current()
    return { identity, source: stored === null && override?.deviceId === undefined ? 'generated' : 'restored' }
  }

  public current(confirmedDeviceId?: string): Identity {
    this.readRecovery()
    return this.identityForUpdate(this.readValues(), confirmedDeviceId)
  }

  public persist(expected: Identity, updates: Partial<Identity>): boolean {
    if (!this.canPersist(updates)) return false
    const pending = this.readRecovery()
    let values = this.readValues()
    const actual = this.identityForUpdate(values, expected.deviceId)
    if (fields.some(field => actual[field] !== expected[field])) return false
    if (pending !== null) {
      values = this.recover(pending)
      const recovered = this.identityForUpdate(values, expected.deviceId)
      if (fields.some(field => recovered[field] !== expected[field] && updates[field] === undefined)) return false
    }
    if (this.recoveryKey !== null && values.deviceId === null) {
      // An explicit operation can repair a genuinely missing device using this process's confirmed ID.
      // Login fields always come from storage; a cleared login must not be resurrected from memory.
      updates = { ...updates, deviceId: updates.deviceId ?? expected.deviceId,
        ...(updates.userId === null && !values.lastUserId ? { lastUserId: null } : {}) }
    }
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

  private identityForUpdate(values: IdentityValues, confirmedDeviceId?: string): Identity {
    return this.identity(this.recoveryKey !== null && values.deviceId === null && confirmedDeviceId !== undefined
      ? { ...values, deviceId: confirmedDeviceId } : values)
  }

  private sameValues(left: IdentityValues, right: IdentityValues): boolean {
    return fields.every(field => left[field] === right[field])
  }

  private readRecovery(): IdentityRecovery | null {
    if (this.recoveryKey === null) return null
    const entry = this.storage.read(this.recoveryKey)
    if (entry.kind === 'missing' || entry.kind === 'value' && entry.value === '') return null
    if (entry.kind !== 'value') throw new Error('shared_identity_recovery_unavailable')
    try {
      const record: unknown = JSON.parse(entry.value)
      if (typeof record !== 'object' || record === null || Array.isArray(record)) throw new Error()
      const value = record as Record<string, unknown>
      const validValues = (snapshot: unknown): snapshot is IdentityValues => {
        if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return false
        const values = snapshot as Record<string, unknown>
        return Object.keys(values).length === fields.length && fields.every(field => values[field] === null
          || typeof values[field] === 'string' && isWithinLimit(values[field]))
      }
      const keys = value.keys as SharedIdentityKeys | undefined
      if (value.version !== 1 || keys === undefined || keys === null || fields.some(field => keys[field] !== this.keys[field])
        || !validValues(value.before) || !validValues(value.after) || !value.after.deviceId) throw new Error()
      return { version: 1, keys: this.keys, before: value.before, after: value.after }
    } catch { throw new Error('invalid_shared_identity_recovery') }
  }

  private ownsRecovery(record: IdentityRecovery): boolean {
    const current = this.readRecovery()
    return current !== null && this.sameValues(current.before, record.before) && this.sameValues(current.after, record.after)
  }

  private finishRecovery(record: IdentityRecovery): void {
    if (!this.ownsRecovery(record) || this.storage.remove(this.recoveryKey!).kind !== 'ok'
      || this.readRecovery() !== null) throw new Error('shared_identity_recovery_write_failed')
  }

  private recover(record: IdentityRecovery): IdentityValues {
    let values = this.readValues()
    if (!this.sameValues(values, record.after)) {
      for (const field of [...fields].reverse()) {
        values = this.readValues()
        if (!this.ownsRecovery(record) || fields.some(key => values[key] !== record.before[key] && values[key] !== record.after[key])) {
          throw new Error('shared_identity_recovery_conflict')
        }
        if (values[field] === record.before[field]) continue
        const before = record.before[field]
        const result = before === null ? this.storage.remove(this.keys[field]) : this.storage.write(this.keys[field], before)
        if (result.kind !== 'ok' || !this.matches(this.keys[field], before)) throw new Error('shared_identity_recovery_write_failed')
      }
      values = this.readValues()
      if (!this.sameValues(values, record.before)) throw new Error('shared_identity_recovery_conflict')
    }
    this.finishRecovery(record)
    return values
  }

  private writeValues(before: IdentityValues, updates: Partial<Identity>): boolean {
    const changes = fields.flatMap(field => {
      const value = updates[field]
      return value !== undefined && (value ?? '') !== before[field] ? [{ key: this.keys[field], before: before[field], value: value ?? '' }] : []
    })
    if (changes.length === 0) return true
    const after = { ...before }
    for (const field of fields) if (updates[field] !== undefined) after[field] = updates[field] ?? ''
    const recovery: IdentityRecovery | null = this.recoveryKey === null ? null : { version: 1, keys: this.keys, before, after }
    if (recovery !== null) {
      const serialized = JSON.stringify(recovery)
      if (this.storage.write(this.recoveryKey!, serialized).kind !== 'ok' || !this.matches(this.recoveryKey!, serialized)) return false
    }
    const applied: typeof changes = []
    const restore = () => {
      if (recovery === null) this.restore(applied)
      else { try { this.recover(recovery) } catch { /* Leave the recovery record for a repaired retry or restart. */ } }
    }
    for (const change of changes) {
      if (!this.matches(change.key, change.before)) {
        restore()
        return false
      }
      applied.push(change)
      if (this.storage.write(change.key, change.value).kind !== 'ok' || !this.matches(change.key, change.value)) {
        restore()
        return false
      }
    }
    if (recovery !== null) {
      try {
        if (!this.sameValues(this.readValues(), after)) { restore(); return false }
        this.finishRecovery(recovery)
      } catch { return false }
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
