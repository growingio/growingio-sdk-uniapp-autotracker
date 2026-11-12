import type { AppEntrySnapshot } from '../core/dataStore/app.js'
import type { TrackerRuntime } from '../core/growingIO.js'
import { isWebEmbeddedParameter } from '../plugins/gioEmbeddedAdapter/index.js'

function businessQuery(query: string): string {
  return query.replace(/^\?/, '').split('&').filter(part => {
    if (part === '') return false
    const key = part.split('=', 1)[0]!
    try { return !isWebEmbeddedParameter(decodeURIComponent(key)) }
    catch { return !isWebEmbeddedParameter(key) }
  }).join('&')
}

function webRoute({ pathname, search, hash }: Pick<Location, 'pathname' | 'search' | 'hash'>, hashtag: boolean) {
  const route = hashtag || hash.startsWith('#/') ? hash.slice(1) : ''
  const separator = route.indexOf('?')
  const path = (separator === -1 ? route : route.slice(0, separator)) || pathname
  const query = [businessQuery(search), businessQuery(separator === -1 ? '' : route.slice(separator + 1))].filter(Boolean).join('&')
  return { path, query }
}

/** The host snapshot belongs to the bridge, even when its URL is left intact. */
export function webEntrySnapshot(browser: Window, hashtag = false): AppEntrySnapshot {
  let referralPage: string | null = null
  try {
    const referrer = new URL(browser.document.referrer)
    const { path, query } = webRoute(referrer, hashtag)
    referralPage = `${referrer.origin}${path}${query ? `?${query}` : ''}`
  } catch { /* An absent or invalid referrer does not carry attribution. */ }
  return { ...webRoute(browser.location, hashtag), referralPage }
}

/** Standalone browser hosting uses document navigation; uni-app H5 uses its Vue hooks. */
export function installWebLifecycle(browser: Window, tracker: TrackerRuntime, hashtag = false): void {
  let current: { id: string; entry: AppEntrySnapshot } | null = null
  let pageNumber = 0
  const entry = () => webEntrySnapshot(browser, hashtag)
  const showPage = () => {
    const next = entry()
    if (current !== null && current.entry.path === next.path && current.entry.query === next.query) return
    if (current !== null) tracker.onPageUnload(current.id)
    const id = `web-page-${++pageNumber}`
    current = { id, entry: next }
    tracker.onPageLoad({ instanceId: id, route: next.path ?? '/', query: next.query ?? '', referralPage: null })
    tracker.onPageShow(id, browser.document.title)
  }
  tracker.onAppLaunch(entry())
  tracker.onAppShow(entry())
  showPage()
  browser.addEventListener('popstate', showPage)
  browser.addEventListener('hashchange', showPage)
  browser.addEventListener('pagehide', () => {
    if (current !== null) tracker.onPageHide(current.id)
    tracker.onAppHide()
  })
  browser.addEventListener('pageshow', (event) => {
    if (!event.persisted) return
    tracker.onAppShow(entry())
    if (current !== null) tracker.onPageShow(current.id, browser.document.title)
  })
}
