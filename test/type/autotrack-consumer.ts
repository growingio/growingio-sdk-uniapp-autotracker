import type { AutoTrackCall, NormalizedAutoTrackCall } from '../../demo/uni_modules/gio-uniapp-autotracker/src/plugins/gioEventAutoTracking/contract.js'

const template: AutoTrackCall = { schemaVersion: 2, source: 'template', kind: 'change', eventName: 'save', elementType: 'input' }
const tabbar: AutoTrackCall = { schemaVersion: 2, source: 'tabbar', kind: 'click', xpath: '#onTabItemTap', index: 1 }
const change: NormalizedAutoTrackCall = { kind: 'change', xpath: '#save', textValue: '0' }
// change 没有 click 专属字段，旧版探针也不能伪装为新版事件名。
// @ts-expect-error VIEW_CHANGE 不接受 index
const invalidChange: NormalizedAutoTrackCall = { kind: 'change', xpath: '#save', textValue: null, index: 1 }
// @ts-expect-error v1 结构路径不是 v2 合约
const legacy: AutoTrackCall = { schemaVersion: 1, kind: 'click', xpath: '/old' }
// @ts-expect-error 模板探针不能传入最终 xpath
const mixed: AutoTrackCall = { schemaVersion: 2, source: 'template', kind: 'click', eventName: 'save', xpath: '#save' }
void [template, tabbar, change, invalidChange, legacy, mixed]
