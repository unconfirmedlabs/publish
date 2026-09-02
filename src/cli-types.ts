import type { Network } from './config.js'

type CommonCliOptions = {
  network: Network
  json: boolean
  quiet: boolean
  onaraUrl: string
  timeoutMs: number
}

export type CliPublishOptions = CommonCliOptions & {
  operation: 'publish'
  packagePaths: string[]
  dryRun: boolean
  confirm: boolean
  suiBinary: string
  writePublished: boolean
  rpcUrl?: string
}

export type CliStatusOptions = CommonCliOptions & {
  operation: 'status'
  digest: string
}

export type CliOptions = CliPublishOptions | CliStatusOptions
