import { LocalTrackerRuntime, type LocalTrackerRuntimeDependencies } from './localRuntime.js'
import { UniMPRuntime, type UniMPDependencies } from '../plugins/gioHybridAdapter/runtime.js'
import type { GioBuiltinPlugin } from './lifecycle.js'
import type { AppEntrySnapshot } from './dataStore/app.js'
import type { PageLoadInput } from './dataStore/page.js'
import type { AutoTrackCall } from '../plugins/gioEventAutoTracking/contract.js'

export type TrackerRuntimeDependencies = LocalTrackerRuntimeDependencies

/** 稳定插件门面；本地采集与 Native 托管在装配时选择，业务命令不接触两套内部状态。 */
export class TrackerRuntime {
  private readonly runtime: LocalTrackerRuntime | UniMPRuntime
  public constructor(dependencies: TrackerRuntimeDependencies | Readonly<{ unimp: UniMPDependencies }>) {
    this.runtime = 'unimp' in dependencies ? new UniMPRuntime(dependencies.unimp) : new LocalTrackerRuntime(dependencies)
  }
  public registerPlugins(...plugins: GioBuiltinPlugin[]): boolean { return this.runtime.registerPlugins(...plugins) }
  public registeredPluginNames(): readonly string[] { return this.runtime.registeredPluginNames() }
  public init(options: unknown): boolean { return this.runtime.init(options) }
  public ready(): boolean { return this.runtime.ready() }
  public failed(): boolean { return this.runtime.failed() }
  public whenReady(): Promise<boolean> { return this.runtime.whenReady() }
  public queuedEvents() { return this.runtime.queuedEvents() }
  public track(eventName: unknown, properties?: unknown): boolean { return this.runtime.track(eventName, properties) }
  public autoTrack(call: AutoTrackCall, nativeEvent?: unknown): boolean { return this.runtime.autoTrack(call, nativeEvent) }
  public setUserAttributes(properties: unknown): boolean { return this.runtime.setUserAttributes(properties) }
  public setUserId(userId: unknown, userKey?: unknown): boolean { return this.runtime.setUserId(userId, userKey) }
  public clearUserId(): boolean { return this.runtime.clearUserId() }
  public identify(deviceId: unknown): boolean { return this.runtime.identify(deviceId) }
  public getGioInfo(): string | null { return this.runtime.getGioInfo() }
  public setDataCollect(value: unknown): boolean { return this.runtime.setDataCollect(value) }
  public setOptions(options: unknown): boolean { return this.runtime.setOptions(options) }
  public setLocation(latitude: unknown, longitude: unknown): boolean { return this.runtime.setLocation(latitude, longitude) }
  public clearLocation(): boolean { return this.runtime.clearLocation() }
  public onAppLaunch(entry: AppEntrySnapshot): boolean { return this.runtime.onAppLaunch(entry) }
  public onAppShow(entry: AppEntrySnapshot): boolean { return this.runtime.onAppShow(entry) }
  public onAppHide(): boolean { return this.runtime.onAppHide() }
  public onPageLoad(input: PageLoadInput): boolean { return this.runtime.onPageLoad(input) }
  public onPageShow(instanceId: string, title: string | null): boolean { return this.runtime.onPageShow(instanceId, title) }
  public onPageHide(instanceId: string): boolean { return this.runtime.onPageHide(instanceId) }
  public onPageUnload(instanceId: string): boolean { return this.runtime.onPageUnload(instanceId) }
  public onPageTitleChanged(instanceId: string, title: string): boolean { return this.runtime.onPageTitleChanged(instanceId, title) }
}
