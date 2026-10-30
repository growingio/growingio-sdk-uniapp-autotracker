/**
 * Frozen receiver contract from gio-web-autotracker, Apache-2.0.
 * Source revision: b2030188e900056ab026a481fb1a9b816f171f49 (2026-10-27 inspection).
 * src/plugins/gioEmbeddedAdapter/index.ts:36-106, 496-508, 526-541, 817-825, 982-1050.
 * src/utils/tools.ts:46-56, 297-318; src/utils/glodash.ts primitive helpers.
 *
 * Query selection, decoding, ownership matching and config inheritance are kept
 * independently of this SDK. Only window/storage transport is injected, and the
 * unrelated circle/AB/identity-storage work in onOptionsInit is omitted. Its
 * match -> syncVdsConfig -> syncCommonDimensions order is preserved by initialize.
 * This fixture must not import the uni-app implementation or sibling repository.
 */
type Values = Record<string, any>

const EMBEDDED_ENUMS: Record<string, string> = {
  gioprojectid: 'projectId', giodatacollect: 'dataCollect', gioappid: 'domain', giodatasourceid: 'dataSourceId',
  gios: 'sessionId', giou: 'deviceId', giocs1: 'userId', giouserkey: 'userKey', gioappchannel: 'appChannel',
  giodevicebrand: 'deviceBrand', giodevicemodel: 'deviceModel', giodevicetype: 'deviceType', giolanguage: 'language',
  gionetworkstate: 'networkState', giooperatingsystem: 'operatingSystem', gioplatform: 'platform',
  gioplatformversion: 'platformVersion', gioscreenheight: 'screenHeight', gioscreenwidth: 'screenWidth', giocircleroomid: 'circleRoomId',
}
const VDS_EXTRA = ['gioprojectid', 'giodatacollect', 'giodatasourceid', 'gioplatform', 'giocircleroomid']
const COM_EXTRA = ['giodatasourceid', 'gioplatform', 'gioappchannel', 'giodevicebrand', 'giodevicemodel', 'giodevicetype',
  'giolanguage', 'gionetworkstate', 'giooperatingsystem', 'gioplatformversion', 'gioscreenheight', 'gioscreenwidth',
  'giocs1', 'gios', 'giou', 'giouserkey']
const GQS_KEY = ['gioappid', 'gioprojectid', 'giodatacollect', 'giocircleroomid', 'gionewdevice', ...COM_EXTRA]
const LOCAL_KEY = 'gdp_query_string'

const typeOf = (o: any): string => Object.prototype.toString.call(o).slice(8, -1).toLowerCase()
const includes = (o: any, target: any): boolean => {
  if (typeOf(o) === 'array' || typeOf(o) === 'string') {
    return typeOf(target) === 'array' ? target.some((t: any) => o.indexOf(t) >= 0) : o.indexOf(target) >= 0
  }
  return false
}
const isNil = (o: any): boolean => includes(['undefined', 'null'], typeOf(o))
const isString = (o: any): boolean => typeOf(o) === 'string'
const isObject = (o: any): boolean => typeOf(o) === 'object' && !isNil(o)
const has = (o: any, key: string): boolean => !isNil(o) && Object.prototype.hasOwnProperty.call(o, key)
const keys = (o: any): string[] => isObject(o) ? Object.keys(o) : []
const startsWith = (s: string, target: string): boolean => isString(s) && s.slice(0, target.length) === target
const niceTry = <T>(fn: (...args: any[]) => T, ...args: any[]): T | undefined => { try { return fn(...args) } catch { return undefined } }

// Web queryParse deliberately does not decode; getGQS owns the single decode.
const queryParse = (search: string): any => {
  if (startsWith(search, '?') || includes(search, ['=', '&'])) {
    const qsValues: Values = {}
    const orderKeys: string[] = []
    if (startsWith(search, '?')) search = search.substring(1)
    const kvArray = search.split('&')
    kvArray.forEach((s: string) => {
      const kvPairs = s.split('=')
      const key = kvPairs[0]
      const value = kvPairs[1] ?? ''
      if (!isNil(key) && key !== '') {
        qsValues[key!] = value
        orderKeys.push(key!)
      }
    })
    return { ...qsValues, __GIO_ORDER__: orderKeys }
  }
  return decodeURIComponent(search)
}

export type WebReceiverConfig = Readonly<{ projectId: string; appId: string; dataSourceId: string; dataCollect: boolean; platform?: string }>

