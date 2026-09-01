import { describe, expect, test } from 'bun:test'
import { parseArgs } from '../src/args.js'
import { PublishError } from '../src/errors.js'

describe('parseArgs', () => {
  test('parses the minimal testnet publish contract', () => {
    expect(parseArgs(['.', '--network', 'testnet'])).toEqual({
      operation: 'publish',
      packagePath: '.',
      network: 'testnet',
      dryRun: false,
      confirm: false,
      suiBinary: 'sui',
      writePublished: true,
      json: false,
      quiet: false,
      timeoutMs: 70_000,
    })
  })

  test('accepts machine and endpoint options in any order', () => {
    expect(
      parseArgs([
        '--json',
        '--network=mainnet',
        '--dry-run',
        '--rpc-url',
        'https://rpc.example',
        '--onara-url=http://onara.internal/',
        '--no-write-published',
        '/move/pkg',
      ]),
    ).toMatchObject({
      operation: 'publish',
      packagePath: '/move/pkg',
      network: 'mainnet',
      dryRun: true,
      writePublished: false,
      json: true,
      rpcUrl: 'https://rpc.example',
      onaraUrl: 'http://onara.internal',
    })
  })

  test('parses status as a bounded read operation', () => {
    const digest = '4'.repeat(44)
    expect(parseArgs(['status', digest, '--network', 'testnet', '--json'])).toEqual({
      operation: 'status',
      digest,
      network: 'testnet',
      json: true,
      quiet: false,
      timeoutMs: 70_000,
    })
  })

  test.each([
    [[], '--network is required.'],
    [['--network', 'devnet'], '--network must be either'],
    [['.', 'other', '--network', 'testnet'], 'at most one package path'],
    [['--network', 'testnet', '--dry-run', '--yes'], '--yes is not used'],
    [['status', 'x', '--network', 'testnet', '--rpc-url', 'https://rpc.example'], 'apply only'],
    [['status', 'not-a-digest', '--network', 'testnet'], 'base58 Sui transaction digest'],
    [['--network', 'testnet', '--wat'], 'Unknown option'],
    [['--network', 'testnet', '--yes=false'], 'does not take a value'],
  ])('rejects invalid invocation %#', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message)
    try {
      parseArgs(argv)
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError)
      expect((error as PublishError).exitCode).toBe(2)
    }
  })

})
