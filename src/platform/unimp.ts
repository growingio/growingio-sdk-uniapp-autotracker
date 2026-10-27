import { TrackerRuntime } from '../core/growingIO.js'
import { installAutoTrackDispatcher } from '../plugins/gioEventAutoTracking/index.js'
import { UniMPNativeModulePort } from './unimp-native-module.js'
import type { NativePluginHost } from './native-identifiers.js'
import { guid } from '../utils/tools.js'

export function createUniMPTracker(host: NativePluginHost): TrackerRuntime {
  const tracker = new TrackerRuntime({ unimp: {
    port: new UniMPNativeModulePort(host), clock: { now: () => Date.now() }, instanceIdFactory: guid,
    scheduler: { setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs), clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>) },
    warn: message => globalThis.console?.warn(message),
  } })
  installAutoTrackDispatcher(tracker)
  return tracker
}
