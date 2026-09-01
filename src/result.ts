import { normalizeSuiAddress } from '@mysten/sui/utils'

export type ExecutionExtraction = {
  kind: 'success' | 'failed' | 'unknown'
  effect: 'applied' | 'unknown'
  digest?: string
  packageId?: string
  packageIds?: string[]
  error?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function executionError(transaction: Record<string, unknown>): string | undefined {
  const status = record(transaction.status)
  const error = record(status?.error)
  return text(error?.message) ?? (status?.success === false ? 'Transaction execution failed.' : undefined)
}

function packageIdsFrom(transaction: Record<string, unknown>): string[] {
  const effects = record(transaction.effects)
  const changes = effects?.changedObjects
  if (!Array.isArray(changes)) return []

  const packageIds: string[] = []
  for (const value of changes) {
    const change = record(value)
    if (change?.outputState !== 'PackageWrite' || change.idOperation !== 'Created') continue
    const objectId = text(change.objectId)
    if (!objectId) continue
    try {
      packageIds.push(normalizeSuiAddress(objectId))
    } catch {
      continue
    }
  }
  return packageIds
}

function packageFields(transaction: Record<string, unknown>): {
  packageId?: string
  packageIds?: string[]
} {
  const packageIds = packageIdsFrom(transaction)
  return packageIds.length === 0
    ? {}
    : { packageId: packageIds[0]!, packageIds }
}

export function extractExecutionResult(value: unknown): ExecutionExtraction {
  const response = record(value)
  if (!response) return { kind: 'unknown', effect: 'unknown' }

  if (response.$kind === 'Transaction') {
    const transaction = record(response.Transaction)
    if (!transaction) return { kind: 'unknown', effect: 'unknown' }
    return {
      kind: 'success',
      effect: 'applied',
      ...(text(transaction.digest) ? { digest: text(transaction.digest)! } : {}),
      ...packageFields(transaction),
    }
  }

  if (response.$kind === 'FailedTransaction') {
    const transaction = record(response.FailedTransaction)
    if (!transaction) return { kind: 'failed', effect: 'applied' }
    return {
      kind: 'failed',
      effect: 'applied',
      ...(text(transaction.digest) ? { digest: text(transaction.digest)! } : {}),
      ...(executionError(transaction) ? { error: executionError(transaction)! } : {}),
    }
  }

  // Tolerate the unwrapped transaction returned by some status endpoints.
  if (text(response.digest) && record(response.status)) {
    const status = record(response.status)!
    return {
      kind: status.success === true ? 'success' : status.success === false ? 'failed' : 'unknown',
      effect: status.success === true || status.success === false ? 'applied' : 'unknown',
      digest: text(response.digest)!,
      ...packageFields(response),
      ...(executionError(response) ? { error: executionError(response)! } : {}),
    }
  }

  return { kind: 'unknown', effect: 'unknown' }
}

/** Extract all freshly published package IDs from any supported execution response. */
export function extractPublishedPackageIds(value: unknown): string[] {
  return extractExecutionResult(value).packageIds ?? []
}