export class FrozenWebEmbeddedReceiver {
  public qsFrom: 'search' | 'hash' | 'local' | 'none' = 'search'
  public gqs: Values = {}
  public customerQs: Values = {}
  public readonly growingIO = { useEmbeddedInherit: '' }
  public readonly commonContext = { minpExtraParams: {} as Values }
  public readonly config: Values
  private readonly storage: { getItem: (key: string) => Values | undefined }

  public constructor(private readonly location: Readonly<{ search: string; hash: string }>, config: WebReceiverConfig, savedQuery?: Values) {
    this.config = { ...config }
    this.storage = { getItem: key => key === LOCAL_KEY ? savedQuery : undefined }
  }

  private hasGIOParams = (qs: any): boolean => {
    if (!qs || typeof qs !== 'object') return false
    return has(qs, 'gioprojectid') && has(qs, 'giodatasourceid')
  }

  public getGQS = (hashtag: boolean) => {
    const search = this.location.search
    const hash = this.location.hash
    const hashSearch = hashtag ? hash.substring(hash.indexOf('?') + 1) : ''
    const localQs = this.storage.getItem(LOCAL_KEY)
    const ctSearchQs = niceTry(() => queryParse(search)) || {}
    const ctHashQs = niceTry(() => queryParse(hashSearch)) || {}
    let ctOrigQs: Values = {}
    if (this.hasGIOParams(ctSearchQs)) {
      ctOrigQs = ctSearchQs
      this.qsFrom = 'search'
    } else if (this.hasGIOParams(ctHashQs)) {
      ctOrigQs = ctHashQs
      this.qsFrom = 'hash'
    } else if (this.hasGIOParams(localQs)) {
      ctOrigQs = localQs!
      this.qsFrom = 'local'
    } else {
      this.qsFrom = 'none'
      return {}
    }
    const gqs: Values = {}
    const customerQs: Values = {}
    keys(ctOrigQs).forEach((k: string) => {
      const lk = k.toLowerCase()
      if (includes(GQS_KEY, lk)) {
        let val: string
        try { val = decodeURIComponent(ctOrigQs[k]) } catch { val = ctOrigQs[k] }
        if (!includes(['', 'undefined', 'null', undefined, null], val)) {
          const isBooleanParam = includes(['giodatacollect', 'gionewdevice'], lk)
          gqs[lk] = isBooleanParam && includes(['true', 'TRUE', true], val) ? true
            : isBooleanParam && includes(['false', 'FALSE', false], val) ? false : val
        } else {
          gqs[lk] = ''
        }
      } else {
        customerQs[k] = ctOrigQs[k]
      }
    })
    this.gqs = gqs
    this.customerQs = customerQs
    return { ...this.gqs, ...this.customerQs }
  }

  private canEstablishBridge = (_trackingId: string, projectId: string, appId: string, gqs: Values): boolean => {
    return !this.growingIO.useEmbeddedInherit && this.qsFrom !== 'none' && gqs.gioprojectid === projectId && gqs.gioappid === appId
  }

  private syncVdsConfig = (trackerVds: any, gqs: Values) => {
    VDS_EXTRA.forEach((key: string) => {
      if (!has(gqs, key)) return
      if (key === 'giodatacollect') {
        trackerVds.dataCollect = includes(['true', true], gqs.giodatacollect)
      } else {
        const embedKey = EMBEDDED_ENUMS[key]!
        if (includes(['domain', 'platform'], embedKey)) {
          trackerVds.originValues ??= {}
          trackerVds.originValues[embedKey] = trackerVds[embedKey]
        }
        trackerVds[embedKey] = gqs[key]
      }
    })
  }

  private syncCommonDimensions = (eventContextBuilderInst: any, gqs: Values) => {
    eventContextBuilderInst.minpExtraParams = {}
    COM_EXTRA.forEach((key: string) => {
      if (has(gqs, key)) eventContextBuilderInst.minpExtraParams[EMBEDDED_ENUMS[key]!] = gqs[key]
    })
  }

  public initialize(hashtag = false): boolean {
    const gqs = this.getGQS(hashtag)
    if (!this.canEstablishBridge('main', this.config.projectId, this.config.appId, gqs)) return false
    this.growingIO.useEmbeddedInherit = 'main'
    this.syncVdsConfig(this.config, gqs)
    this.syncCommonDimensions(this.commonContext, gqs)
    return true
  }
}
