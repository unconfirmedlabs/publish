import { describe, expect, test } from 'bun:test'

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const process = Bun.spawn(['node', 'dist/cli.js', ...args], {
    cwd: import.meta.dir.replace(/\/test$/, ''),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe('built CLI non-TTY contract', () => {
  test('keeps stdout empty and emits structured usage errors on stderr', async () => {
    const result = await runCli(['--json'])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toEqual({
      type: 'error',
      error: {
        code: 'INVALID_USAGE',
        message: '--network is required.',
        effect: 'not_applied',
      },
    })
  })

  test('rejects unconfirmed mainnet mutation locally without progress or network access', async () => {
    const result = await runCli([
      '--network',
      'mainnet',
      '--onara-url',
      'https://onara.invalid',
      '--json',
      '--quiet',
    ])
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({
      type: 'error',
      error: {
        code: 'CONFIRMATION_REQUIRED',
        effect: 'not_applied',
      },
    })
  })

  test('serves help locally through a pipe', async () => {
    const result = await runCli(['--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toStartWith('Publish a Sui Move package immutably')
  })
})
