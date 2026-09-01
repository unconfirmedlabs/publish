import { describe, expect, test } from 'bun:test'
import { updatePublishedText } from '../src/published-file.js'

const options = {
  network: 'testnet' as const,
  chainId: 'test-chain',
  packageId: '0xabc',
  suiCliVersion: 'sui 1.78.1-deadbeef',
  edition: '2024',
}

describe('updatePublishedText', () => {
  test('creates a canonical immutable publication record', () => {
    const value = updatePublishedText('', options)
    expect(value).toContain('[published.testnet]')
    expect(value).toContain('published-at = "0xabc"')
    expect(value).toContain('original-id = "0xabc"')
    expect(value).toContain('toolchain-version = "1.78.1"')
    expect(value).not.toContain('upgrade-capability')
    expect(value.endsWith('\n')).toBe(true)
    expect(value.endsWith('\n\n')).toBe(false)
  })

  test('replaces one network while preserving comments and the other network', () => {
    const existing = `# keep me
[published.mainnet]
chain-id = "main"
published-at = "0x1"
original-id = "0x1"
version = 1

[published.testnet]
chain-id = "old"
published-at = "0x2"
original-id = "0x2"
version = 1
upgrade-capability = "0x3"
`
    const value = updatePublishedText(existing, options)
    expect(value).toContain('# keep me')
    expect(value).toContain('[published.mainnet]')
    expect(value).toContain('chain-id = "main"')
    expect(value).toContain('chain-id = "test-chain"')
    expect(value).not.toContain('upgrade-capability')
    expect(value.match(/\[published\.testnet\]/g)).toHaveLength(1)
    expect(value.endsWith('\n')).toBe(true)
    expect(value.endsWith('\n\n')).toBe(false)
  })
})
