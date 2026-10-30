import { describe, expect, test } from 'bun:test'
import { OnaraHttpClient, OnaraHttpError } from '../src/onara-client.js'
import { sponsorshipError } from '../src/workflow.js'

describe('OnaraHttpClient', () => {
  test('sends the signed transaction with explicit dry-run semantics', async () => {
    let request: { url: string; init: Parameters<typeof fetch>[1] } | undefined
    const client = new OnaraHttpClient({
      url: 'http://onara.test',
      fetch: (async (url, init) => {
        request = { url: String(url), init }
        return Response.json({ digest: 'tx', dryRun: true })
      }) as typeof fetch,
    })

    await client.sponsor({
      sender: '0x1',
      txBytes: 'bytes',
      txSignature: 'signature',
      dryRun: true,
      waitForExecution: true,
    })

    expect(request?.url).toBe('http://onara.test/sponsor?dryRun=true')
    expect(request?.init?.method).toBe('POST')
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      sender: '0x1',
      txBytes: 'bytes',
      txSignature: 'signature',
    })
  })

  test('preserves typed Onara denial details', async () => {
    const client = new OnaraHttpClient({
      url: 'http://onara.test',
      fetch: (async () =>
        Response.json(
          { error: 'Policy denied transaction', digest: 'digest', status: 'unconfirmed' },
          { status: 403 },
        )) as unknown as typeof fetch,
    })

    try {
      await client.transactionStatus('digest')
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(OnaraHttpError)
      expect(error).toMatchObject({
        status: 403,
        digest: 'digest',
        txStatus: 'unconfirmed',
      })
    }
  })

  test('rejects oversized responses before reading the body', async () => {
    const client = new OnaraHttpClient({
      url: 'http://onara.test',
      fetch: (async () =>
        new Response('{}', {
          headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
        })) as unknown as typeof fetch,
    })

    expect(client.status()).rejects.toThrow('exceeded the 8 MiB limit')
  })

  test('marks an applied onchain failure', async () => {
    const client = new OnaraHttpClient({
      url: 'http://onara.test',
      fetch: (async () =>
        Response.json(
          { error: 'Move abort', digest: 'digest', outcome: 'applied', failure: {} },
          { status: 502 },
        )) as unknown as typeof fetch,
    })

    try {
      await client.sponsor({
        sender: '0x1',
        txBytes: 'bytes',
        txSignature: 'signature',
        dryRun: false,
        waitForExecution: true,
      })
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(OnaraHttpError)
      expect(error).toMatchObject({ status: 502, digest: 'digest', txStatus: 'applied' })
    }
  })

  test('reports an applied onchain failure as a known failure', () => {
    const error = sponsorshipError(
      new OnaraHttpError('Move abort', 502, { digest: 'digest', txStatus: 'applied' }),
      'digest',
    )
    expect(error).toMatchObject({ code: 'TRANSACTION_FAILED', effect: 'applied', exitCode: 1, digest: 'digest' })
  })
})
