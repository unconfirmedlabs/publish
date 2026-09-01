import type { Network } from './config.js'
import type { MutationEffect } from './errors.js'

export type CommonOptions = {
  network: Network
  json: boolean
  quiet: boolean
  rpcUrl?: string
  onaraUrl?: string
  timeoutMs: number
}

export type PublishOptions = CommonOptions & {
  operation: 'publish'
  packagePath: string
  dryRun: boolean
  confirm: boolean
  suiBinary: string
  writePublished: boolean
}

export type StatusOptions = CommonOptions & {
  operation: 'status'
  digest: string
}

export type CliOptions = PublishOptions | StatusOptions

export type MoveBuildArtifact = {
  modules: string[]
  dependencies: string[]
  digest: number[]
}

export type PublishReceipt = {
  schemaVersion: 1
  operation: 'publish'
  outcome: 'validated' | 'published'
  effect: MutationEffect
  network: Network
  packagePath: string
  packageDigest: string
  moduleCount: number
  dependencyCount: number
  sender: string
  sponsor: string
  immutable: true
  onaraUrl: string
  rpcUrl: string
  suiCliVersion: string
  policy?: string
  transactionDigest?: string
  packageId?: string
  publishedFile?: string
  publishedFileUpdated?: boolean
  warnings?: string[]
}

export type StatusReceipt = {
  schemaVersion: 1
  operation: 'status'
  network: Network
  digest: string
  found: boolean
  outcome: 'not_found' | 'success' | 'failed' | 'unknown'
  packageId?: string
  immutable?: boolean
  onaraUrl: string
  response?: unknown
}
