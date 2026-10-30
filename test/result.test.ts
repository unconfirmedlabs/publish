import { describe, expect, test } from 'bun:test'
import { extractExecutionResult } from '../src/result.js'
import onaraExecuted from './fixtures/onara-executed-publish.json' with { type: 'json' }

describe('extractExecutionResult', () => {
  test('extracts a created package from successful effects', () => {
    expect(
      extractExecutionResult({
        $kind: 'Transaction',
        Transaction: {
          digest: 'tx',
          status: { success: true, error: null },
          effects: {
            changedObjects: [
              { objectId: '0x123', outputState: 'PackageWrite', idOperation: 'Created' },
              { objectId: '0x456', outputState: 'ObjectWrite', idOperation: 'Created' },
            ],
          },
        },
      }),
    ).toEqual({
      kind: 'success',
      effect: 'applied',
      digest: 'tx',
      packageId: `0x${'0'.repeat(61)}123`,
      packageIds: [`0x${'0'.repeat(61)}123`],
    })
  })

  test('distinguishes an applied transaction failure', () => {
    expect(
      extractExecutionResult({
        $kind: 'FailedTransaction',
        FailedTransaction: {
          digest: 'failed-tx',
          status: { success: false, error: { message: 'Move abort' } },
        },
      }),
    ).toEqual({ kind: 'failed', effect: 'applied', digest: 'failed-tx', error: 'Move abort' })
  })

  test('does not invent status for unknown responses', () => {
    expect(extractExecutionResult({ ok: true })).toEqual({ kind: 'unknown', effect: 'unknown' })
  })

  test('extracts every package ID from a batched immutable publish', () => {
    const result = extractExecutionResult({
      $kind: 'Transaction',
      Transaction: {
        digest: 'tx',
        status: { success: true },
        effects: {
          changedObjects: [
            { objectId: '0xa', outputState: 'PackageWrite', idOperation: 'Created' },
            { objectId: '0xb', outputState: 'PackageWrite', idOperation: 'Created' },
          ],
        },
      },
    })

    expect(result.packageIds).toEqual([
      `0x${'0'.repeat(63)}a`,
      `0x${'0'.repeat(63)}b`,
    ])
    expect(result.packageId).toBe(`0x${'0'.repeat(63)}a`)
  })

  test('extracts a created package from an Onara sui-effect receipt', () => {
    expect(extractExecutionResult(onaraExecuted)).toEqual({
      kind: 'success',
      effect: 'applied',
      digest: '5rXVrsgu75jnVXT1oFWjC4JtqchZ9nTPgykhPohWd411',
      packageId: '0xe78e0aca82c949b270bce3c581484dc2528968bb53c0cc53fcab6b125b99ab39',
      packageIds: ['0xe78e0aca82c949b270bce3c581484dc2528968bb53c0cc53fcab6b125b99ab39'],
    })
  })

  test('distinguishes an applied failure in an Onara sui-effect receipt', () => {
    expect(
      extractExecutionResult({
        digest: 'failed-tx',
        effects: {
          transactionDigest: 'failed-tx',
          status: { success: false, error: { message: 'Move abort' } },
          changedObjects: [],
        },
      }),
    ).toEqual({ kind: 'failed', effect: 'applied', digest: 'failed-tx', error: 'Move abort' })
  })

  test('does not trust an Onara receipt whose effects name another digest', () => {
    expect(
      extractExecutionResult({
        digest: 'tx',
        effects: { transactionDigest: 'other-tx', status: { success: true } },
      }),
    ).toEqual({ kind: 'unknown', effect: 'unknown' })
  })

  test('keeps an Onara receipt without a success flag unknown', () => {
    expect(
      extractExecutionResult({ digest: 'tx', effects: { transactionDigest: 'tx', status: {} } }),
    ).toEqual({ kind: 'unknown', effect: 'unknown', digest: 'tx' })
  })

  test('recognizes an applied Onara failure report', () => {
    expect(
      extractExecutionResult({
        digest: 'failed-tx',
        outcome: 'applied',
        error: 'Move abort',
        failure: { digest: 'failed-tx' },
      }),
    ).toEqual({ kind: 'failed', effect: 'applied', digest: 'failed-tx', error: 'Move abort' })
  })
})
