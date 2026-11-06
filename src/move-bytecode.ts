const MAGIC = [0xa1, 0x1c, 0xeb, 0x0b]
const MODULE_HANDLES = 0x1
const DATATYPE_HANDLES = 0x2
const IDENTIFIERS = 0x7
const ADDRESS_IDENTIFIERS = 0x8
const ADDRESS_LENGTH = 32

export const ABILITY_COPY = 0x1
export const ABILITY_DROP = 0x2
export const ABILITY_STORE = 0x4
export const ABILITY_KEY = 0x8

export type MoveModuleDatatypes = {
  /** Self module address as 0x-prefixed hex (0x0... for an unpublished package). */
  address: string
  /** Self module name. */
  name: string
  /** Ability bitmask of every datatype declared by the self module, by name. */
  datatypes: Map<string, number>
}

class Reader {
  offset: number
  readonly end: number

  constructor(readonly bytes: Uint8Array, offset = 0, end = bytes.length) {
    this.offset = offset
    this.end = end
  }

  u8(): number {
    if (this.offset >= this.end) throw new Error('Unexpected end of Move bytecode.')
    return this.bytes[this.offset++]!
  }

  u32(): number {
    let value = 0
    for (let shift = 0; shift < 32; shift += 8) value += this.u8() * 2 ** shift
    return value
  }

  uleb(): number {
    let value = 0
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.u8()
      value += (byte & 0x7f) * 2 ** shift
      if ((byte & 0x80) === 0) {
        if (value > 0xffff_ffff) throw new Error('ULEB128 value exceeds u32.')
        return value
      }
    }
    throw new Error('ULEB128 value is too long.')
  }

  take(length: number): Uint8Array {
    if (this.offset + length > this.end) throw new Error('Unexpected end of Move bytecode.')
    const slice = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return slice
  }

  done(): boolean {
    return this.offset === this.end
  }
}

type Table = { offset: number; length: number }

/**
 * Read a compiled Move module's self name, address, and the declared abilities
 * of its own datatypes. Throws on malformed or unsupported bytecode.
 */
export function readModuleDatatypes(bytes: Uint8Array): MoveModuleDatatypes {
  const reader = new Reader(bytes)
  for (const byte of MAGIC) {
    if (reader.u8() !== byte) throw new Error('Not a Move bytecode module.')
  }
  const version = reader.u32() & 0x00ff_ffff
  if (version < 5) throw new Error(`Unsupported Move bytecode version ${version}.`)

  const tableCount = reader.uleb()
  const tables = new Map<number, Table>()
  for (let index = 0; index < tableCount; index += 1) {
    const kind = reader.u8()
    const offset = reader.uleb()
    const length = reader.uleb()
    if (tables.has(kind)) throw new Error(`Duplicate Move bytecode table ${kind}.`)
    tables.set(kind, { offset, length })
  }
  const contentStart = reader.offset
  let contentLength = 0
  for (const table of tables.values()) contentLength = Math.max(contentLength, table.offset + table.length)
  if (contentStart + contentLength > bytes.length) throw new Error('Move bytecode table exceeds the module.')

  const tableReader = (kind: number): Reader | undefined => {
    const table = tables.get(kind)
    if (!table) return undefined
    return new Reader(bytes, contentStart + table.offset, contentStart + table.offset + table.length)
  }

  const identifiers: string[] = []
  const identifierReader = tableReader(IDENTIFIERS)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (identifierReader && !identifierReader.done()) {
    identifiers.push(decoder.decode(identifierReader.take(identifierReader.uleb())))
  }

  const addresses: string[] = []
  const addressReader = tableReader(ADDRESS_IDENTIFIERS)
  while (addressReader && !addressReader.done()) {
    addresses.push(`0x${Buffer.from(addressReader.take(ADDRESS_LENGTH)).toString('hex')}`)
  }

  const moduleHandles: { address: number; name: number }[] = []
  const moduleReader = tableReader(MODULE_HANDLES)
  while (moduleReader && !moduleReader.done()) {
    moduleHandles.push({ address: moduleReader.uleb(), name: moduleReader.uleb() })
  }

  const trailer = new Reader(bytes, contentStart + contentLength)
  const selfIndex = trailer.uleb()
  if (!trailer.done()) throw new Error('Unexpected bytes after the Move module self handle.')
  const self = moduleHandles[selfIndex]
  const selfName = self ? identifiers[self.name] : undefined
  const selfAddress = self ? addresses[self.address] : undefined
  if (selfName === undefined || selfAddress === undefined) {
    throw new Error('Move module self handle is out of range.')
  }

  const datatypes = new Map<string, number>()
  const datatypeReader = tableReader(DATATYPE_HANDLES)
  while (datatypeReader && !datatypeReader.done()) {
    const moduleIndex = datatypeReader.uleb()
    const nameIndex = datatypeReader.uleb()
    const abilities = datatypeReader.u8()
    const typeParameterCount = datatypeReader.uleb()
    for (let index = 0; index < typeParameterCount; index += 1) {
      datatypeReader.u8()
      datatypeReader.u8()
    }
    const name = identifiers[nameIndex]
    if (name === undefined || moduleHandles[moduleIndex] === undefined) {
      throw new Error('Move datatype handle is out of range.')
    }
    if (moduleIndex === selfIndex) datatypes.set(name, abilities)
  }

  return { address: selfAddress, name: selfName, datatypes }
}
