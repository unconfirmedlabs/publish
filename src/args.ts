import type { Network } from './config.js'
import { PublishError } from './errors.js'
import type { CliOptions } from './types.js'

export const VERSION = '0.1.0'

export const HELP = `Publish a Sui Move package immutably with an ephemeral signer and Onara-sponsored gas.

Usage:
  publish [PACKAGE_PATH] --network <testnet|mainnet> --onara-url <url> [options]
  publish status <TRANSACTION_DIGEST> --network <testnet|mainnet> --onara-url <url> [options]

The publish operation runs the stock Sui compiler, publishes the resulting modules,
and consumes the returned UpgradeCap with 0x2::package::make_immutable in one atomic
transaction. PACKAGE_PATH defaults to the current directory.

Publish options:
  --network <network>   Required. Either testnet or mainnet.
  --dry-run             Build, sign, simulate for gas resolution, and validate with Onara;
                        do not submit the transaction.
  --yes                 Required for a mainnet submission. Never prompts.
  --sui <path>          Sui CLI executable (default: sui).
  --no-write-published  Do not update Published.toml after a successful publish.

Connection options:
  --rpc-url <url>       Override the selected network's Sui gRPC endpoint.
  --onara-url <url>     Required. Onara sponsorship service endpoint.
  --timeout-ms <ms>     Per-request client timeout (default: 70000).

Output options:
  --json                Emit one JSON document on stdout; structured errors go to stderr.
  --quiet               Suppress progress diagnostics on stderr.
  --help                Show this help without network access.
  --version             Show the version without network access.

Exit status:
  0  Success, including a successful dry run or status lookup.
  1  Operational failure with a known applied/not-applied outcome.
  2  Invalid usage or missing mainnet confirmation.
  3  Mutation outcome is unknown; reconcile with "publish status" before retrying.
`

type ParsedFlags = {
  network?: Network
  json: boolean
  quiet: boolean
  dryRun: boolean
  confirm: boolean
  suiBinary: string
  writePublished: boolean
  rpcUrl?: string
  onaraUrl?: string
  timeoutMs: number
  positionals: string[]
}

const VALUE_FLAGS = new Set(['--network', '--sui', '--rpc-url', '--onara-url', '--timeout-ms'])

function usageError(message: string): never {
  throw new PublishError('INVALID_USAGE', message, { exitCode: 2 })
}

function readValue(argv: string[], index: number, inline: string | undefined): [string, number] {
  if (inline !== undefined) {
    if (!inline) usageError(`Missing value for ${argv[index]?.split('=')[0]}.`)
    return [inline, index]
  }
  const value = argv[index + 1]
  if (value === undefined) usageError(`Missing value for ${argv[index]}.`)
  return [value, index + 1]
}

function parseFlags(argv: string[]): ParsedFlags {
  const parsed: ParsedFlags = {
    json: false,
    quiet: false,
    dryRun: false,
    confirm: false,
    suiBinary: 'sui',
    writePublished: true,
    timeoutMs: 70_000,
    positionals: [],
  }
  let operandsOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (operandsOnly) {
      parsed.positionals.push(token)
      continue
    }
    if (token === '--') {
      operandsOnly = true
      continue
    }
    if (!token.startsWith('--')) {
      parsed.positionals.push(token)
      continue
    }

    const equals = token.indexOf('=')
    const name = equals === -1 ? token : token.slice(0, equals)
    const inline = equals === -1 ? undefined : token.slice(equals + 1)
    if (inline !== undefined && !VALUE_FLAGS.has(name)) {
      usageError(`${name} does not take a value.`)
    }

    if (name === '--json') parsed.json = true
    else if (name === '--quiet') parsed.quiet = true
    else if (name === '--dry-run') parsed.dryRun = true
    else if (name === '--yes') parsed.confirm = true
    else if (name === '--no-write-published') parsed.writePublished = false
    else if (name === '--help' || name === '--version') {
      usageError(`${name} must be handled before argument parsing.`)
    } else if (VALUE_FLAGS.has(name)) {
      const [value, valueIndex] = readValue(argv, index, inline)
      index = valueIndex
      if (name === '--network') {
        if (value !== 'mainnet' && value !== 'testnet') {
          usageError('--network must be either "testnet" or "mainnet".')
        }
        parsed.network = value
      } else if (name === '--sui') parsed.suiBinary = value
      else if (name === '--rpc-url') parsed.rpcUrl = validateUrl(name, value)
      else if (name === '--onara-url') parsed.onaraUrl = validateUrl(name, value)
      else {
        const timeout = Number(value)
        if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
          usageError('--timeout-ms must be an integer from 1000 through 300000.')
        }
        parsed.timeoutMs = timeout
      }
    } else {
      usageError(`Unknown option: ${name}`)
    }
  }

  return parsed
}

function validateUrl(flag: string, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    usageError(`${flag} must be an absolute HTTP or HTTPS URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    usageError(`${flag} must use http or https.`)
  }
  return url.toString().replace(/\/$/, '')
}

export function parseArgs(argv: string[]): CliOptions {
  const flags = parseFlags(argv)
  if (!flags.network) usageError('--network is required.')
  if (!flags.onaraUrl) usageError('--onara-url is required.')

  if (flags.positionals[0] === 'status') {
    if (flags.dryRun || flags.confirm || flags.suiBinary !== 'sui' || !flags.writePublished || flags.rpcUrl) {
      usageError('--dry-run, --yes, --sui, --no-write-published, and --rpc-url apply only to publishing.')
    }
    if (flags.positionals.length !== 2) {
      usageError('status requires exactly one transaction digest.')
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(flags.positionals[1]!)) {
      usageError('status requires a base58 Sui transaction digest.')
    }
    return {
      operation: 'status',
      network: flags.network,
      digest: flags.positionals[1]!,
      json: flags.json,
      quiet: flags.quiet,
      timeoutMs: flags.timeoutMs,
      onaraUrl: flags.onaraUrl,
    }
  }

  if (flags.positionals.length > 1) usageError('Publish accepts at most one package path.')
  if (flags.dryRun && flags.confirm) usageError('--yes is not used with --dry-run.')

  return {
    operation: 'publish',
    network: flags.network,
    packagePath: flags.positionals[0] ?? '.',
    dryRun: flags.dryRun,
    confirm: flags.confirm,
    suiBinary: flags.suiBinary,
    writePublished: flags.writePublished,
    json: flags.json,
    quiet: flags.quiet,
    timeoutMs: flags.timeoutMs,
    ...(flags.rpcUrl ? { rpcUrl: flags.rpcUrl } : {}),
    onaraUrl: flags.onaraUrl,
  }
}
