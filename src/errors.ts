export type MutationEffect = 'not_applied' | 'applied' | 'unknown'

export class PublishError extends Error {
  readonly code: string
  readonly exitCode: number
  readonly effect: MutationEffect
  readonly details: string | undefined
  readonly digest: string | undefined

  constructor(
    code: string,
    message: string,
    options: {
      exitCode?: number
      effect?: MutationEffect
      details?: string
      digest?: string
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
