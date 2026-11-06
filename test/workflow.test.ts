import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { resolveNetworkConfig } from '../src/config.js'
import { PublishError } from '../src/errors.js'
import { OnaraHttpError } from '../src/onara-client.js'
import type { PublishPackagesOptions } from '../src/types.js'
import { publishPackagesWithClients, type PublishClient, type PublishContext } from '../src/workflow.js'
import capsPackage from './fixtures/caps-package.json' with { type: 'json' }

const SPONSOR = normalizeSuiAddress('0x5')
const RECIPIENT = normalizeSuiAddress('0xbeef')
const PACKAGE_ID = normalizeSuiAddress('0xcafe')
const CAP_ID = normalizeSuiAddress('0xc1')
const TICKET_ID = normalizeSuiAddress('0xc2')
const ADMIN_CAP = `${PACKAGE_ID}::caps::AdminCap`
const TICKET = `${PACKAGE_ID}::caps::Ticket`
const OBJECT_DIGEST = '6jf6YS2cpSWp96AKcquJnKNEjz7FnA9NAQKGu9W29Bzf'

type Created = { objectId: string; type: string }

function effectsFor(digest: string, sender: string, created: readonly Created[]) {
  return {
    transactionDigest: digest,
    status: { success: true, error: null },
    gasUsed: { computationCost: '1000', storageCost: '1000', storageRebate: '0', nonRefundableStorageFee: '0' },
    changedObjects: [
      {
        objectId: PACKAGE_ID,
        idOperation: 'Created',
        outputState: 'PackageWrite',
        outputOwner: null,
        outputVersion: '1',
        outputDigest: OBJECT_DIGEST,
      },
      ...created.map((object) => ({
        objectId: object.objectId,
        idOperation: 'Created',
        outputState: 'ObjectWrite',
        outputOwner: { $kind: 'AddressOwner', AddressOwner: sender },
        outputVersion: '2',
        outputDigest: OBJECT_DIGEST,
      })),
    ],
  }
}

function objectTypesFor(created: readonly Created[]): Record<string, string> {
  return {
    [PACKAGE_ID]: 'package',
    ...Object.fromEntries(created.map((object) => [object.objectId, object.type])),
  }
}

function isPublish(bytes: Uint8Array | string): boolean {
  return Transaction.from(bytes).getData().commands.some((command) => command.$kind === 'Publish')
}

type Harness = {
  context: PublishContext
  sponsorCalls: { dryRun: boolean; publish: boolean; sender: string }[]
  waits: string[]
}

