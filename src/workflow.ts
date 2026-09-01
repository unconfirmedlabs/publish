import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { resolveNetworkConfig } from './config.js'
import { PublishError } from './errors.js'
import { OnaraHttpClient, OnaraHttpError } from './onara-client.js'
import { updatePublishedFile } from './published-file.js'
import { extractExecutionResult } from './result.js'
import type {
  MoveBuildArtifact,
  PublishOptions,
  PublishReceipt,
  StatusOptions,
  StatusReceipt,
} from './types.js'

function boundedFetch(timeoutMs: number): typeof fetch {
  return (async (input, init) => {
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (init?.signal) signals.push(init.signal)
    return fetch(input, { ...init, signal: AbortSignal.any(signals) })
  }) as typeof fetch
}

function packageDigest(digest: number[]): string {
  return `0x${Buffer.from(digest).toString('hex')}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function recoveryCommand(digest: string, network: string, onaraUrl: string): string {
  return `publish status ${digest} --network ${network} --onara-url ${shellQuote(onaraUrl)} --json`
}

function mapSponsorshipError(
  error: unknown,
  digest: string,
  network: string,
  onaraUrl: string,
): PublishError {
  if (error instanceof OnaraHttpError) {
    const onaraError = error
    if (onaraError.txStatus === 'unconfirmed' && onaraError.digest) {
      return new PublishError('EXECUTION_UNCONFIRMED', onaraError.message, {
        exitCode: 3,
        effect: 'unknown',
        digest: onaraError.digest,
        recovery: recoveryCommand(onaraError.digest, network, onaraUrl),
        cause: onaraError,
      })
    }
    if (onaraError.txStatus === 'unknown' || onaraError.status >= 500 || onaraError.status === 0) {
      const knownDigest = onaraError.digest ?? digest
      return new PublishError('EXECUTION_UNKNOWN', onaraError.message, {
        exitCode: 3,
        effect: 'unknown',
        digest: knownDigest,
        recovery: recoveryCommand(knownDigest, network, onaraUrl),
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
      recovery: recoveryCommand(digest, network, onaraUrl),
      cause: error,
    },
  )
}

async function assertNetworkIdentity(options: {
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

export async function publishPackage(options: {
  cli: PublishOptions
  packagePath: string
  artifact: MoveBuildArtifact
  suiCliVersion: string
  signal?: AbortSignal
}): Promise<PublishReceipt> {
  if (options.cli.network === 'mainnet' && !options.cli.dryRun && !options.cli.confirm) {
    throw new PublishError(
      'CONFIRMATION_REQUIRED',
      'Mainnet publishing is permanent. Re-run with --yes after reviewing a --dry-run.',
      { exitCode: 2 },
    )
  }

  const config = resolveNetworkConfig(options.cli.network, {
    ...(options.cli.rpcUrl ? { rpcUrl: options.cli.rpcUrl } : {}),
    onaraUrl: options.cli.onaraUrl,
  })
  const client = new SuiGrpcClient({ network: config.network, baseUrl: config.rpcUrl })
  const onara = new OnaraHttpClient({
    url: config.onaraUrl,
    fetch: boundedFetch(options.cli.timeoutMs),
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

  const transaction = new Transaction()
  const upgradeCap = transaction.publish({
    modules: options.artifact.modules,
    dependencies: options.artifact.dependencies,
  })[0]!
  transaction.moveCall({
    target: '0x2::package::make_immutable',
    arguments: [upgradeCap],
  })
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
      dryRun: options.cli.dryRun,
      waitForExecution: true,
    })
  } catch (error) {
    throw mapSponsorshipError(error, digest, config.network, config.onaraUrl)
  }

  const common = {
    schemaVersion: 1 as const,
    operation: 'publish' as const,
    network: config.network,
    packagePath: options.packagePath,
    packageDigest: packageDigest(options.artifact.digest),
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
    if (!options.cli.dryRun) {
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

  if (options.cli.dryRun) {
    throw new PublishError('INVALID_ONARA_RESPONSE', 'Onara returned an executable result for a dry run.', {
      effect: 'unknown',
      exitCode: 3,
      digest,
      recovery: recoveryCommand(digest, config.network, config.onaraUrl),
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
      recovery: recoveryCommand(digest, config.network, config.onaraUrl),
    })
  }

  const warnings: string[] = []
  if (!execution.packageId) {
    warnings.push('Transaction succeeded, but the package ID was not present in returned effects; use the status command to reconcile.')
  }
  let publishedFile: string | undefined
  let publishedFileUpdated: boolean | undefined
  if (options.cli.writePublished && execution.packageId) {
    try {
      publishedFile = await updatePublishedFile({
        packagePath: options.packagePath,
        network: config.network,
        chainId: config.chainId,
        packageId: execution.packageId,
        suiCliVersion: options.suiCliVersion,
      })
      publishedFileUpdated = true
    } catch (error) {
      publishedFileUpdated = false
      warnings.push(
        `Package was published, but Published.toml was not updated: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  } else if (!options.cli.writePublished) {
    publishedFileUpdated = false
  }
  return {
    ...common,
    outcome: 'published',
    effect: 'applied',
    transactionDigest: execution.digest ?? digest,
    ...(execution.packageId ? { packageId: execution.packageId } : {}),
    ...(publishedFile ? { publishedFile } : {}),
    ...(publishedFileUpdated === undefined ? {} : { publishedFileUpdated }),
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function transactionStatus(options: StatusOptions): Promise<StatusReceipt> {
  const config = resolveNetworkConfig(options.network, {
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    onaraUrl: options.onaraUrl,
  })
  const onara = new OnaraHttpClient({ url: config.onaraUrl, fetch: boundedFetch(options.timeoutMs) })
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
