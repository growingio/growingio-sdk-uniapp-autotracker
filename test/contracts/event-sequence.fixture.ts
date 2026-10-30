import type { AppEventType } from './app-protocol.fixture.js'

export const GIO_STORAGE_PREFIX = 'gio:v1:'

export type EventSequenceRecord = Readonly<{
  version: 1
  expiresAt: null
  value: Readonly<{
    eventSequenceId: number
  }>
}>

export const EVENT_SEQUENCE_META_FIXTURE: EventSequenceRecord = {
  version: 1,
  expiresAt: null,
  value: { eventSequenceId: 41 },
}

export const EVENT_SEQUENCE_MIGRATION_VECTORS = [
  {
    name: '当前 envelope 从持久化值续号',
    input: EVENT_SEQUENCE_META_FIXTURE,
    expectedNextSequenceId: 42,
  },
  {
    name: '不存在 meta 时从正整数 1 开始',
    input: null,
    expectedNextSequenceId: 1,
  },
  {
    name: '损坏或不合法 meta 不可复用，重新从 1 开始并记录诊断',
    input: { version: 1, expiresAt: null, value: { eventSequenceId: 0 } },
    expectedNextSequenceId: 1,
    diagnostic: 'meta_corrupt',
  },
] as const

export const EVENT_SEQUENCE_ASSIGNMENT_VECTORS: readonly Readonly<{
  eventType: AppEventType
  assignsSequenceId: boolean
}>[] = [
  { eventType: 'VISIT', assignsSequenceId: true },
  { eventType: 'PAGE', assignsSequenceId: true },
  { eventType: 'CUSTOM', assignsSequenceId: true },
  { eventType: 'LOGIN_USER_ATTRIBUTES', assignsSequenceId: false },
  { eventType: 'APP_CLOSED', assignsSequenceId: false },
  { eventType: 'VIEW_CLICK', assignsSequenceId: true },
  { eventType: 'VIEW_CHANGE', assignsSequenceId: true },
]
