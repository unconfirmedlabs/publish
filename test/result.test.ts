import { describe, expect, test } from 'bun:test'
import { extractExecutionResult } from '../src/result.js'

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
      digest: 'tx',
      packageId: `0x${'0'.repeat(61)}123`,
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
    ).toEqual({ kind: 'failed', digest: 'failed-tx', error: 'Move abort' })
  })

  test('does not invent status for unknown responses', () => {
    expect(extractExecutionResult({ ok: true })).toEqual({ kind: 'unknown' })
  })
})
