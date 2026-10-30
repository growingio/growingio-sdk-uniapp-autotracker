export const AUTO_TRACK_SCHEMA_VERSION = 2 as const

export const CHANGE_ELEMENTS = ['input', 'textarea', 'switch', 'slider', 'radio-group', 'checkbox-group', 'picker', 'picker-view', 'swiper'] as const
export type ChangeElement = typeof CHANGE_ELEMENTS[number]
export const TEMPLATE_ELEMENTS = [
  'view', 'text', 'image', 'button', 'navigator', 'uni-link', 'scroll-view', 'swiper', 'swiper-item',
  'input', 'textarea', 'switch', 'slider', 'radio', 'radio-group', 'checkbox', 'checkbox-group',
  'picker', 'picker-view', 'picker-view-column', 'label', 'icon', 'progress', 'rich-text', 'form', 'editor',
] as const

export type TemplateAutoTrackProbe = Readonly<{
  schemaVersion: typeof AUTO_TRACK_SCHEMA_VERSION
  source: 'template'
  kind: 'click' | 'change'
  eventName: unknown
  elementType?: unknown
  pickerRange?: unknown
  pickerRangeKey?: unknown
  textValue?: unknown
  index?: unknown
  hyperlink?: unknown
  ignored?: unknown
  trackValue?: unknown
  sensitive?: unknown
  /** 仅保留输入完成事件，禁止读取或上报任何输入文案；track 不能覆盖。 */
  redactValue?: unknown
}>

export type TabBarAutoTrackProbe = Readonly<{
  schemaVersion: typeof AUTO_TRACK_SCHEMA_VERSION
  source: 'tabbar'
  kind: 'click'
  xpath: '#onTabItemTap'
  index: unknown
  textValue?: unknown
  hyperlink?: unknown
}>

export type AutoTrackCall = TemplateAutoTrackProbe | TabBarAutoTrackProbe
export type NormalizedAutoTrackCall =
  | Readonly<{ kind: 'click'; xpath: string; textValue: string | null; index: number | null; hyperlink: string | null }>
  | Readonly<{ kind: 'change'; xpath: string; textValue: string | null }>
