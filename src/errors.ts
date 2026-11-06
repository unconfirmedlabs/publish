export type MutationEffect = 'not_applied' | 'applied' | 'unknown'

export type PublishErrorObject = {
  objectId?: string
  type: string
  owner: string
}

export class PublishError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly effect: MutationEffect
  readonly details: string | undefined
  readonly digest: string | undefined
  readonly recoveryKeyFile: string | undefined
  readonly objects: PublishErrorObject[] | undefined

  constructor(
    code: string,
    message: string,
    options: {
      exitCode?: number
      effect?: MutationEffect
      details?: string
      digest?: string
      recoveryKeyFile?: string
      objects?: PublishErrorObject[]
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'PublishError'
    this.code = code
    this.exitCode = options.exitCode ?? 1
    this.effect = options.effect ?? 'not_applied'
    this.details = options.details
    this.digest = options.digest
    this.recoveryKeyFile = options.recoveryKeyFile
    this.objects = options.objects
  }
}

export function errorFromUnknown(error: unknown): PublishError {
  if (error instanceof PublishError) return error
  return new PublishError(
    'UNEXPECTED_ERROR',
    error instanceof Error ? error.message : 'Unexpected error.',
    { effect: 'not_applied', cause: error },
  )
}
