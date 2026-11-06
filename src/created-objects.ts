import { GrpcTypes } from '@mysten/sui/grpc'
import { normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils'
import { ABILITY_STORE, readModuleDatatypes } from './move-bytecode.js'

/** An address-owned object created by a transaction, with its output reference. */
export type CreatedOwnedObject = {
  objectId: string
  type: string
  owner: string
  version: string
  digest: string
}

export type StoreAbility = 'store' | 'no_store' | 'unknown'

export type DatatypeLookup = {
  getDatatype(
    input: { packageId: string; moduleName: string; name: string },
    options?: { abort?: AbortSignal },
  ): PromiseLike<{ response: { datatype?: { abilities: readonly number[] } } }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function normalizedAddress(value: unknown): string | undefined {
  const address = text(value)
  if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) return undefined
  return normalizeSuiAddress(address)
}

function changedObjects(effects: unknown): Record<string, unknown>[] {
  const changes = record(effects)?.changedObjects
  if (!Array.isArray(changes)) return []
  return changes.map(record).filter((change): change is Record<string, unknown> => change !== undefined)
}

function typeFor(objectTypes: unknown, objectId: string): string | undefined {
  const types = record(objectTypes)
  if (!types) return undefined
  for (const [key, value] of Object.entries(types)) {
    if (normalizedAddress(key) === objectId) return text(value)
  }
  return undefined
}

/**
 * Select the objects a transaction created and left owned by `sender`.
 *
 * Accepts SDK `TransactionEffects` and Onara's JSON receipt shape alike: only
 * `changedObjects[].{objectId,idOperation,outputState,outputOwner,outputVersion,outputDigest}`
 * and an object-ID-to-type map are read.
 */
export function selectCreatedOwnedObjects(
  effects: unknown,
  objectTypes: unknown,
  sender: string,
): CreatedOwnedObject[] {
  const owner = normalizeSuiAddress(sender)
  const selected: CreatedOwnedObject[] = []
  for (const change of changedObjects(effects)) {
    if (change.idOperation !== 'Created' || change.outputState !== 'ObjectWrite') continue
    const outputOwner = record(change.outputOwner)
    if (!outputOwner || normalizedAddress(outputOwner.AddressOwner) !== owner) continue
    if (outputOwner.$kind !== undefined && outputOwner.$kind !== 'AddressOwner') continue
    const objectId = normalizedAddress(change.objectId)
    if (!objectId) continue
    selected.push({
      objectId,
      type: typeFor(objectTypes, objectId) ?? 'unknown',
      owner,
      version: String(change.outputVersion ?? ''),
      digest: text(change.outputDigest) ?? '',
    })
  }
  return selected
}

/** Package IDs created by the transaction (`PackageWrite` + `Created`). */
export function selectCreatedPackageIds(effects: unknown): string[] {
  return changedObjects(effects)
    .filter((change) => change.outputState === 'PackageWrite' && change.idOperation === 'Created')
    .map((change) => normalizedAddress(change.objectId))
    .filter((objectId): objectId is string => objectId !== undefined)
}

function structParts(type: string): { address: string; module: string; name: string } | undefined {
  try {
    const tag = parseStructTag(type)
    return { address: normalizeSuiAddress(tag.address), module: tag.module, name: tag.name }
  } catch {
    return undefined
  }
}

/**
 * Determine from compiled modules whether `module::name` declares `store`.
 * Returns `unknown` when no module, or more than one module, declares the type,
 * or when any module cannot be parsed.
 */
export function localStoreAbility(type: string, modules: readonly string[]): StoreAbility {
  const parts = structParts(type)
  if (!parts) return 'unknown'
  const matches: number[] = []
  for (const module of modules) {
    try {
      const parsed = readModuleDatatypes(Buffer.from(module, 'base64'))
      if (parsed.name !== parts.module) continue
      const abilities = parsed.datatypes.get(parts.name)
      if (abilities !== undefined) matches.push(abilities)
    } catch {
      return 'unknown'
    }
  }
  if (matches.length !== 1) return 'unknown'
  return (matches[0]! & ABILITY_STORE) !== 0 ? 'store' : 'no_store'
}

/**
 * Best-effort pre-publish check of the declared `store` ability of each type.
 * Types from packages created by this transaction are read from the batch's
 * bytecode; others are looked up onchain. Generic arguments are ignored.
 */
export async function checkStoreAbilities(options: {
  types: readonly string[]
  createdPackageIds: readonly string[]
  modules: readonly string[]
  lookup: DatatypeLookup
  signal?: AbortSignal
}): Promise<Map<string, StoreAbility>> {
  const created = new Set(options.createdPackageIds.map((id) => normalizeSuiAddress(id)))
  const results = new Map<string, StoreAbility>()
  for (const type of new Set(options.types)) {
    const parts = structParts(type)
    if (!parts) {
      results.set(type, 'unknown')
      continue
    }
    if (created.has(parts.address)) {
      results.set(type, localStoreAbility(type, options.modules))
      continue
    }
    try {
      const { response } = await options.lookup.getDatatype(
        { packageId: parts.address, moduleName: parts.module, name: parts.name },
        options.signal ? { abort: options.signal } : undefined,
      )
      const abilities = response.datatype?.abilities
      results.set(
        type,
        !abilities ? 'unknown' : abilities.includes(GrpcTypes.Ability.STORE) ? 'store' : 'no_store',
      )
    } catch {
      results.set(type, 'unknown')
    }
  }
  return results
}
