import type { ResolvedGioConfig } from '../constants/config.js'
import { TrackerRuntime } from '../core/growingIO.js'
import type { WebRuntimeState } from '../core/localRuntime.js'
import { SharedIdentityPersistence } from '../core/storage/sharedIdentity.js'
import { readWebEmbeddedContext } from '../plugins/gioEmbeddedAdapter/index.js'
import type { NetworkPort, TransportPort } from '../types/index.js'
import type { AppRuntimeOptions } from './index.js'
import { canRoundTripWebIdentity, createWebStorage, webStoragePrefix, type WebStorageRead } from './webStorage.js'
import { AppStoragePort } from './uni.js'

function stringRecord(entry: WebStorageRead) {
  if (entry.kind !== 'value') return entry
  return typeof entry.value === 'string' ? { kind: 'value' as const, value: entry.value } : { kind: 'corrupt' as const }
}

function webState(browser: Window, config: ResolvedGioConfig, pageTitle?: () => string | null): WebRuntimeState {
  const options = config.web!
  const storage = createWebStorage(browser, options)
  if (storage.kind === 'memory') globalThis.console?.warn('[GrowingIO]: Web identity storage is in memory and will expire on reload')
  if (config.debug) globalThis.console?.info(`[GrowingIO]: Web storage=${storage.kind} domain=${storage.domain ?? browser.location.hostname} path=/`)
  const timeout = config.sessionPolicy.timeoutMs
  const embedded = readWebEmbeddedContext(browser, {
    projectId: config.accountId, appId: options.appId, hashtag: options.hashtag, embeddedAdapter: options.embeddedAdapter,
    sessionExpiresMs: timeout,
  })
  const inheritsStorage = embedded !== null && !embedded.strict && !embedded.routingOnly
  const prefix = webStoragePrefix(config.accountId, inheritsStorage ? embedded.dataSourceId : config.dataSourceId, options.subInstance)
  const identity = new SharedIdentityPersistence({
    read: key => stringRecord(storage.read(key, true)),
    write: (key, value) => storage.write(key, value, { identity: true }),
    remove: key => storage.remove(key),
    canWrite: (key, value) => canRoundTripWebIdentity(key, value, storage.kind),
  }, {
    deviceId: 'gdp_user_id', userId: `${prefix}_gdp_cs1`,
    userKey: `${prefix}_gdp_user_key`, lastUserId: `${prefix}_gdp_gio_id`,
  })
  const sessionId = embedded?.sessionId
  const sessionPrefix = sessionId ? prefix : webStoragePrefix(config.accountId, config.dataSourceId, options.subInstance)
  const sessionKey = `${sessionPrefix}_gdp_session_id`
  const sentKey = `${prefix}_gdp_session_id_sent`
  if (embedded !== null && !embedded.strict && !embedded.routingOnly) {
    const session = storage.read(sessionKey)
    const sent = storage.read(sentKey)
    if (!embedded.ownsSession() || [session, sent].some(entry => entry.kind === 'corrupt' || entry.kind === 'unavailable')) {
      globalThis.console?.error('[GrowingIO]: WebView shared session snapshot is unavailable or conflicts with its cache')
      throw new Error('web_embedded_snapshot_unavailable')
    }
  }
  const renewEmbeddedSession = (): boolean => {
    if (embedded === null || embedded.collecting === false || !embedded.ownsSession()) return false
    if (sessionId && !embedded.strict) {
      const latest = storage.read(sessionKey)
      if (latest.kind !== 'value' || latest.value !== sessionId) return false
      if (storage.write(sessionKey, sessionId, { expiresAt: Date.now() + timeout }).kind !== 'ok') return false
    }
    embedded.renew()
    return true
  }
  let keepAliveTimer: number | undefined
  const stopKeepAlive = (): void => {
    if (keepAliveTimer !== undefined) browser.clearTimeout(keepAliveTimer)
    keepAliveTimer = undefined
  }
  const scheduleKeepAlive = (): void => {
    if (keepAliveTimer !== undefined || embedded === null || embedded.routingOnly
      || !(embedded.collecting ?? config.dataCollect) || !embedded.ownsSession()) return
    keepAliveTimer = browser.setTimeout(() => {
      keepAliveTimer = undefined
      if (renewEmbeddedSession()) scheduleKeepAlive()
    }, Math.max(1, timeout * 0.8))
  }
  let watchingPage = false
  const synchronized = (): true => {
    if (embedded !== null) {
      embedded.renew()
      scheduleKeepAlive()
      if (!watchingPage) {
        watchingPage = true
        browser.addEventListener('pagehide', stopKeepAlive)
        browser.addEventListener('pageshow', scheduleKeepAlive)
      }
    }
    return true
  }
  return {
    identity,
    embedded,
    currentTitle: () => pageTitle?.() ?? browser.document.title,
    synchronizeEmbeddedSession() {
      if (embedded === null || embedded.routingOnly) return true
      if (!embedded.strict && !embedded.ownsSession()) return false
      if (!sessionId || embedded.strict) return synchronized()
      const previous = stringRecord(storage.read(sessionKey))
      if (previous.kind === 'corrupt' || previous.kind === 'unavailable') return false
      const changed = previous.kind !== 'value' || previous.value !== sessionId
      if (!changed) {
        const saved = storage.write(sessionKey, sessionId, { expiresAt: Date.now() + timeout }).kind === 'ok'
        if (saved) synchronized()
        return saved
      }
      const sent = stringRecord(storage.read(sentKey))
      if (sent.kind === 'corrupt' || sent.kind === 'unavailable') return false
      if (storage.write(sentKey, '').kind !== 'ok') return false
      if (storage.write(sessionKey, sessionId, { expiresAt: Date.now() + timeout }).kind === 'ok') {
        return synchronized()
      }
      const latest = storage.read(sentKey)
      if (latest.kind === 'value' && latest.value === '') {
        if (sent.kind === 'value') storage.write(sentKey, sent.value)
        else storage.remove(sentKey)
      }
      return false
    },
    renewEmbeddedSession,
  }
}

