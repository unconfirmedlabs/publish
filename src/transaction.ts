import { Transaction } from '@mysten/sui/transactions'
import { PublishError } from './errors.js'
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
