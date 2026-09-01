export type OnaraStatus = {
  network: string
  chainId: string
  address: string
  balances: { active: string; pending: string }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export class OnaraHttpError extends Error {
  readonly status: number
  readonly digest: string | undefined
  readonly txStatus: 'unconfirmed' | 'unknown' | undefined

  constructor(
    message: string,
    status: number,
    options: { digest?: string; txStatus?: 'unconfirmed' | 'unknown' } = {},
  ) {
    super(message)
    this.name = 'OnaraHttpError'
    this.status = status
    this.digest = options.digest
    this.txStatus = options.txStatus
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function responseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new OnaraHttpError('Onara response exceeded the 8 MiB limit.', response.status)
  }

  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new OnaraHttpError('Onara response exceeded the 8 MiB limit.', response.status)
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = record(JSON.parse(new TextDecoder().decode(await responseBytes(response))))
    if (body) return body
  } catch (error) {
    if (error instanceof OnaraHttpError) throw error
    // Report a stable protocol error below.
  }
  throw new OnaraHttpError('Onara returned an invalid JSON response.', response.status)
}

function errorFromResponse(response: Response, body: Record<string, unknown>): OnaraHttpError {
  const status = body.status === 'unconfirmed' || body.status === 'unknown' ? body.status : undefined
  return new OnaraHttpError(
    typeof body.error === 'string' ? body.error : `Onara request failed with HTTP ${response.status}.`,
    response.status,
    {
      ...(typeof body.digest === 'string' ? { digest: body.digest } : {}),
      ...(status ? { txStatus: status } : {}),
    },
  )
}

export class OnaraHttpClient {
  readonly baseUrl: string
  readonly fetch: typeof globalThis.fetch

  constructor(options: { url: string; fetch: typeof globalThis.fetch }) {
    this.baseUrl = options.url.replace(/\/+$/, '')
    this.fetch = options.fetch
  }

  async status(): Promise<OnaraStatus> {
    const response = await this.fetch(`${this.baseUrl}/status`)
    const body = await responseJson(response)
    if (!response.ok) throw errorFromResponse(response, body)
    if (
      typeof body.network !== 'string' ||
      typeof body.chainId !== 'string' ||
      typeof body.address !== 'string' ||
      !record(body.balances) ||
      typeof record(body.balances)!.active !== 'string' ||
      typeof record(body.balances)!.pending !== 'string'
    ) {
      throw new OnaraHttpError('Onara returned an invalid status response.', response.status)
    }
    return body as OnaraStatus
  }

  async sponsor(options: {
    sender: string
    txBytes: string
    txSignature: string
    dryRun: boolean
    waitForExecution: boolean
  }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams()
    if (options.dryRun) query.set('dryRun', 'true')
    if (!options.waitForExecution) query.set('waitForExecution', 'false')
    const suffix = query.size ? `?${query}` : ''
    const response = await this.fetch(`${this.baseUrl}/sponsor${suffix}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: options.sender,
        txBytes: options.txBytes,
        txSignature: options.txSignature,
      }),
    })
    const body = await responseJson(response)
    if (!response.ok) throw errorFromResponse(response, body)
    return body
  }

  async transactionStatus(digest: string): Promise<Record<string, unknown>> {
    const response = await this.fetch(
      `${this.baseUrl}/sponsor/${encodeURIComponent(digest)}/status`,
    )
    const body = await responseJson(response)
    if (!response.ok && response.status !== 404) throw errorFromResponse(response, body)
    return body
  }
}
