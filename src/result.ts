import { normalizeSuiAddress } from '@mysten/sui/utils'

type ExecutionExtraction = {
  kind: 'success' | 'failed' | 'unknown'
  digest?: string
  packageId?: string
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

function packageIdFrom(transaction: Record<string, unknown>): string | undefined {
  const effects = record(transaction.effects)
  const changes = effects?.changedObjects
  if (!Array.isArray(changes)) return undefined

  for (const value of changes) {
    const change = record(value)
    if (change?.outputState !== 'PackageWrite' || change.idOperation !== 'Created') continue
    const objectId = text(change.objectId)
    if (!objectId) continue
    try {
      return normalizeSuiAddress(objectId)
    } catch {
      continue
    }
  }
  return undefined
}

export function extractExecutionResult(value: unknown): ExecutionExtraction {
  const response = record(value)
  if (!response) return { kind: 'unknown' }

  if (response.$kind === 'Transaction') {
    const transaction = record(response.Transaction)
    if (!transaction) return { kind: 'unknown' }
    return {
      kind: 'success',
      ...(text(transaction.digest) ? { digest: text(transaction.digest)! } : {}),
      ...(packageIdFrom(transaction) ? { packageId: packageIdFrom(transaction)! } : {}),
    }
  }

  if (response.$kind === 'FailedTransaction') {
    const transaction = record(response.FailedTransaction)
    if (!transaction) return { kind: 'failed' }
    return {
      kind: 'failed',
      ...(text(transaction.digest) ? { digest: text(transaction.digest)! } : {}),
      ...(executionError(transaction) ? { error: executionError(transaction)! } : {}),
    }
  }

  // Tolerate the unwrapped transaction returned by some status endpoints.
  if (text(response.digest) && record(response.status)) {
    const status = record(response.status)!
    return {
      kind: status.success === true ? 'success' : status.success === false ? 'failed' : 'unknown',
      digest: text(response.digest)!,
      ...(packageIdFrom(response) ? { packageId: packageIdFrom(response)! } : {}),
      ...(executionError(response) ? { error: executionError(response)! } : {}),
    }
  }

  return { kind: 'unknown' }
}
