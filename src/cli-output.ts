import { PublishError } from './errors.js'
import type { CreatedObjectsReceipt, PublishBatchReceipt } from './types.js'

export function objectCount(count: number): string {
  return `${count} created object${count === 1 ? '' : 's'}`
}

export function errorDocument(error: PublishError, recovery?: string): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      code: error.code,
      message: error.message,
      effect: error.effect,
      ...(error.digest ? { digest: error.digest } : {}),
      ...(recovery ? { recovery } : {}),
      ...(error.details ? { details: error.details } : {}),
      ...(error.recoveryKeyFile ? { recoveryKeyFile: error.recoveryKeyFile } : {}),
      ...(error.objects ? { objects: error.objects } : {}),
    },
  }
}

export function createdObjectsNotForwardedError(
  receipt: PublishBatchReceipt,
  created: CreatedObjectsReceipt & { recoveryKeyFile: string },
): PublishError {
  const details = [
    ...(created.error ? [created.error] : []),
    `Recovery key file: ${created.recoveryKeyFile}`,
    ...(created.transactionDigest
      ? [`Forwarding transaction: ${created.transactionDigest} (check it with "publish status" before recovering)`]
      : []),
    'Objects:',
    ...created.objects.map((object) => `${object.objectId ?? '-'} ${object.type}`),
    'See README: Recovering created objects.',
  ]
  return new PublishError(
    'CREATED_OBJECTS_NOT_FORWARDED',
    `Published, but ${objectCount(created.objects.length)} ${created.objects.length === 1 ? 'was' : 'were'} not forwarded to ${created.recipient}.`,
    {
      exitCode: 4,
      effect: 'applied',
      ...(receipt.transactionDigest ? { digest: receipt.transactionDigest } : {}),
      details: details.join('\n'),
      recoveryKeyFile: created.recoveryKeyFile,
      objects: created.objects,
    },
  )
}
