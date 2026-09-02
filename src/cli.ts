#!/usr/bin/env node

import { HELP, VERSION, parseArgs } from './args.js'
import { errorFromUnknown, type PublishError } from './errors.js'
import type { PublishBatchReceipt, PublishReceipt, StatusReceipt } from './types.js'
import type { CliOptions } from './cli-types.js'

function write(stream: NodeJS.WriteStream, value: string): void {
  stream.write(value.endsWith('\n') ? value : `${value}\n`)
}

function progress(json: boolean, quiet: boolean, event: string, message: string, data?: unknown): void {
  if (quiet) return
  if (json) {
    write(process.stderr, JSON.stringify({ type: 'progress', event, message, ...(data === undefined ? {} : { data }) }))
  } else write(process.stderr, message)
}

function renderReceipt(receipt: PublishBatchReceipt | PublishReceipt | StatusReceipt, json: boolean): void {
  if (json) {
    write(process.stdout, JSON.stringify(receipt))
    return
  }

  if (receipt.operation === 'status') {
    if (!receipt.found) {
      write(process.stdout, `Transaction not found: ${receipt.digest}`)
      return
    }
    write(process.stdout, `Transaction: ${receipt.digest}`)
    write(process.stdout, `Outcome: ${receipt.outcome}`)
    if (receipt.packageId) write(process.stdout, `Package: ${receipt.packageId}`)
    return
  }

  if (receipt.operation === 'publish-batch') {
    const verb = receipt.outcome === 'validated' ? 'Validated' : 'Published'
    write(process.stdout, `${verb} ${receipt.packages.length} immutable packages on ${receipt.network}.`)
    if (receipt.transactionDigest) write(process.stdout, `Transaction: ${receipt.transactionDigest}`)
    for (const pkg of receipt.packages) {
      write(process.stdout, `${pkg.packagePath}: ${pkg.packageId ?? pkg.packageDigest}`)
      if (pkg.publishedFileUpdated && pkg.publishedFile) write(process.stdout, `Updated: ${pkg.publishedFile}`)
      for (const warning of pkg.warnings ?? []) write(process.stderr, `warning: ${warning}`)
    }
    for (const warning of receipt.warnings ?? []) write(process.stderr, `warning: ${warning}`)
    return
  }

  if (receipt.outcome === 'validated') {
    write(process.stdout, `Validated immutable publish on ${receipt.network}.`)
    write(process.stdout, `Package digest: ${receipt.packageDigest}`)
    write(process.stdout, `Ephemeral sender: ${receipt.sender}`)
    if (receipt.policy) write(process.stdout, `Onara policy: ${receipt.policy}`)
    return
  }

  write(process.stdout, `Published immutable package on ${receipt.network}.`)
  if (receipt.packageId) write(process.stdout, `Package: ${receipt.packageId}`)
  write(process.stdout, `Transaction: ${receipt.transactionDigest}`)
  write(process.stdout, `Package digest: ${receipt.packageDigest}`)
  if (receipt.publishedFileUpdated && receipt.publishedFile) {
    write(process.stdout, `Updated: ${receipt.publishedFile}`)
  }
  for (const warning of receipt.warnings ?? []) write(process.stderr, `warning: ${warning}`)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function recoveryCommand(error: PublishError, options: CliOptions | undefined): string | undefined {
  if (error.effect !== 'unknown' || !error.digest || !options) return undefined
  return `publish status ${error.digest} --network ${options.network} --onara-url ${shellQuote(options.onaraUrl)} --json`
}

function renderError(error: PublishError, json: boolean, recovery?: string): void {
  if (json) {
    write(
      process.stderr,
      JSON.stringify({
        type: 'error',
        error: {
          code: error.code,
          message: error.message,
          effect: error.effect,
          ...(error.digest ? { digest: error.digest } : {}),
          ...(recovery ? { recovery } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      }),
    )
    return
  }
  write(process.stderr, `error[${error.code}]: ${error.message}`)
  write(process.stderr, `effect: ${error.effect}`)
  if (error.digest) write(process.stderr, `transaction: ${error.digest}`)
  if (error.details) write(process.stderr, error.details)
  if (recovery) write(process.stderr, `recovery: ${recovery}`)
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const optionEnd = argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--')
  const optionTokens = argv.slice(0, optionEnd)
  if (optionTokens.includes('--help')) {
    write(process.stdout, HELP)
    return 0
  }
  if (optionTokens.includes('--version')) {
    write(process.stdout, VERSION)
    return 0
  }

  let json = optionTokens.includes('--json')
  let parsedOptions: CliOptions | undefined
  try {
    const options = parseArgs(argv)
    parsedOptions = options
    json = options.json
    const abort = new AbortController()
    const interrupt = () => abort.abort(new Error('Interrupted.'))
    const addSignalListener = process.once.bind(process) as unknown as (
      signal: 'SIGINT' | 'SIGTERM',
      listener: () => void,
    ) => void
    const removeSignalListener = process.removeListener.bind(process) as unknown as (
      signal: 'SIGINT' | 'SIGTERM',
      listener: () => void,
    ) => void
    addSignalListener('SIGINT', interrupt)
    addSignalListener('SIGTERM', interrupt)
    try {
      if (options.operation === 'status') {
        const { transactionStatus } = await import('./workflow.js')
        progress(options.json, options.quiet, 'status', `Checking ${options.digest} on ${options.network}...`)
        renderReceipt(await transactionStatus(options), options.json)
        return 0
      }

      if (options.network === 'mainnet' && !options.dryRun && !options.confirm) {
        const { PublishError } = await import('./errors.js')
        throw new PublishError(
          'CONFIRMATION_REQUIRED',
          'Mainnet publishing is permanent. Re-run with --yes after reviewing a --dry-run.',
          { exitCode: 2 },
        )
      }

      const { publishPackages } = await import('./workflow.js')
      const { buildMovePackage } = await import('./move-build.js')
      const configModule = await import('./config.js')
      const config = configModule.resolveNetworkConfig(options.network, {
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
        onaraUrl: options.onaraUrl,
      })
      const builds = []
      for (const packagePath of options.packagePaths) {
        progress(options.json, options.quiet, 'build', `Building ${packagePath} for ${options.network}...`)
        const build = await buildMovePackage({
          packagePath,
          network: options.network,
          rpcUrl: config.rpcUrl,
          suiBinary: options.suiBinary,
          signal: abort.signal,
        })
        builds.push(build)
        if (build.diagnostics) progress(options.json, options.quiet, 'compiler', build.diagnostics)
      }
      progress(
        options.json,
        options.quiet,
        'sponsor',
        options.dryRun ? 'Validating sponsorship policy...' : 'Submitting sponsored transaction...',
      )
      const receipt = await publishPackages({
        network: options.network,
        ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
        onaraUrl: options.onaraUrl,
        timeoutMs: options.timeoutMs,
        dryRun: options.dryRun,
        packages: builds.map((build) => ({
          packagePath: build.packagePath,
          artifact: build.artifact,
          moduleNames: build.moduleNames,
          suiCliVersion: build.suiCliVersion,
        })),
        signal: abort.signal,
      })
      if (receipt.outcome === 'published') {
        if (options.writePublished) {
          const { updatePublishedFile } = await import('./published-file.js')
          for (const [index, pkg] of receipt.packages.entries()) {
            const build = builds[index]!
            if (!pkg.packageId) {
              pkg.publishedFileUpdated = false
              pkg.warnings = [...(pkg.warnings ?? []), 'Package ID is missing; Published.toml was not updated.']
              continue
            }
          try {
            pkg.publishedFile = await updatePublishedFile({
              packagePath: build.packagePath,
              network: options.network,
              chainId: config.chainId,
              packageId: pkg.packageId,
              suiCliVersion: build.suiCliVersion,
            })
            pkg.publishedFileUpdated = true
          } catch (error) {
            pkg.publishedFileUpdated = false
            pkg.warnings = [
              ...(pkg.warnings ?? []),
              `Package was published, but Published.toml was not updated: ${error instanceof Error ? error.message : 'unknown error'}`,
            ]
          }
          }
        } else {
          for (const pkg of receipt.packages) pkg.publishedFileUpdated = false
        }
      }
      renderReceipt(receipt, options.json)
      return 0
    } finally {
      removeSignalListener('SIGINT', interrupt)
      removeSignalListener('SIGTERM', interrupt)
    }
  } catch (caught) {
    const error = errorFromUnknown(caught)
    renderError(error, json, recoveryCommand(error, parsedOptions))
    return error.exitCode
  }
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

process.exitCode = await main()
