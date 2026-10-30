import { describe, expect, it } from 'vitest'

import {
  GIO_IDENTITY_CIPHER_PREFIX,
  decryptIdentityValue,
  encryptIdentityValue,
} from '../../src/core/storage/encrypt.js'

describe('identity xor-utf8-v1 codec', () => {
  it.each(['', 'plain text', '中文身份', 'emoji 😀 and 𐐷'])('round-trips %j without a host codec', (value) => {
    const encrypted = encryptIdentityValue(value, 'data-source')
    expect(encrypted.startsWith(GIO_IDENTITY_CIPHER_PREFIX)).toBe(true)
    if (value.length > 0) expect(encrypted).not.toContain(value)
    expect(decryptIdentityValue(encrypted, 'data-source')).toBe(value)
  })

  it('is deterministic for the same data source and isolates another data source', () => {
    const encrypted = encryptIdentityValue('张三', 'source-a')
    expect(encryptIdentityValue('张三', 'source-a')).toBe(encrypted)
    expect(decryptIdentityValue(encrypted, 'source-b')).not.toBe('张三')
  })

  it('rejects malformed prefixes, Base64URL, noncanonical bytes, and invalid UTF-8', () => {
    expect(decryptIdentityValue('gioenc-v2-abc', 'source')).toBeNull()
    expect(decryptIdentityValue(`${GIO_IDENTITY_CIPHER_PREFIX}abc=`, 'source')).toBeNull()
    expect(decryptIdentityValue(`${GIO_IDENTITY_CIPHER_PREFIX}A`, 'source')).toBeNull()
    expect(decryptIdentityValue(`${GIO_IDENTITY_CIPHER_PREFIX}AB`, 'source')).toBeNull()
    // 按当前掩码推导后，孤立 UTF-8 续字节仍须被判为非法编码。
    expect(decryptIdentityValue(`${GIO_IDENTITY_CIPHER_PREFIX}mA`, 'source')).toBeNull()
  })

  it('rejects malformed UTF-16 and an empty data-source key', () => {
    expect(() => encryptIdentityValue('\ud800', 'source')).toThrow('identity_cipher_invalid_utf16')
    expect(() => encryptIdentityValue('visitor', '')).toThrow('identity_cipher_key_invalid')
    expect(decryptIdentityValue(encryptIdentityValue('visitor', 'source'), '')).toBeNull()
  })
})
