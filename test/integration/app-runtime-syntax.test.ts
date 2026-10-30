import { build } from 'esbuild'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'

describe('App JavaScript runtime compatibility', () => {
  it('can load the full SDK without parsing Unicode property escapes', async () => {
    const output = await build({
      entryPoints: ['index.ts'], bundle: true, write: false, format: 'iife',
      platform: 'neutral', target: 'es2018',
    })
    const syntax = parse(output.outputFiles[0]!.text)
    const unsupported: string[] = []
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      if (Array.isArray(value)) { value.forEach(visit); return }
      const node = value as Record<string, unknown>
      if (node.type === 'RegExpLiteral' && /\\[pP]\{/.test(String(node.pattern))) {
        unsupported.push(String(node.pattern))
      }
      Object.values(node).forEach(visit)
    }
    visit(syntax)
    expect(unsupported).toEqual([])
  })
})
