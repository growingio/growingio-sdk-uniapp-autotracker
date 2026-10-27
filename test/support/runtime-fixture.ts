import type { AppSystemContext, StoragePort, StorageRead, StorageWrite } from '../../src/types/index.js'
import { TrackerRuntime, type TrackerRuntimeDependencies } from '../../src/core/growingIO.js'

export const appSystem: AppSystemContext = {
  platform: 'Android', platformVersion: '14', domain: 'example.app', appState: 'FOREGROUND', appName: 'Example',
  networkState: 'WIFI', screenWidth: 390, screenHeight: 844, deviceBrand: 'Google', deviceModel: 'Pixel',
  deviceType: 'PHONE', appVersion: '1', language: 'zh-CN', sdkVersion: '0.1.0',
}

export class RuntimeStorage implements StoragePort {
  public readonly values = new Map<string, string>()
  public readonly reads: string[] = []
  public readonly writes: string[] = []
  public constructor(public readonly persistentQueue = true) {}
  public async read(_area: unknown, key: string): Promise<StorageRead> {
    this.reads.push(key)
    const value = this.values.get(key)
    return value === undefined ? { kind: 'missing' } : { kind: 'value', value }
  }
  public async write(_area: unknown, key: string, value: string): Promise<StorageWrite> {
    this.writes.push(key); this.values.set(key, value); return { kind: 'ok' }
  }
  public async remove(_area: unknown, key: string): Promise<StorageWrite> { this.values.delete(key); return { kind: 'ok' } }
}

export function runtimeFixture(overrides: Partial<TrackerRuntimeDependencies> = {}) {
  let now = 100
  let session = 0
  const storage = new RuntimeStorage()
  const tracker = new TrackerRuntime({
    storage, systemContext: { load: async () => appSystem }, clock: { now: () => now }, timezone: { getOffsetMinutes: () => -480 },
    deviceIdFactory: () => 'generated-device', sessionIdFactory: () => `session-${++session}`, orientation: () => 'PORTRAIT', ...overrides,
  })
  return { tracker, storage, setNow: (value: number) => { now = value } }
}