function harness(options: {
  created?: Created[]
  publishResponse?: (digest: string, sender: string) => unknown
  forwardResponse?: (digest: string) => unknown
  datatypeAbilities?: number[]
  onSimulate?: (sender: string) => Promise<void>
}): Harness {
  const created = options.created ?? []
  const sponsorCalls: Harness['sponsorCalls'] = []
  const waits: string[] = []
  const client = {
    core: {
      resolveTransactionPlugin: () => async (data: any, _options: unknown, next: () => Promise<void>) => {
        data.gasData.price ??= '1000'
        data.gasData.budget ??= '50000000'
        data.expiration ??= {
          $kind: 'ValidDuring',
          ValidDuring: {
            minEpoch: '1',
            maxEpoch: '2',
            minTimestamp: null,
            maxTimestamp: null,
            chain: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD',
            nonce: 7,
          },
        }
        await next()
      },
      simulateTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
        const parsed = Transaction.from(transaction)
        const digest = await parsed.getDigest()
        const sender = parsed.getData().sender!
        await options.onSimulate?.(sender)
        return {
          $kind: 'Transaction',
          Transaction: {
            digest,
            effects: effectsFor(digest, sender, created),
            objectTypes: objectTypesFor(created),
          },
        }
      },
      waitForTransaction: async ({ digest }: { digest: string }) => {
        waits.push(digest)
        return { $kind: 'Transaction', Transaction: { digest } }
      },
    },
    movePackageService: {
      getPackage: async () => {
        throw new Error('getPackage is not expected for a one-package batch')
      },
      getDatatype: async () => ({ response: { datatype: { abilities: options.datatypeAbilities ?? [] } } }),
    },
  } as unknown as PublishClient

  const onara = {
    sponsor: async (request: { sender: string; txBytes: string; dryRun: boolean }) => {
      const parsed = Transaction.from(request.txBytes)
      const digest = await parsed.getDigest()
      const publish = isPublish(request.txBytes)
      sponsorCalls.push({ dryRun: request.dryRun, publish, sender: request.sender })
      if (request.dryRun) return { digest, dryRun: true, policy: 'allow-all' }
      if (publish) {
        if (options.publishResponse) return options.publishResponse(digest, request.sender) as Record<string, unknown>
        return {
          digest,
          effects: effectsFor(digest, request.sender, created),
          objectTypes: objectTypesFor(created),
        }
      }
      if (options.forwardResponse) return options.forwardResponse(digest) as Record<string, unknown>
      return { digest, effects: { transactionDigest: digest, status: { success: true }, changedObjects: [] } }
    },
  }

  return {
    context: {
      client,
      onara,
      sponsor: SPONSOR,
      config: resolveNetworkConfig('testnet', { onaraUrl: 'https://onara.test' }),
    },
    sponsorCalls,
    waits,
  }
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'publish-workflow-test-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function options(overrides: Partial<PublishPackagesOptions> = {}): PublishPackagesOptions {
  return {
    network: 'testnet',
    onaraUrl: 'https://onara.test',
    timeoutMs: 5_000,
    dryRun: false,
    packages: [
      {
        packagePath: '/move/caps',
        artifact: { modules: capsPackage.modules, dependencies: capsPackage.dependencies, digest: capsPackage.digest },
        moduleNames: ['caps'],
        suiCliVersion: 'sui 1.82.1-test',
      },
    ],
    recoveryKeyDirectory: directory,
    ...overrides,
  }
}

async function expectPublishError(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PublishError)
    return error as PublishError
  }
  throw new Error('expected a PublishError')
}

const CAP: Created = { objectId: CAP_ID, type: ADMIN_CAP }
const TICKET_OBJECT: Created = { objectId: TICKET_ID, type: TICKET }

