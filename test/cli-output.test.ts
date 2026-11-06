import { describe, expect, test } from 'bun:test'
import { createdObjectsNotForwardedError, errorDocument } from '../src/cli-output.js'
import { PublishError } from '../src/errors.js'
import type { PublishBatchReceipt } from '../src/types.js'

const objects = [{ objectId: '0xc1', type: '0xcafe::caps::AdminCap', owner: '0xa11ce' }]

describe('CLI error documents', () => {
  test('include recovery key files and objects additively', () => {
    const error = new PublishError('EXECUTION_UNCONFIRMED', 'timeout', {
      exitCode: 3,
      effect: 'unknown',
      digest: 'digest',
      recoveryKeyFile: '/work/publish-recovery-0xa11ce.key',
      objects,
    })
    expect(errorDocument(error, 'publish status digest')).toEqual({
      type: 'error',
      error: {
        code: 'EXECUTION_UNCONFIRMED',
        message: 'timeout',
        effect: 'unknown',
        digest: 'digest',
        recovery: 'publish status digest',
        recoveryKeyFile: '/work/publish-recovery-0xa11ce.key',
        objects,
      },
    })
  })

  test('keep the existing shape without the new fields', () => {
    expect(errorDocument(new PublishError('INVALID_USAGE', 'bad', { exitCode: 2 }))).toEqual({
      type: 'error',
      error: { code: 'INVALID_USAGE', message: 'bad', effect: 'not_applied' },
    })
  })

  test('report unforwarded objects as an applied exit-4 error', () => {
    const receipt = { transactionDigest: 'publish-digest' } as PublishBatchReceipt
    const error = createdObjectsNotForwardedError(receipt, {
      recipient: '0xbeef',
      forwarded: false,
      objects,
      transactionDigest: 'forward-digest',
      recoveryKeyFile: '/work/publish-recovery-0xa11ce.key',
      error: 'Forwarding transaction was not confirmed: denied',
    })
    expect(error).toMatchObject({
      code: 'CREATED_OBJECTS_NOT_FORWARDED',
      exitCode: 4,
      effect: 'applied',
      digest: 'publish-digest',
      recoveryKeyFile: '/work/publish-recovery-0xa11ce.key',
      objects,
    })
    expect(error.message).toBe('Published, but 1 created object was not forwarded to 0xbeef.')
    expect(error.details).toContain('/work/publish-recovery-0xa11ce.key')
    expect(error.details).toContain('0xc1 0xcafe::caps::AdminCap')
    expect(error.details).toContain('forward-digest')
    expect(error.details).toContain('Recovering created objects')
  })
})
