import { describe, expect, test } from 'bun:test'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import {
  checkStoreAbilities,
  localStoreAbility,
  selectCreatedOwnedObjects,
  selectCreatedPackageIds,
} from '../src/created-objects.js'
import capsPackage from './fixtures/caps-package.json' with { type: 'json' }
import onaraExecuted from './fixtures/onara-executed-publish.json' with { type: 'json' }

const SENDER = normalizeSuiAddress('0xa11ce')
const OTHER = normalizeSuiAddress('0xb0b')
const PACKAGE_ID = normalizeSuiAddress('0xcafe')

function change(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    objectId: '0x1',
    inputState: 'DoesNotExist',
    idOperation: 'Created',
    outputState: 'ObjectWrite',
    outputOwner: { $kind: 'AddressOwner', AddressOwner: SENDER },
    outputVersion: '7',
    outputDigest: 'digest',
    ...overrides,
  }
}

describe('selectCreatedOwnedObjects', () => {
  test('selects only objects created for and owned by the sender', () => {
    const effects = {
      changedObjects: [
        change({ objectId: '0xA1' }),
        change({ objectId: PACKAGE_ID, outputState: 'PackageWrite', outputOwner: null }),
        change({ objectId: '0xa2', outputOwner: { $kind: 'Shared', Shared: { initialSharedVersion: '7' } } }),
        change({ objectId: '0xa3', outputOwner: { $kind: 'Immutable', Immutable: true } }),
        change({ objectId: '0xa4', outputOwner: { $kind: 'AddressOwner', AddressOwner: OTHER } }),
        change({ objectId: '0xa5', outputOwner: { $kind: 'ObjectOwner', ObjectOwner: SENDER } }),
        change({ objectId: '0xa6', idOperation: 'None', inputState: 'Exists' }),
        change({ objectId: '0xa7', idOperation: 'Deleted', outputState: 'DoesNotExist', outputOwner: null }),
        change({ objectId: '0xa8', outputState: 'AccumulatorWriteV1', idOperation: 'None', outputOwner: null }),
      ],
    }
    const objectTypes = { [normalizeSuiAddress('0xa1')]: `${PACKAGE_ID}::caps::AdminCap` }
    expect(selectCreatedOwnedObjects(effects, objectTypes, '0xA11CE')).toEqual([
      {
        objectId: normalizeSuiAddress('0xa1'),
        type: `${PACKAGE_ID}::caps::AdminCap`,
        owner: SENDER,
        version: '7',
        digest: 'digest',
      },
    ])
  })

  test('matches short owner and type-map addresses after normalization', () => {
    const effects = { changedObjects: [change({ objectId: '0xb1', outputOwner: { AddressOwner: '0xa11ce' } })] }
    const selected = selectCreatedOwnedObjects(effects, { '0xb1': '0x2::coin::TreasuryCap<0x2::sui::SUI>' }, SENDER)
    expect(selected.map((object) => object.type)).toEqual(['0x2::coin::TreasuryCap<0x2::sui::SUI>'])
  })

  test('selects nothing from a realistic immutable publish', () => {
    const sender = normalizeSuiAddress('0x67b0d0726fb28fec53e25c97b6ae10cc5101111225d6e74a6ec18f58c6ce03b2')
    expect(selectCreatedOwnedObjects(onaraExecuted.effects, onaraExecuted.objectTypes, sender)).toEqual([])
    expect(selectCreatedPackageIds(onaraExecuted.effects)).toEqual([
      '0xe78e0aca82c949b270bce3c581484dc2528968bb53c0cc53fcab6b125b99ab39',
    ])
    expect(JSON.stringify(onaraExecuted)).not.toContain('UpgradeCap')
  })

  test('reads the Onara receipt shape with a created cap', () => {
    const effects = {
      ...onaraExecuted.effects,
      changedObjects: [...onaraExecuted.effects.changedObjects, change({ objectId: '0xc1' })],
    }
    const objectTypes = { ...onaraExecuted.objectTypes, [normalizeSuiAddress('0xc1')]: '0xe78e::caps::AdminCap' }
    expect(selectCreatedOwnedObjects(effects, objectTypes, SENDER)).toHaveLength(1)
  })

  test('tolerates malformed input', () => {
    expect(selectCreatedOwnedObjects(undefined, undefined, SENDER)).toEqual([])
    expect(selectCreatedOwnedObjects({ changedObjects: 'x' }, null, SENDER)).toEqual([])
    expect(selectCreatedOwnedObjects({ changedObjects: [change({})] }, null, SENDER)[0]?.type).toBe('unknown')
  })
})

describe('store ability checks', () => {
  const modules = capsPackage.modules

  test('reads store from the batch bytecode', () => {
    expect(localStoreAbility(`${PACKAGE_ID}::caps::AdminCap`, modules)).toBe('store')
    expect(localStoreAbility(`${PACKAGE_ID}::caps::Ticket`, modules)).toBe('no_store')
    expect(localStoreAbility(`${PACKAGE_ID}::caps::Pair<u8, u64>`, modules)).toBe('store')
  })

  test('returns unknown for missing, conflicting, or unparsable matches', () => {
    expect(localStoreAbility(`${PACKAGE_ID}::caps::Missing`, modules)).toBe('unknown')
    expect(localStoreAbility(`${PACKAGE_ID}::other::AdminCap`, modules)).toBe('unknown')
    expect(localStoreAbility(`${PACKAGE_ID}::caps::AdminCap`, [...modules, ...modules])).toBe('unknown')
    expect(localStoreAbility(`${PACKAGE_ID}::caps::AdminCap`, [...modules, 'AAAA'])).toBe('unknown')
    expect(localStoreAbility('not a type', modules)).toBe('unknown')
  })

  test('uses bytecode for created packages and the RPC for dependencies', async () => {
    const lookups: string[] = []
    const results = await checkStoreAbilities({
      types: [
        `${PACKAGE_ID}::caps::AdminCap`,
        `${PACKAGE_ID}::caps::Ticket`,
        '0x2::coin::TreasuryCap<0xcafe::caps::Pair<u8, u8>>',
        '0x3::broken::Thing',
      ],
      createdPackageIds: ['0xcafe'],
      modules,
      lookup: {
        getDatatype: async (input) => {
          lookups.push(`${input.packageId}::${input.moduleName}::${input.name}`)
          if (input.moduleName === 'broken') throw new Error('not found')
          return { response: { datatype: { abilities: [3, 4] } } }
        },
      },
    })
    expect(Object.fromEntries(results)).toEqual({
      [`${PACKAGE_ID}::caps::AdminCap`]: 'store',
      [`${PACKAGE_ID}::caps::Ticket`]: 'no_store',
      '0x2::coin::TreasuryCap<0xcafe::caps::Pair<u8, u8>>': 'store',
      '0x3::broken::Thing': 'unknown',
    })
    expect(lookups).toEqual([
      `${normalizeSuiAddress('0x2')}::coin::TreasuryCap`,
      `${normalizeSuiAddress('0x3')}::broken::Thing`,
    ])
  })
})
