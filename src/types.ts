import type { Network } from './config.js'
import type { MutationEffect } from './errors.js'

export type PublishConnectionOptions = {
  network: Network
  rpcUrl?: string
  onaraUrl: string
  timeoutMs: number
}

export type PublishOptions = PublishConnectionOptions & {
  dryRun: boolean
}

export type StatusOptions = PublishConnectionOptions & {
  digest: string
}

export type MoveBuildArtifact = {
  modules: string[]
  dependencies: string[]
  digest: number[]
}

export type PublishPackageOptions = PublishOptions & {
  packagePath: string
  artifact: MoveBuildArtifact
  suiCliVersion: string
  signal?: AbortSignal
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
}
