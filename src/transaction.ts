import { Transaction } from '@mysten/sui/transactions'
import { PublishError } from './errors.js'
import { isKnownObjectType, type CreatedOwnedObject } from './created-objects.js'
import type { MoveBuildArtifact } from './types.js'

export const MAX_IMMUTABLE_PUBLISHES = 5

/**
 * Append one atomic `Publish -> make_immutable` pair to an existing transaction.
 *
 * The caller retains control of the transaction sender, gas, signing, execution,
 * and any commands before or after the publish.
 */
export function addImmutablePublish(
  transaction: Transaction,
  artifact: Pick<MoveBuildArtifact, 'modules' | 'dependencies'>,
): void {
  if (artifact.modules.length === 0) {
    throw new PublishError('EMPTY_PACKAGE', 'An immutable publish requires at least one module.')
  }

  const [upgradeCap] = transaction.publish({
    modules: artifact.modules,
    dependencies: artifact.dependencies,
  })
  transaction.moveCall({
    target: '0x2::package::make_immutable',
    arguments: [upgradeCap!],
  })
}

/** Create an executor-neutral transaction containing one or more immutable publishes. */
export function createImmutablePublishTransaction(
  artifacts: readonly Pick<MoveBuildArtifact, 'modules' | 'dependencies'>[],
): Transaction {
  if (artifacts.length === 0) {
    throw new PublishError('EMPTY_BATCH', 'An immutable publish transaction requires at least one package.')
  }
  if (artifacts.length > MAX_IMMUTABLE_PUBLISHES) {
    throw new PublishError(
      'PUBLISH_BATCH_LIMIT',
      `An immutable publish transaction supports at most ${MAX_IMMUTABLE_PUBLISHES} packages.`,
    )
  }

  const transaction = new Transaction()
  for (const artifact of artifacts) addImmutablePublish(transaction, artifact)
  return transaction
}

/**
 * Create a transaction that moves owned objects to `recipient` with one
 * `0x2::transfer::public_transfer<T>` call per object. Sponsors that require a
 * MoveCall accept it, and it never touches the gas coin. Every type must have
 * `store`; an object whose type is unknown cannot be forwarded.
 */
export function createForwardingTransaction(
  objects: readonly Pick<CreatedOwnedObject, 'objectId' | 'type' | 'version' | 'digest'>[],
  recipient: string,
): Transaction {
  if (objects.length === 0) {
    throw new PublishError('EMPTY_FORWARD', 'A forwarding transaction requires at least one object.')
  }
  const unknown = objects.filter((object) => !isKnownObjectType(object.type))
  if (unknown.length > 0) {
    throw new PublishError(
      'CREATED_OBJECTS_TYPE_UNKNOWN',
      'Created objects without a known type cannot be forwarded.',
      { details: unknown.map((object) => `${object.objectId}: ${object.type}`).join('\n') },
    )
  }

  const transaction = new Transaction()
  const to = transaction.pure.address(recipient)
  for (const object of objects) {
    transaction.moveCall({
      target: '0x2::transfer::public_transfer',
      typeArguments: [object.type],
      arguments: [
        transaction.objectRef({ objectId: object.objectId, version: object.version, digest: object.digest }),
        to,
      ],
    })
  }
  return transaction
}