describe('publishPackagesWithClients', () => {
  test('keeps the receipt unchanged when nothing owned is created', async () => {
    const run = harness({})
    const receipt = await publishPackagesWithClients(run.context, options())
    expect(receipt).toMatchObject({ outcome: 'published', effect: 'applied', packageIds: [PACKAGE_ID] })
    expect(receipt).not.toHaveProperty('createdObjects')
    expect(run.sponsorCalls).toHaveLength(1)
    expect(await readdir(directory)).toEqual([])
  })

  test('reports an empty created-objects set when a recipient is given', async () => {
    const run = harness({})
    const receipt = await publishPackagesWithClients(run.context, options({ createdObjectsRecipient: '0xBEEF' }))
    expect(receipt.createdObjects).toEqual({ recipient: RECIPIENT, forwarded: false, objects: [] })
    expect(run.sponsorCalls).toHaveLength(1)
    expect(await readdir(directory)).toEqual([])
  })

  test('refuses to strand created objects before contacting Onara', async () => {
    const run = harness({ created: [CAP] })
    for (const dryRun of [false, true]) {
      const error = await expectPublishError(publishPackagesWithClients(run.context, options({ dryRun })))
      expect(error).toMatchObject({ code: 'CREATED_OBJECTS_RECIPIENT_REQUIRED', exitCode: 2, effect: 'not_applied' })
      expect(error.message).toContain('1 owned object')
      expect(error.message).toContain('--created-objects-recipient <address>')
      expect(error.details).toContain(`${ADMIN_CAP} (owner 0x`)
    }
    expect(run.sponsorCalls).toHaveLength(0)
  })

  test('rejects the zero recipient and a recipient combined with the escape hatch', async () => {
    const run = harness({ created: [CAP] })
    const zero = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: '0x0' })),
    )
    expect(zero).toMatchObject({ code: 'INVALID_CREATED_OBJECTS_RECIPIENT', exitCode: 2 })
    const both = await expectPublishError(
      publishPackagesWithClients(
        run.context,
        options({ createdObjectsRecipient: RECIPIENT, allowLostCreatedObjects: true }),
      ),
    )
    expect(both).toMatchObject({ code: 'INVALID_USAGE', exitCode: 2 })
    expect(run.sponsorCalls).toHaveLength(0)
  })

  test('reports a dry run without IDs or a key file', async () => {
    const run = harness({ created: [CAP] })
    const receipt = await publishPackagesWithClients(
      run.context,
      options({ dryRun: true, createdObjectsRecipient: RECIPIENT }),
    )
    expect(receipt.outcome).toBe('validated')
    expect(receipt.createdObjects).toEqual({
      recipient: RECIPIENT,
      forwarded: false,
      objects: [{ type: ADMIN_CAP, owner: receipt.sender }],
    })
    expect(run.sponsorCalls).toEqual([{ dryRun: true, publish: true, sender: receipt.sender }])
    expect(await readdir(directory)).toEqual([])
  })

  test('refuses to publish a type without store when forwarding', async () => {
    const run = harness({ created: [CAP, TICKET_OBJECT] })
    const error = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT })),
    )
    expect(error).toMatchObject({ code: 'CREATED_OBJECTS_NOT_TRANSFERABLE', exitCode: 1, effect: 'not_applied' })
    expect(error.details).toContain(TICKET)
    expect(error.details).not.toContain(ADMIN_CAP)
    expect(run.sponsorCalls).toHaveLength(0)
    expect(await readdir(directory)).toEqual([])
  })

  test('checks dependency types onchain', async () => {
    const coin = '0x2::coin::TreasuryCap<0x2::sui::SUI>'
    const run = harness({ created: [{ objectId: CAP_ID, type: coin }], datatypeAbilities: [4] })
    const error = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT })),
    )
    expect(error.code).toBe('CREATED_OBJECTS_NOT_TRANSFERABLE')

    const transferable = harness({ created: [{ objectId: CAP_ID, type: coin }], datatypeAbilities: [3, 4] })
    const receipt = await publishPackagesWithClients(
      transferable.context,
      options({ createdObjectsRecipient: RECIPIENT }),
    )
    expect(receipt.createdObjects?.forwarded).toBe(true)
  })

  test('forwards created objects and deletes the recovery key', async () => {
    const run = harness({ created: [CAP] })
    const receipt = await publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT }))
    expect(run.sponsorCalls.map((call) => call.publish)).toEqual([true, false])
    expect(run.sponsorCalls.every((call) => call.sender === receipt.sender && !call.dryRun)).toBe(true)
    expect(run.waits).toEqual([receipt.transactionDigest!])
    expect(receipt.createdObjects).toMatchObject({
      recipient: RECIPIENT,
      forwarded: true,
      objects: [{ objectId: CAP_ID, type: ADMIN_CAP, owner: receipt.sender }],
    })
    expect(receipt.createdObjects?.transactionDigest).toBeString()
    expect(receipt.createdObjects?.transactionDigest).not.toBe(receipt.transactionDigest)
    expect(receipt.createdObjects).not.toHaveProperty('recoveryKeyFile')
    expect(await readdir(directory)).toEqual([])
  })

  test('keeps a 0600 recovery key when forwarding fails', async () => {
    const run = harness({
      created: [CAP],
      forwardResponse: () => {
        throw new OnaraHttpError('Policy denied transaction', 403)
      },
    })
    const receipt = await publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT }))
    expect(receipt.outcome).toBe('published')
    const created = receipt.createdObjects!
    expect(created).toMatchObject({
      recipient: RECIPIENT,
      forwarded: false,
      objects: [{ objectId: CAP_ID, type: ADMIN_CAP, owner: receipt.sender }],
    })
    expect(created.error).toContain('Policy denied transaction')
    expect(created).not.toHaveProperty('transactionDigest')
    expect(created.recoveryKeyFile).toBe(join(directory, `publish-recovery-${receipt.sender}.key`))
    const file = created.recoveryKeyFile!
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const key = await readFile(file, 'utf8')
    expect(key).toStartWith('suiprivkey1')
    expect(key.endsWith('\n')).toBe(true)
    expect(Ed25519Keypair.fromSecretKey(key.trim()).toSuiAddress()).toBe(receipt.sender)
    expect(JSON.stringify(receipt)).not.toContain(key.trim())
  })

  test('keeps the forwarding digest when its outcome is unknown', async () => {
    const run = harness({
      created: [CAP],
      forwardResponse: (digest) => {
        throw new OnaraHttpError('timeout', 504, { digest, txStatus: 'unconfirmed' })
      },
    })
    const receipt = await publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT }))
    expect(receipt.createdObjects?.forwarded).toBe(false)
    expect(receipt.createdObjects?.transactionDigest).toBeString()
    expect(receipt.createdObjects?.recoveryKeyFile).toBeString()
  })

  test('deletes the recovery key when the publish is not applied', async () => {
    const run = harness({
      created: [CAP],
      publishResponse: () => {
        throw new OnaraHttpError('Policy denied transaction', 403)
      },
    })
    const error = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT })),
    )
    expect(error).toMatchObject({ code: 'SPONSORSHIP_DENIED', effect: 'not_applied' })
    expect(error.recoveryKeyFile).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
  })

  test('deletes the recovery key when the publish fails onchain', async () => {
    const run = harness({
      created: [CAP],
      publishResponse: (digest) => ({
        digest,
        effects: { transactionDigest: digest, status: { success: false, error: { message: 'Move abort' } } },
      }),
    })
    const error = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT })),
    )
    expect(error).toMatchObject({ code: 'TRANSACTION_FAILED', effect: 'applied' })
    expect(await readdir(directory)).toEqual([])
  })

  test('keeps the recovery key and reports it when the publish outcome is unknown', async () => {
    const run = harness({
      created: [CAP],
      publishResponse: (digest) => {
        throw new OnaraHttpError('timeout', 504, { digest, txStatus: 'unconfirmed' })
      },
    })
    const error = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT })),
    )
    expect(error).toMatchObject({ code: 'EXECUTION_UNCONFIRMED', exitCode: 3, effect: 'unknown' })
    expect(error.recoveryKeyFile).toBeString()
    expect(error.objects).toEqual([{ objectId: CAP_ID, type: ADMIN_CAP, owner: expect.any(String) }])
    expect((await stat(error.recoveryKeyFile!)).mode & 0o777).toBe(0o600)
  })

  test('refuses to overwrite an existing recovery key before publishing', async () => {
    let existing = ''
    const run = harness({
      created: [CAP],
      onSimulate: async (sender) => {
        existing = join(directory, `publish-recovery-${sender}.key`)
        await writeFile(existing, 'existing\n')
      },
    })
    const error = await expectPublishError(
      publishPackagesWithClients(run.context, options({ createdObjectsRecipient: RECIPIENT })),
    )
    expect(error).toMatchObject({ code: 'RECOVERY_KEY_WRITE_FAILED', effect: 'not_applied' })
    expect(run.sponsorCalls).toHaveLength(0)
    expect(await readFile(existing, 'utf8')).toBe('existing\n')
  })

  test('allows lost objects only when requested and reports them', async () => {
    const run = harness({ created: [CAP, TICKET_OBJECT] })
    const receipt = await publishPackagesWithClients(run.context, options({ allowLostCreatedObjects: true }))
    expect(receipt.createdObjects).toEqual({
      recipient: null,
      forwarded: false,
      objects: [
        { objectId: CAP_ID, type: ADMIN_CAP, owner: receipt.sender },
        { objectId: TICKET_ID, type: TICKET, owner: receipt.sender },
      ],
    })
    expect(run.sponsorCalls).toHaveLength(1)
    expect(await readdir(directory)).toEqual([])
  })
})
