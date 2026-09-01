import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { toBase64 } from '@mysten/sui/utils'
import { resolveNetworkConfig } from './config.js'
import { PublishError } from './errors.js'
import { OnaraHttpClient, OnaraHttpError } from './onara-client.js'
import { extractExecutionResult } from './result.js'
import { createImmutablePublishTransaction } from './transaction.js'
import type {
  PublishPackageOptions,
  PublishReceipt,
  StatusOptions,
  StatusReceipt,
} from './types.js'

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
