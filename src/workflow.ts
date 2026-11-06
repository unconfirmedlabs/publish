import { chmod, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { isValidSuiAddress, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { resolveNetworkConfig, type NetworkConfig } from './config.js'
import {
  checkStoreAbilities,
  selectCreatedOwnedObjects,
  selectCreatedPackageIds,
  type CreatedOwnedObject,
} from './created-objects.js'
import { PublishError } from './errors.js'
import { OnaraHttpClient, OnaraHttpError } from './onara-client.js'
import { extractExecutionResult } from './result.js'
import { createImmutablePublishTransaction } from './transaction.js'
import type {
  CreatedObjectReceipt,
  CreatedObjectsReceipt,
  PublishBatchPackageReceipt,
  PublishBatchReceipt,
  PublishPackageOptions,
  PublishPackagesOptions,
  PublishReceipt,
  StatusOptions,
  StatusReceipt,
} from './types.js'

/** The Sui client surface used by the batch workflow. */
export type PublishClient = ClientWithCoreApi & {
  movePackageService: Pick<SuiGrpcClient['movePackageService'], 'getPackage' | 'getDatatype'>
}

export type PublishContext = {
  client: PublishClient
  onara: Pick<OnaraHttpClient, 'sponsor'>
  sponsor: string
  config: NetworkConfig
}

export function createBoundedFetch(timeoutMs: number): typeof fetch {
  return (async (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (init?.signal) signals.push(init.signal)
    return fetch(input, { ...init, signal: AbortSignal.any(signals) })
  }) as typeof fetch
}

export function packageDigestHex(digest: number[]): string {
  return `0x${Buffer.from(digest).toString('hex')}`
}

export function sponsorshipError(
  error: unknown,
  digest: string,
): PublishError {
  if (error instanceof OnaraHttpError) {
    const onaraError = error
    if (onaraError.txStatus === 'unconfirmed' && onaraError.digest) {
      return new PublishError('EXECUTION_UNCONFIRMED', onaraError.message, {
        exitCode: 3,
        effect: 'unknown',
        digest: onaraError.digest,
        cause: onaraError,
      })
    }
    if (onaraError.txStatus === 'applied' && onaraError.digest) {
      return new PublishError('TRANSACTION_FAILED', onaraError.message, {
        effect: 'applied',
        digest: onaraError.digest,
        cause: onaraError,
      })
    }
    if (onaraError.txStatus === 'unknown' || onaraError.status >= 500 || onaraError.status === 0) {
      const knownDigest = onaraError.digest ?? digest
      return new PublishError('EXECUTION_UNKNOWN', onaraError.message, {
        exitCode: 3,
        effect: 'unknown',
        digest: knownDigest,
        cause: onaraError,
      })
    }
    return new PublishError(
      onaraError.status === 403 ? 'SPONSORSHIP_DENIED' : 'SPONSORSHIP_REJECTED',
      onaraError.message,
      { effect: 'not_applied', cause: onaraError },
    )
  }

  return new PublishError(
    'EXECUTION_UNKNOWN',
    error instanceof Error ? error.message : 'Onara request failed with an unknown outcome.',
    {
      exitCode: 3,
      effect: 'unknown',
      digest,
      cause: error,
    },
  )
}

export async function assertNetworkIdentity(options: {
  client: SuiGrpcClient
  onara: OnaraHttpClient
  network: string
  chainId: string
  signal?: AbortSignal
}): Promise<{ sponsor: string }> {
  let status
  let rpcIdentity
  try {
    ;[status, rpcIdentity] = await Promise.all([
      options.onara.status(),
      options.client.getChainIdentifier({ ...(options.signal ? { signal: options.signal } : {}) }),
    ])
  } catch (error) {
    throw new PublishError('NETWORK_UNAVAILABLE', 'Unable to verify the Sui and Onara endpoints.', {
      ...(error instanceof Error ? { details: error.message } : {}),
      cause: error,
    })
  }

  if (status.network !== options.network || status.chainId !== options.chainId) {
    throw new PublishError('ONARA_NETWORK_MISMATCH', 'Onara endpoint does not match --network.', {
      details: `expected ${options.network} (${options.chainId}), received ${status.network} (${status.chainId})`,
    })
  }
  if (rpcIdentity.chainIdentifier !== options.chainId) {
    throw new PublishError('RPC_NETWORK_MISMATCH', 'Sui RPC endpoint does not match --network.', {
      details: `expected ${options.chainId}, received ${rpcIdentity.chainIdentifier}`,
    })
  }
  return { sponsor: status.address }
}

export async function publishPackage(options: PublishPackageOptions): Promise<PublishReceipt> {
  const config = resolveNetworkConfig(options.network, {
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    onaraUrl: options.onaraUrl,
  })
  const client = new SuiGrpcClient({ network: config.network, baseUrl: config.rpcUrl })
  const onara = new OnaraHttpClient({
    url: config.onaraUrl,
    fetch: createBoundedFetch(options.timeoutMs),
  })
  const { sponsor } = await assertNetworkIdentity({
    client,
    onara,
    network: config.network,
    chainId: config.chainId,
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const signer = new Ed25519Keypair()
  const sender = signer.toSuiAddress()
  if (sender === sponsor) {
    throw new PublishError('INVALID_SPONSOR', 'Ephemeral sender unexpectedly equals the sponsor address.')
  }

  const transaction = createImmutablePublishTransaction([options.artifact])
  transaction.setSender(sender)
  transaction.setGasOwner(sponsor)
  transaction.setGasPayment([])

  let bytes: Uint8Array
  let digest: string
  try {
    bytes = await transaction.build({ client })
    digest = await transaction.getDigest()
  } catch (error) {
    throw new PublishError('TRANSACTION_BUILD_FAILED', 'Unable to build or simulate the publish transaction.', {
      ...(error instanceof Error ? { details: error.message } : {}),
      cause: error,
    })
  }

  const { signature } = await signer.signTransaction(bytes)
  let response: unknown
  try {
    response = await onara.sponsor({
      sender,
      txBytes: toBase64(bytes),
      txSignature: signature,
      dryRun: options.dryRun,
      waitForExecution: true,
    })
  } catch (error) {
    throw sponsorshipError(error, digest)
  }

  const common = {
    schemaVersion: 1 as const,
    operation: 'publish' as const,
    network: config.network,
    packagePath: options.packagePath,
    packageDigest: packageDigestHex(options.artifact.digest),
    moduleCount: options.artifact.modules.length,
    dependencyCount: options.artifact.dependencies.length,
    sender,
    sponsor,
    immutable: true as const,
    onaraUrl: config.onaraUrl,
    rpcUrl: config.rpcUrl,
    suiCliVersion: options.suiCliVersion,
    gasBudget: transaction.getData().gasData.budget === null
      ? null
      : String(transaction.getData().gasData.budget),
  }

  const responseRecord =
    typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : undefined
  if (responseRecord?.dryRun === true) {
    if (!options.dryRun) {
      throw new PublishError('ONARA_DRY_RUN_ONLY', 'Onara validated the transaction but did not execute it.', {
        effect: 'not_applied',
      })
    }
    return {
      ...common,
      outcome: 'validated',
      effect: 'not_applied',
      ...(typeof responseRecord.policy === 'string' ? { policy: responseRecord.policy } : {}),
    }
  }

  if (options.dryRun) {
    throw new PublishError('INVALID_ONARA_RESPONSE', 'Onara returned an executable result for a dry run.', {
      effect: 'unknown',
      exitCode: 3,
      digest,
    })
  }

  const execution = extractExecutionResult(response)
  if (execution.kind === 'failed') {
    throw new PublishError('TRANSACTION_FAILED', execution.error ?? 'Publish transaction failed onchain.', {
      effect: 'applied',
      ...(execution.digest ? { digest: execution.digest } : { digest }),
    })
  }
  if (execution.kind !== 'success') {
    throw new PublishError('INVALID_ONARA_RESPONSE', 'Onara returned an unrecognized execution response.', {
      effect: 'unknown',
      exitCode: 3,
      digest,
    })
  }

  const warnings: string[] = []
  if (!execution.packageId) {
    warnings.push('Transaction succeeded, but the package ID was not present in returned effects; use the status command to reconcile.')
  }
  return {
    ...common,
    outcome: 'published',
    effect: 'applied',
    transactionDigest: execution.digest ?? digest,
    ...(execution.packageId ? { packageId: execution.packageId } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}

function moduleSetKey(moduleNames: readonly string[]): string {
  return [...moduleNames].sort().join('\u0000')
}

async function mapPublishedPackageIds(options: {
  client: Pick<PublishClient, 'movePackageService'>
  packageIds: readonly string[]
  packages: PublishPackagesOptions['packages']
  signal?: AbortSignal
}): Promise<Map<string, string>> {
  if (options.packages.length === 1 && options.packageIds.length === 1) {
    return new Map([[options.packages[0]!.packagePath, options.packageIds[0]!]])
  }
  const expected = new Map<string, string>()
  for (const pkg of options.packages) {
    const key = moduleSetKey(pkg.moduleNames)
    if (!key || expected.has(key)) {
      throw new PublishError(
        'AMBIGUOUS_BATCH_MODULES',
        'Every package in a batch must have a unique, non-empty compiled module-name set.',
      )
    }
    expected.set(key, pkg.packagePath)
  }

  const mapped = new Map<string, string>()
  for (const packageId of options.packageIds) {
    const call = await options.client.movePackageService.getPackage(
      { packageId },
      options.signal ? { abort: options.signal } : undefined,
    )
    const names = call.response.package?.modules
      .map((module) => module.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
      .sort() ?? []
    const packagePath = expected.get(moduleSetKey(names))
    if (!packagePath || mapped.has(packagePath)) {
      throw new PublishError(
        'BATCH_PACKAGE_MAPPING_FAILED',
        'Published package IDs could not be mapped uniquely to compiled module-name sets.',
        { details: `${packageId}: ${names.join(', ')}` },
      )
    }
    mapped.set(packagePath, packageId)
  }
  if (mapped.size !== options.packages.length) {
    throw new PublishError(
      'BATCH_PACKAGE_MAPPING_FAILED',
      'The published package count does not match the requested batch.',
      { details: `expected ${options.packages.length}, mapped ${mapped.size}` },
    )
  }
  return mapped
}

function validateBatch(options: PublishPackagesOptions): void {
  if (options.packages.length < 1 || options.packages.length > 5) {
    throw new PublishError('INVALID_BATCH_SIZE', 'A publish operation must contain one through five packages.')
  }
  const packagePaths = new Set(options.packages.map((pkg) => pkg.packagePath))
  if (packagePaths.size !== options.packages.length) {
    throw new PublishError('DUPLICATE_PACKAGE_PATH', 'A publish batch cannot contain duplicate package paths.')
  }
  const versions = new Set(options.packages.map((pkg) => pkg.suiCliVersion))
  if (versions.size !== 1) {
    throw new PublishError('SUI_VERSION_MISMATCH', 'Every package in a batch must use the same Sui CLI version.')
  }
  const moduleSets = options.packages.map((pkg) => moduleSetKey(pkg.moduleNames))
  if (options.packages.length > 1 && (moduleSets.some((key) => !key) || new Set(moduleSets).size !== moduleSets.length)) {
    throw new PublishError(
      'AMBIGUOUS_BATCH_MODULES',
      'Every package in a batch must have a unique, non-empty compiled module-name set.',
    )
  }
}

function createdObjectsRecipient(options: PublishPackagesOptions): string | undefined {
  if (options.createdObjectsRecipient === undefined) return undefined
  const value = options.createdObjectsRecipient
  const recipient = /^0x[0-9a-fA-F]{1,64}$/.test(value) ? normalizeSuiAddress(value) : undefined
  if (!recipient || !isValidSuiAddress(recipient)) {
    throw new PublishError('INVALID_CREATED_OBJECTS_RECIPIENT', 'The created-objects recipient must be a Sui address.', {
      exitCode: 2,
      details: value,
    })
  }
  if (recipient === normalizeSuiAddress('0x0')) {
    throw new PublishError(
      'INVALID_CREATED_OBJECTS_RECIPIENT',
      'The created-objects recipient cannot be the zero address; objects sent there are lost.',
      { exitCode: 2 },
    )
  }
  if (options.allowLostCreatedObjects) {
    throw new PublishError(
      'INVALID_USAGE',
      'Allowing lost created objects cannot be combined with a created-objects recipient.',
      { exitCode: 2 },
    )
  }
  return recipient
}

function objectSummary(objects: readonly CreatedOwnedObject[]): string {
  return objects.map((object) => `${object.type} (owner ${object.owner})`).join('\n')
}

function objectReceipts(objects: readonly CreatedOwnedObject[], withIds: boolean): CreatedObjectReceipt[] {
  return objects.map((object) => ({
    ...(withIds ? { objectId: object.objectId } : {}),
    type: object.type,
    owner: object.owner,
  }))
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof PublishError) return error.details ? `${error.message} ${error.details}` : error.message
  return error instanceof Error && error.message ? error.message : fallback
}

function executedEffects(response: unknown): { effects: unknown; objectTypes: unknown } | undefined {
  const root = typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : undefined
  const nested = root?.Transaction ?? root?.FailedTransaction
  const transaction =
    typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>) : root
  if (!transaction?.effects || !transaction.objectTypes) return undefined
  return { effects: transaction.effects, objectTypes: transaction.objectTypes }
}

export function recoveryKeyFileName(sender: string): string {
  return `publish-recovery-${normalizeSuiAddress(sender)}.key`
}

async function writeRecoveryKey(directory: string, sender: string, signer: Ed25519Keypair): Promise<string> {
  const path = resolve(directory, recoveryKeyFileName(sender))
  let created = false
  try {
    await writeFile(path, `${signer.getSecretKey()}\n`, { flag: 'wx', mode: 0o600 })
    created = true
    await chmod(path, 0o600)
    return path
  } catch (error) {
    if (created) await rm(path, { force: true }).catch(() => undefined)
    throw new PublishError('RECOVERY_KEY_WRITE_FAILED', 'Unable to write the created-objects recovery key file.', {
      details: `${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      cause: error,
    })
  }
}

async function removeRecoveryKey(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true })
    return true
  } catch {
    return false
  }
}

async function forwardCreatedObjects(options: {
  context: PublishContext
  signer: Ed25519Keypair
  sender: string
  recipient: string
  objects: readonly CreatedOwnedObject[]
  signal?: AbortSignal
}): Promise<{ digest: string } | { error: string; digest?: string }> {
  const { client, onara, sponsor } = options.context
  const transaction = new Transaction()
  transaction.transferObjects(
    options.objects.map((object) =>
      transaction.objectRef({ objectId: object.objectId, version: object.version, digest: object.digest }),
    ),
    options.recipient,
  )
  transaction.setSender(options.sender)
  transaction.setGasOwner(sponsor)
  transaction.setGasPayment([])

  let bytes: Uint8Array
  let digest: string
  try {
    bytes = await transaction.build({ client })
    digest = await transaction.getDigest()
  } catch (error) {
    return { error: `Unable to build the forwarding transaction: ${errorMessage(error, 'unknown error')}` }
  }

  let response: unknown
  try {
    const { signature } = await options.signer.signTransaction(bytes)
    response = await onara.sponsor({
      sender: options.sender,
      txBytes: toBase64(bytes),
      txSignature: signature,
      dryRun: false,
      waitForExecution: true,
    })
  } catch (error) {
    const failure = sponsorshipError(error, digest)
    return {
      error: `Forwarding transaction was not confirmed: ${failure.message}`,
      ...(failure.effect === 'not_applied' ? {} : { digest: failure.digest ?? digest }),
    }
  }

  const execution = extractExecutionResult(response)
  if (execution.kind === 'success') return { digest: execution.digest ?? digest }
  if (execution.kind === 'failed') {
    return {
      error: `Forwarding transaction failed onchain: ${execution.error ?? 'unknown error'}`,
      digest: execution.digest ?? digest,
    }
  }
  return { error: 'Onara returned an unrecognized forwarding response.', digest }
}

export async function publishPackages(options: PublishPackagesOptions): Promise<PublishBatchReceipt> {
  validateBatch(options)
  createdObjectsRecipient(options)

  const config = resolveNetworkConfig(options.network, {
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    onaraUrl: options.onaraUrl,
  })
  const client = new SuiGrpcClient({ network: config.network, baseUrl: config.rpcUrl })
  const onara = new OnaraHttpClient({
    url: config.onaraUrl,
    fetch: createBoundedFetch(options.timeoutMs),
  })
  const { sponsor } = await assertNetworkIdentity({
    client,
    onara,
    network: config.network,
    chainId: config.chainId,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return publishPackagesWithClients({ client, onara, sponsor, config }, options)
}

/**
 * The batch publish workflow after endpoint construction and identity checks.
 * Exposed so callers and tests can inject a client and an Onara sponsor.
 */
export async function publishPackagesWithClients(
  context: PublishContext,
  options: PublishPackagesOptions,
): Promise<PublishBatchReceipt> {
  validateBatch(options)
  const recipient = createdObjectsRecipient(options)
  const { client, onara, sponsor, config } = context

  const signer = new Ed25519Keypair()
  const sender = signer.toSuiAddress()
  if (sender === sponsor) {
    throw new PublishError('INVALID_SPONSOR', 'Ephemeral sender unexpectedly equals the sponsor address.')
  }

  const transaction = createImmutablePublishTransaction(options.packages.map((pkg) => pkg.artifact))
  transaction.setSender(sender)
  transaction.setGasOwner(sponsor)
  transaction.setGasPayment([])

  let bytes: Uint8Array
  let digest: string
  try {
    bytes = await transaction.build({ client })
    digest = await transaction.getDigest()
  } catch (error) {
    throw new PublishError('TRANSACTION_BUILD_FAILED', 'Unable to build or simulate the publish batch.', {
      ...(error instanceof Error ? { details: error.message } : {}),
      cause: error,
    })
  }

  let simulatedEffects: unknown
  let simulatedTypes: unknown
  try {
    const simulation = await client.core.simulateTransaction({
      transaction: bytes,
      include: { effects: true, objectTypes: true },
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (simulation.$kind !== 'Transaction') {
      throw new Error(simulation.FailedTransaction.status.error?.message ?? 'Simulation failed.')
    }
    simulatedEffects = simulation.Transaction.effects
    simulatedTypes = simulation.Transaction.objectTypes
  } catch (error) {
    throw new PublishError('TRANSACTION_BUILD_FAILED', 'Unable to simulate the publish batch.', {
      ...(error instanceof Error ? { details: error.message } : {}),
      cause: error,
    })
  }

  const stranded = selectCreatedOwnedObjects(simulatedEffects, simulatedTypes, sender)
  if (stranded.length > 0 && !recipient && !options.allowLostCreatedObjects) {
    throw new PublishError(
      'CREATED_OBJECTS_RECIPIENT_REQUIRED',
      `The publish would leave ${stranded.length} owned object${stranded.length === 1 ? '' : 's'} with the ephemeral signer. ` +
        'Pass --created-objects-recipient <address> (or --allow-lost-created-objects to discard them).',
      { exitCode: 2, details: objectSummary(stranded), objects: objectReceipts(stranded, false) },
    )
  }
  if (stranded.length > 0 && recipient) {
    const abilities = await checkStoreAbilities({
      types: stranded.map((object) => object.type),
      createdPackageIds: selectCreatedPackageIds(simulatedEffects),
      modules: options.packages.flatMap((pkg) => pkg.artifact.modules),
      lookup: client.movePackageService,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const blocked = stranded.filter((object) => abilities.get(object.type) === 'no_store')
    if (blocked.length > 0) {
      throw new PublishError(
        'CREATED_OBJECTS_NOT_TRANSFERABLE',
        `${blocked.length} created owned object${blocked.length === 1 ? ' has' : 's have'} a type without store and cannot be forwarded.`,
        { details: objectSummary(blocked), objects: objectReceipts(blocked, false) },
      )
    }
  }

  const packages: PublishBatchPackageReceipt[] = options.packages.map((pkg) => ({
    packagePath: pkg.packagePath,
    packageDigest: packageDigestHex(pkg.artifact.digest),
    moduleCount: pkg.artifact.modules.length,
    moduleNames: [...pkg.moduleNames].sort(),
    dependencyCount: pkg.artifact.dependencies.length,
  }))
  const data = transaction.getData()
  const common = {
    schemaVersion: 1 as const,
    operation: 'publish-batch' as const,
    network: config.network,
    packages,
    sender,
    sponsor,
    immutable: true as const,
    onaraUrl: config.onaraUrl,
    rpcUrl: config.rpcUrl,
    suiCliVersion: options.packages[0]!.suiCliVersion,
    gasBudget: data.gasData.budget === null ? null : String(data.gasData.budget),
  }
  const reportsObjects = recipient !== undefined || stranded.length > 0

  const { signature } = await signer.signTransaction(bytes)
  if (options.dryRun) {
    let response: unknown
    try {
      response = await onara.sponsor({
        sender,
        txBytes: toBase64(bytes),
        txSignature: signature,
        dryRun: true,
        waitForExecution: true,
      })
    } catch (error) {
      throw sponsorshipError(error, digest)
    }
    const responseRecord =
      typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : undefined
    if (responseRecord?.dryRun !== true) {
      throw new PublishError('INVALID_ONARA_RESPONSE', 'Onara returned an executable result for a batch dry run.', {
        effect: 'unknown',
        exitCode: 3,
        digest,
      })
    }
    return {
      ...common,
      outcome: 'validated',
      effect: 'not_applied',
      ...(typeof responseRecord.policy === 'string' ? { policy: responseRecord.policy } : {}),
      ...(reportsObjects
        ? {
            createdObjects: {
              recipient: recipient ?? null,
              forwarded: false,
              objects: objectReceipts(stranded, false),
            },
          }
        : {}),
    }
  }

  let recoveryKeyFile =
    recipient && stranded.length > 0
      ? await writeRecoveryKey(options.recoveryKeyDirectory ?? process.cwd(), sender, signer)
      : undefined

  try {
    let response: unknown
    try {
      response = await onara.sponsor({
        sender,
        txBytes: toBase64(bytes),
        txSignature: signature,
        dryRun: false,
        waitForExecution: true,
      })
    } catch (error) {
      throw sponsorshipError(error, digest)
    }

    const responseRecord =
      typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : undefined
    if (responseRecord?.dryRun === true) {
      throw new PublishError('ONARA_DRY_RUN_ONLY', 'Onara validated the batch but did not execute it.', {
        effect: 'not_applied',
      })
    }

    const execution = extractExecutionResult(response)
    if (execution.kind === 'failed') {
      throw new PublishError('TRANSACTION_FAILED', execution.error ?? 'Publish batch failed onchain.', {
        effect: 'applied',
        digest: execution.digest ?? digest,
      })
    }
    if (execution.kind !== 'success') {
      throw new PublishError('INVALID_ONARA_RESPONSE', 'Onara returned an unrecognized batch execution response.', {
        effect: 'unknown',
        exitCode: 3,
        digest,
      })
    }
    const transactionDigest = execution.digest ?? digest

    let createdObjects: CreatedObjectsReceipt | undefined
    if (recipient && recoveryKeyFile) {
      const keyFile = recoveryKeyFile
      let objects: CreatedOwnedObject[] = stranded
      let failure: { error: string; digest?: string } | undefined
      try {
        const waited = await client.core.waitForTransaction({
          digest: transactionDigest,
          timeout: options.timeoutMs,
          include: { effects: true, objectTypes: true },
          ...(options.signal ? { signal: options.signal } : {}),
        })
        const executed = executedEffects(response) ?? executedEffects(waited)
        if (!executed) throw new Error('Executed effects are unavailable.')
        objects = selectCreatedOwnedObjects(executed.effects, executed.objectTypes, sender)
      } catch (error) {
        failure = { error: `Unable to read the executed publish effects: ${errorMessage(error, 'unknown error')}` }
      }

      if (!failure && objects.length === 0) {
        await removeRecoveryKey(keyFile)
        recoveryKeyFile = undefined
        createdObjects = { recipient, forwarded: false, objects: [] }
      } else {
        const forwarded = failure ?? await forwardCreatedObjects({
          context,
          signer,
          sender,
          recipient,
          objects,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if ('error' in forwarded) {
          createdObjects = {
            recipient,
            forwarded: false,
            objects: objectReceipts(objects, true),
            ...(forwarded.digest ? { transactionDigest: forwarded.digest } : {}),
            recoveryKeyFile: keyFile,
            error: forwarded.error,
          }
        } else {
          const removed = await removeRecoveryKey(keyFile)
          if (removed) recoveryKeyFile = undefined
          createdObjects = {
            recipient,
            forwarded: true,
            objects: objectReceipts(objects, true),
            transactionDigest: forwarded.digest,
            ...(removed ? {} : { recoveryKeyFile: keyFile }),
          }
        }
      }
    } else if (reportsObjects) {
      const executed = executedEffects(response)
      const objects = executed
        ? selectCreatedOwnedObjects(executed.effects, executed.objectTypes, sender)
        : stranded
      createdObjects = { recipient: recipient ?? null, forwarded: false, objects: objectReceipts(objects, true) }
    }

    const packageIds = execution.packageIds ?? []
    if (packageIds.length !== options.packages.length) {
      throw new PublishError('BATCH_PACKAGE_COUNT_MISMATCH', 'The applied batch returned an unexpected package count.', {
        effect: 'applied',
        digest: transactionDigest,
        details: `expected ${options.packages.length}, received ${packageIds.length}`,
      })
    }

    let mapped: Map<string, string>
    try {
      mapped = await mapPublishedPackageIds({
        client,
        packageIds,
        packages: options.packages,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (error) {
      throw new PublishError('APPLIED_BATCH_MAPPING_FAILED', 'The batch applied, but package IDs could not be correlated.', {
        effect: 'applied',
        digest: transactionDigest,
        ...(error instanceof Error ? { details: error.message } : {}),
        cause: error,
      })
    }

    return {
      ...common,
      outcome: 'published',
      effect: 'applied',
      transactionDigest,
      packageIds,
      packages: packages.map((pkg) => ({ ...pkg, packageId: mapped.get(pkg.packagePath)! })),
      ...(createdObjects ? { createdObjects } : {}),
    }
  } catch (caught) {
    if (!recoveryKeyFile || !(caught instanceof PublishError)) throw caught
    const nothingCreated =
      caught.effect === 'not_applied' || (caught.effect === 'applied' && caught.code === 'TRANSACTION_FAILED')
    if (nothingCreated && await removeRecoveryKey(recoveryKeyFile)) throw caught
    throw new PublishError(caught.code, caught.message, {
      exitCode: caught.exitCode,
      effect: caught.effect,
      ...(caught.details ? { details: caught.details } : {}),
      ...(caught.digest ? { digest: caught.digest } : {}),
      recoveryKeyFile,
      objects: objectReceipts(stranded, true),
      cause: caught.cause,
    })
  }
}

export async function transactionStatus(options: StatusOptions): Promise<StatusReceipt> {
  const config = resolveNetworkConfig(options.network, {
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    onaraUrl: options.onaraUrl,
  })
  const onara = new OnaraHttpClient({ url: config.onaraUrl, fetch: createBoundedFetch(options.timeoutMs) })
  let response
  let status
  try {
    ;[response, status] = await Promise.all([
      onara.transactionStatus(options.digest),
      onara.status(),
    ])
  } catch (error) {
    throw new PublishError('STATUS_UNAVAILABLE', 'Unable to query transaction status.', {
      ...(error instanceof Error ? { details: error.message } : {}),
      cause: error,
    })
  }

  if (status.network !== config.network || status.chainId !== config.chainId) {
    throw new PublishError('ONARA_NETWORK_MISMATCH', 'Onara endpoint does not match --network.', {
      details: `expected ${config.network} (${config.chainId}), received ${status.network} (${status.chainId})`,
    })
  }

  if (!response.found) {
    return {
      schemaVersion: 1,
      operation: 'status',
      network: config.network,
      digest: options.digest,
      found: false,
      outcome: 'not_found',
      onaraUrl: config.onaraUrl,
    }
  }

  const execution = extractExecutionResult(response)
  return {
    schemaVersion: 1,
    operation: 'status',
    network: config.network,
    digest: execution.digest ?? options.digest,
    found: true,
    outcome: execution.kind,
    ...(execution.packageId ? { packageId: execution.packageId } : {}),
    onaraUrl: config.onaraUrl,
  }
}
