export const GIO_IDENTITY_CIPHER_PREFIX = 'gioenc-v3-'
export const GIO_IDENTITY_CIPHER = 'xor-utf8-v1'

// 稳定内部种子属于跨端身份编码契约，不是公开配置项。
const IDENTITY_KEY_SEED = 'gio-identity-xor-utf8-v1:'
const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** 将合法 Unicode 字符串编码为 UTF-8；未配对代理项返回 null。 */
function utf8Encode(value: string): Uint8Array | null {
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index)
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return null
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00)
      index += 1
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      return null
    }

    if (codePoint <= 0x7f) bytes.push(codePoint)
    else if (codePoint <= 0x7ff) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    else if (codePoint <= 0xffff) bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
    else bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f))
  }
  return Uint8Array.from(bytes)
}

/** 严格解码 UTF-8 字节，拒绝截断、过长编码及非法码点。 */
function utf8Decode(bytes: Uint8Array): string | null {
  const chunks: string[] = []
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index++]!
    if (first <= 0x7f) {
      chunks.push(String.fromCharCode(first))
      continue
    }
    const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0
    if (width === 0 || index + width - 1 > bytes.length) return null
    let codePoint = first & (width === 2 ? 0x1f : width === 3 ? 0x0f : 0x07)
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index++]!
      if ((continuation & 0xc0) !== 0x80) return null
      codePoint = (codePoint << 6) | (continuation & 0x3f)
    }
    if ((width === 2 && codePoint < 0x80)
      || (width === 3 && (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)))
      || (width === 4 && (codePoint < 0x10000 || codePoint > 0x10ffff))) return null
    if (codePoint <= 0xffff) chunks.push(String.fromCharCode(codePoint))
    else {
      const pair = codePoint - 0x10000
      chunks.push(String.fromCharCode(0xd800 | (pair >> 10), 0xdc00 | (pair & 0x3ff)))
    }
  }
  return chunks.join('')
}

/** 将字节编码为无填充的 Base64URL，避免依赖浏览器或 Node 编码 API。 */
function base64UrlEncode(bytes: Uint8Array): string {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += BASE64_URL_ALPHABET[first >> 2]!
    output += BASE64_URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)]!
    if (second !== undefined) output += BASE64_URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)]!
    if (third !== undefined) output += BASE64_URL_ALPHABET[third & 0x3f]!
  }
  return output
}

/** 校验并解码规范 Base64URL，非法字符、长度或尾部位返回 null。 */
function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null
  const bytes: number[] = []
  for (let index = 0; index < value.length; index += 4) {
    const first = BASE64_URL_ALPHABET.indexOf(value[index]!)
    const second = BASE64_URL_ALPHABET.indexOf(value[index + 1]!)
    const third = index + 2 < value.length ? BASE64_URL_ALPHABET.indexOf(value[index + 2]!) : -1
    const fourth = index + 3 < value.length ? BASE64_URL_ALPHABET.indexOf(value[index + 3]!) : -1
    if (first < 0 || second < 0 || third < -1 || fourth < -1) return null
    bytes.push((first << 2) | (second >> 4))
    if (third >= 0) bytes.push(((second & 0x0f) << 4) | (third >> 2))
    if (fourth >= 0) bytes.push(((third & 0x03) << 6) | fourth)
  }
  const decoded = Uint8Array.from(bytes)
  return base64UrlEncode(decoded) === value ? decoded : null
}

/** 按数据源生成稳定的字节掩码，使不同数据源的身份记录互相隔离。 */
function keyFor(dataSourceId: string): Uint8Array {
  if (dataSourceId.trim().length === 0) throw new Error('identity_cipher_key_invalid')
  const source = utf8Encode(dataSourceId)
  const material = utf8Encode(`${IDENTITY_KEY_SEED}${dataSourceId}`)
  if (source === null || source.length === 0 || material === null || material.length === 0) throw new Error('identity_cipher_key_invalid')

  // 将数据源的每个字节混入循环掩码的每个字节。
  // 避免仅尾部不同的数据源为短设备标识产生相同的可用掩码前缀。
  const sourceFold = source.reduce((fold, byte, index) => fold ^ ((byte + index) & 0xff), 0)
  return Uint8Array.from(material, (byte, index) => byte ^ source[index % source.length]! ^ sourceFold)
}

/** 对字节应用循环 XOR；同一掩码再次处理可恢复原文，不作为强密码学加密。 */
function xor(value: Uint8Array, key: Uint8Array): Uint8Array {
  return Uint8Array.from(value, (byte, index) => byte ^ key[index % key.length]!)
}

/** 仅使用本地 UTF-8 和 Base64URL 实现，保证各宿主生成一致的身份编码。 */
export function encryptIdentityValue(value: string, dataSourceId: string): string {
  const plain = utf8Encode(value)
  if (plain === null) throw new Error('identity_cipher_invalid_utf16')
  return `${GIO_IDENTITY_CIPHER_PREFIX}${base64UrlEncode(xor(plain, keyFor(dataSourceId)))}`
}

/** 前缀、Base64URL、UTF-8 或掩码校验失败时返回 null。 */
export function decryptIdentityValue(value: unknown, dataSourceId: string): string | null {
  if (typeof value !== 'string' || !value.startsWith(GIO_IDENTITY_CIPHER_PREFIX)) return null
  let key: Uint8Array
  try {
    key = keyFor(dataSourceId)
  } catch {
    return null
  }
  const cipher = base64UrlDecode(value.slice(GIO_IDENTITY_CIPHER_PREFIX.length))
  if (cipher === null) return null
  return utf8Decode(xor(cipher, key))
}
