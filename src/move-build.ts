import { spawn } from 'node:child_process'
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Network } from './config.js'
import { PublishError } from './errors.js'
import type { MoveBuildArtifact } from './types.js'

const MAX_STDOUT_BYTES = 64 * 1024 * 1024
const MAX_STDERR_BYTES = 4 * 1024 * 1024
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SUI_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/

type ProcessResult = { stdout: string; stderr: string }

async function runProcess(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; maxStdout?: number; maxStderr?: number },
): Promise<ProcessResult> {
  const maxStdout = options.maxStdout ?? MAX_STDOUT_BYTES
  const maxStderr = options.maxStderr ?? MAX_STDERR_BYTES

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: options.signal,
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let overflow: 'stdout' | 'stderr' | undefined

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxStdout) {
        overflow = 'stdout'
        child.kill('SIGTERM')
      } else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > maxStderr) {
        overflow = 'stderr'
        child.kill('SIGTERM')
      } else stderr.push(chunk)
    })

    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(
          new PublishError('SUI_CLI_NOT_FOUND', `Sui CLI executable not found: ${executable}`, {
            details: 'Install Sui with suiup or pass an explicit executable with --sui.',
            cause: error,
          }),
        )
      } else if (error.name === 'AbortError') {
        reject(new PublishError('INTERRUPTED', 'Operation interrupted.', { cause: error }))
      } else {
        reject(new PublishError('SUI_CLI_FAILED', `Unable to start the Sui CLI: ${error.message}`, { cause: error }))
      }
    })

    child.once('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf8')
      const err = Buffer.concat(stderr).toString('utf8')
      if (overflow) {
        reject(
          new PublishError(
            'SUI_OUTPUT_LIMIT',
            `Sui CLI ${overflow} exceeded the supported buffer limit.`,
            { details: sanitizeDiagnostic(err || out) },
          ),
        )
      } else if (code !== 0) {
        reject(
          new PublishError('MOVE_BUILD_FAILED', `Sui CLI exited with status ${code ?? signal ?? 'unknown'}.`, {
            details: sanitizeDiagnostic(err || out),
          }),
        )
      } else resolve({ stdout: out, stderr: err })
    })
  })
}

export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g, '?')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateArtifact(value: unknown): MoveBuildArtifact | undefined {
  if (!isRecord(value)) return undefined
  const { modules, dependencies, digest } = value
  if (
    !Array.isArray(modules) ||
    modules.length === 0 ||
    !modules.every((module) => typeof module === 'string' && module.length > 0 && BASE64.test(module)) ||
    !Array.isArray(dependencies) ||
    !dependencies.every((dependency) => typeof dependency === 'string' && SUI_ADDRESS.test(dependency)) ||
    !Array.isArray(digest) ||
    digest.length !== 32 ||
    !digest.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return undefined
  }
  return {
    modules: modules as string[],
    dependencies: dependencies as string[],
    digest: digest as number[],
  }
}

export function parseBuildOutput(stdout: string): MoveBuildArtifact {
  const lines = stdout.trim().split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim()
    if (!line?.startsWith('{')) continue
    try {
      const artifact = validateArtifact(JSON.parse(line))
      if (artifact) return artifact
    } catch {
      // Keep looking: compiler progress can contain braces.
    }
  }
  throw new PublishError('INVALID_BUILD_OUTPUT', 'Sui CLI did not return a valid bytecode artifact.', {
    details: sanitizeDiagnostic(stdout).slice(-4_000),
  })
}

function temporaryClientConfig(network: Network, rpcUrl: string, keystorePath: string): string {
  return `---
keystore:
  File: ${JSON.stringify(keystorePath)}
external_keys: null
envs:
  - alias: ${network}
    rpc: ${JSON.stringify(rpcUrl)}
    ws: null
    basic_auth: null
active_env: ${network}
active_address: null
`
}

export async function buildMovePackage(options: {
  packagePath: string
  network: Network
  rpcUrl: string
  suiBinary: string
  signal?: AbortSignal
}): Promise<{
  packagePath: string
  artifact: MoveBuildArtifact
  suiCliVersion: string
  diagnostics: string
}> {
  let packagePath: string
  try {
    packagePath = await realpath(options.packagePath)
    await access(join(packagePath, 'Move.toml'))
  } catch (error) {
    throw new PublishError('INVALID_PACKAGE_PATH', 'Package path must be a directory containing Move.toml.', {
      details: options.packagePath,
      cause: error,
    })
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), 'sui-publish-'))
  try {
    const keystorePath = join(tempDirectory, 'sui.keystore')
    const clientConfigPath = join(tempDirectory, 'client.yaml')
    await writeFile(keystorePath, '[]\n', { mode: 0o600 })
    await writeFile(
      clientConfigPath,
      temporaryClientConfig(options.network, options.rpcUrl, keystorePath),
      { mode: 0o600 },
    )

    const version = await runProcess(options.suiBinary, ['--version'], {
      cwd: packagePath,
      ...(options.signal ? { signal: options.signal } : {}),
      maxStdout: 64 * 1024,
      maxStderr: 64 * 1024,
    })
    const suiCliVersion = sanitizeDiagnostic(version.stdout || version.stderr)
    if (!suiCliVersion) {
      throw new PublishError('INVALID_SUI_VERSION', 'Sui CLI returned an empty version string.')
    }

    const result = await runProcess(
      options.suiBinary,
      [
        'move',
        '--client.config',
        clientConfigPath,
        '--client.env',
        options.network,
        '--quiet',
        'build',
        '--path',
        packagePath,
        '--dump-bytecode-as-base64',
        '--build-env',
        options.network,
      ],
      { cwd: packagePath, ...(options.signal ? { signal: options.signal } : {}) },
    )

    return {
      packagePath,
      artifact: parseBuildOutput(result.stdout),
      suiCliVersion,
      diagnostics: sanitizeDiagnostic(result.stderr),
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}
