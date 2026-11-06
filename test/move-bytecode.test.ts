import { describe, expect, test } from 'bun:test'
import { ABILITY_COPY, ABILITY_DROP, ABILITY_KEY, ABILITY_STORE, readModuleDatatypes } from '../src/move-bytecode.js'
import capsPackage from './fixtures/caps-package.json' with { type: 'json' }

const module = Buffer.from(capsPackage.modules[0]!, 'base64')

describe('readModuleDatatypes', () => {
  test('reads the self module and declared abilities from real Sui bytecode', () => {
    const parsed = readModuleDatatypes(module)
    expect(parsed.name).toBe('caps')
    expect(parsed.address).toBe(`0x${'0'.repeat(64)}`)
    expect([...parsed.datatypes.keys()].sort()).toEqual(['AdminCap', 'Pair', 'Ticket'])
    expect(parsed.datatypes.get('AdminCap')).toBe(ABILITY_KEY | ABILITY_STORE)
    expect(parsed.datatypes.get('Ticket')).toBe(ABILITY_KEY)
    expect(parsed.datatypes.get('Pair')).toBe(ABILITY_COPY | ABILITY_DROP | ABILITY_STORE)
  })

  test('excludes datatypes declared by other modules', () => {
    const parsed = readModuleDatatypes(module)
    expect(parsed.datatypes.has('UID')).toBe(false)
    expect(parsed.datatypes.has('TxContext')).toBe(false)
  })

  test.each([
    ['empty input', new Uint8Array()],
    ['wrong magic', Buffer.from('00112233445566778899', 'hex')],
    ['truncated module', module.subarray(0, module.length - 40)],
    ['trailing bytes', Buffer.concat([module, Buffer.from([0])])],
    ['random bytes', Buffer.from('a11ceb0b07000005ffffffffff', 'hex')],
  ])('throws on %s', (_name, bytes) => {
    expect(() => readModuleDatatypes(bytes)).toThrow()
  })
})
