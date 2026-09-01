import { describe, expect, test } from 'bun:test'
import { PublishError } from '../src/errors.js'
import { parseBuildOutput, sanitizeDiagnostic } from '../src/move-build.js'

describe('parseBuildOutput', () => {
  test('extracts the final Sui JSON artifact after compiler progress', () => {
    const artifact = parseBuildOutput(
      'INCLUDING DEPENDENCY Sui\nBUILDING pkg\n' +
        JSON.stringify({
          modules: ['AQID'],
          dependencies: ['0x1', '0x2'],
          digest: Array.from({ length: 32 }, (_, index) => index),
        }),
    )
    expect(artifact.modules).toEqual(['AQID'])
    expect(artifact.dependencies).toEqual(['0x1', '0x2'])
    expect(artifact.digest).toHaveLength(32)
  })

  test('rejects malformed or empty module output', () => {
    expect(() =>
      parseBuildOutput(JSON.stringify({ modules: [], dependencies: [], digest: Array(32).fill(0) })),
    ).toThrow(PublishError)
  })
})

test('sanitizeDiagnostic removes terminal control sequences', () => {
  expect(sanitizeDiagnostic('\u001b[31merror\u001b[0m\u0000')).toBe('error?')
})
