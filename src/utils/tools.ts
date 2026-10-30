/** 保持与小程序 SDK 相同的 UUID v4 格式，使用 Math.random 以兼容 App 内置 JavaScript 运行时。 */
export function guid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = (Math.random() * 16) | 0
    const value = character === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

/** 按 RFC 3492 第 6.1 和 6.3 节及其 Punycode 参数编码，不依赖 Node 或浏览器 API。 */
function encodeLabel(label: string): string | null {
  const points = Array.from(label, (character) => character.codePointAt(0)!)
  // DNS 标签有长度上限，同时限制编码器反复扫描的工作量。
  if (points.length > 63) return null
  let output = points.filter((point) => point < 128).map((point) => String.fromCharCode(point)).join('')
  const basic = output.length
  let handled = basic
  if (basic > 0) output += '-'
  let next = 128, delta = 0, bias = 72
  /** 按 Punycode 字母表编码一个数位。 */
  const digit = (value: number): string => String.fromCharCode(value < 26 ? 97 + value : 22 + value)
  while (handled < points.length) {
    const minimum = Math.min(...points.filter((point) => point >= next))
    delta += (minimum - next) * (handled + 1)
    next = minimum
    for (const point of points) {
      if (point < next) delta += 1
      if (point !== next) continue
      let remainder = delta
      for (let weight = 36; ; weight += 36) {
        const threshold = Math.max(1, Math.min(26, weight - bias))
        if (remainder < threshold) break
        output += digit(threshold + ((remainder - threshold) % (36 - threshold)))
        remainder = Math.floor((remainder - threshold) / (36 - threshold))
      }
      output += digit(remainder)
      let adjusted = handled === basic ? Math.floor(delta / 700) : Math.floor(delta / 2)
      adjusted += Math.floor(adjusted / (handled + 1))
      let step = 0
      while (adjusted > 455) { adjusted = Math.floor(adjusted / 35); step += 36 }
      bias = step + Math.floor((36 * adjusted) / (adjusted + 38))
      delta = 0
      handled += 1
    }
    delta += 1
    next += 1
  }
  return output.length + 4 <= 63 ? `xn--${output}` : null
}

/**
 * 为缺少 URL 的 App 提供常见国际化域名回退：规范宽度、分隔点和大小写，拒绝控制符、私用字符、未配对代理项及首位组合标记，再执行 RFC 3492 编码。
 * 此处不实现完整 UTS #46；具备 URL 的宿主使用自身 IDNA 实现，回退路径不依赖额外 Unicode 映射表。
 * 缺少 Unicode 扩展能力时继续接受 ASCII 主机，非 ASCII 主机保守拒绝，不中断 SDK 加载。
 */
function asciiDomain(host: string): string | null {
  let normalized = host.toLowerCase()
  let leadingMark: RegExp | null = null
  if (/[^\x00-\x7F]/.test(host)) {
    try {
      normalized = host.replace(/[\u3002\uFF0E\uFF61]/g, '.').normalize('NFKC')
        .replace(/./gu, (character) => character.toLowerCase()).normalize('NFC')
      // 必须使用字符串构造：部分 App JSVM 不支持属性转义，字面量会令整个业务脚本编译失败。
      if (new RegExp('[\\p{C}\\p{Z}]', 'u').test(normalized)) return null
      leadingMark = new RegExp('^\\p{M}', 'u')
    } catch { return null }
  }
  const labels: string[] = []
  for (const label of normalized.split('.')) {
    if (leadingMark?.test(label)) return null
    const encoded = /[^\x00-\x7F]/.test(label) ? encodeLabel(label) : label
    if (encoded === null || !/^[a-z\d_-]*$/.test(encoded)) return null
    labels.push(encoded)
  }
  const result = labels.join('.')
  return result === '' ? null : result
}

/** 解析 IPv4 段允许的十进制、八进制或十六进制表示，非法值返回 null。 */
function ipv4Number(part: string): number | null {
  if (part === '') return null
  const hex = /^0x/i.test(part)
  const octal = !hex && part.length > 1 && part.startsWith('0')
  const digits = hex ? part.slice(2) : octal ? part.slice(1) : part
  if (!(hex ? /^[a-f\d]*$/i : octal ? /^[0-7]*$/ : /^\d+$/).test(digits)) return null
  const result = digits === '' ? 0 : Number.parseInt(digits, hex ? 16 : octal ? 8 : 10)
  return Number.isSafeInteger(result) ? result : null
}

/** 沿用 WHATWG URL 第 3.5 节的兼容 IPv4 输入形式，统一输出点分十进制。 */
function normalizeIpv4(host: string): string | null {
  const parts = host.split('.')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const last = parts[parts.length - 1]!
  if (!/^(?:\d+|0x[a-f\d]*)$/i.test(last)) return host
  if (parts.length > 4) return null
  const numbers = parts.map(ipv4Number)
  if (numbers.some((value) => value === null)) return null
  const values = numbers as number[]
  if (values.slice(0, -1).some((value) => value > 255) || values[values.length - 1]! >= 256 ** (5 - values.length)) return null
  const address = values.slice(0, -1).reduce((sum, value, at) => sum + value * 256 ** (3 - at), values[values.length - 1]!)
  return [24, 16, 8, 0].map((shift) => (address >>> shift) & 255).join('.')
}

/** 验证带方括号的 IPv6 主机字面量及压缩段数。 */
function validIpv6(host: string): boolean {
  let address = host.slice(1, -1)
  if (address.includes('.')) {
    const boundary = address.lastIndexOf(':')
    const tail = address.slice(boundary + 1).split('.')
    if (tail.length !== 4 || tail.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false
    address = `${address.slice(0, boundary + 1)}0:0`
  }
  const halves = address.split('::')
  if (halves.length > 2) return false
  const groups = halves.flatMap((half) => half === '' ? [] : half.split(':'))
  return groups.every((group) => /^[a-f\d]{1,4}$/i.test(group)) &&
    (halves.length === 2 ? groups.length < 8 : groups.length === 8)
}

/** 规范采集服务的域名或 IP 主机，过滤非法编码与地址形态。 */
export function normalizeCollectorHost(host: string): string | null {
  if (host.startsWith('[')) return validIpv6(host) ? host.toLowerCase() : null
  const domain = asciiDomain(host)
  return domain === null ? null : normalizeIpv4(domain)
}