/** Web's uncompressed collector request uses a CORS-safelisted content type. */
function webTransport(browser: Window): TransportPort {
  return {
    dispatch(request, done) {
      const controller = new AbortController()
      void browser.fetch(request.url, {
        method: request.method,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: request.body,
        signal: controller.signal,
      }).then(response => done({ kind: 'success', status: response.status }), () => done({ kind: 'network' }))
      return { abort: () => controller.abort() }
    },
  }
}

function webNetwork(browser: Window): NetworkPort {
  return {
    current: async () => 'UNKNOWN',
    isConnected: () => browser.navigator.onLine !== false,
    subscribe(listener) {
      const update = () => listener('UNKNOWN')
      browser.addEventListener('online', update)
      browser.addEventListener('offline', update)
      return () => {
        browser.removeEventListener('online', update)
        browser.removeEventListener('offline', update)
      }
    },
  }
}

/** Browser globals are accessed only on the H5 branch of gdp('init'). */
export function createWebTracker(browser: Window, options: AppRuntimeOptions, pageTitle?: () => string | null): TrackerRuntime {
  const storage = new AppStoragePort({
    getStorageSync: key => browser.localStorage.getItem(key),
    setStorageSync: (key, value) => browser.localStorage.setItem(key, value),
    removeStorageSync: key => browser.localStorage.removeItem(key),
  }, false)
  const dimension = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
  return new TrackerRuntime({
    target: 'web',
    storage,
    web: config => webState(browser, config, pageTitle),
    clock: { now: Date.now },
    timezone: { getOffsetMinutes: () => new Date().getTimezoneOffset() },
    deviceIdFactory: options.deviceIdFactory,
    sessionIdFactory: options.sessionIdFactory,
    orientation: () => browser.innerWidth > browser.innerHeight ? 'LANDSCAPE' : 'PORTRAIT',
    systemContext: config => ({
      load: async () => ({
        platform: 'web', domain: browser.location.host, appVersion: config.appVersionFallback ?? '',
        language: browser.navigator.language, sdkVersion: options.sdkVersion, networkState: 'UNKNOWN',
        screenWidth: dimension(browser.screen?.width), screenHeight: dimension(browser.screen?.height),
      }),
    }),
    logger: {
      info: message => globalThis.console?.info(message),
      success: message => globalThis.console?.info(message),
      warn: message => globalThis.console?.warn(message),
      error: message => globalThis.console?.error(message),
      debug: message => globalThis.console?.debug(message),
    },
    network: webNetwork(browser),
    upload: {
      transport: webTransport(browser),
      runtime: {
        now: Date.now,
        random: Math.random,
        setTimeout: (callback, delay) => browser.setTimeout(callback, delay),
        clearTimeout: handle => browser.clearTimeout(handle as number),
      },
    },
  })
}
