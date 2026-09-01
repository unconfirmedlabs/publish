# publish

Publish an immutable Sui Move package with a fresh in-memory signer and
[Onara](https://github.com/unconfirmedlabs/onara)-sponsored gas.

```sh
publish . --network testnet --dry-run
publish . --network testnet

publish . --network mainnet --dry-run
publish . --network mainnet --yes
```

Every successful publish is one atomic programmable transaction:

```text
Publish(modules, dependencies) -> UpgradeCap
0x2::package::make_immutable(UpgradeCap)
```

If either command fails, neither takes effect. The Ed25519 key is generated only
after compilation, kept in process memory, used to sign that transaction, and
never printed or written to disk. Onara pays gas from its address balance.

## Why the CLI builds the package

The package directory—not prebuilt bytecode—is the primary input. `publish`
invokes the installed stock Sui CLI as an argv-safe child process:

```sh
sui move build \
  --path <PACKAGE_PATH> \
  --dump-bytecode-as-base64 \
  --build-env <NETWORK>
```

This is preferable to accepting an arbitrary bytecode file by default:

- the bytecode and transitive dependency IDs come from the same build;
- the chosen network is used for both compilation and submission;
- already-published root packages are rebuilt at `0x0`, so republishing does not
  require deleting or editing `Published.toml` first;
- compiler failures stop before a key is generated or Onara is contacted; and
- the exact Sui CLI version and package digest are recorded in the result.

The CLI creates a temporary, empty Sui client configuration pointed at the
selected RPC. It never uses an ambient Sui address or keystore. The compiler
still uses the package's normal `Move.lock`, dependency cache, and `build/`
directory.

After a successful transaction, the selected network section in
`Published.toml` is updated atomically. Other networks and surrounding comments
are preserved. The new record intentionally has no `upgrade-capability` field.
Use `--no-write-published` for a read-only checkout.

## Install

Requirements:

- Node.js 22 or newer (Bun also works);
- the `sui` CLI on `PATH`; and
- network access to the chosen Sui RPC and Onara endpoint.

From a checkout:

```sh
bun install --frozen-lockfile
bun run build
bun link
```

The package name is `@unconfirmed/publish` and the installed executable is
`publish`.

## Networks

`--network` is always required. There is no ambient default.

| Network | Sui gRPC | Onara |
| --- | --- | --- |
| testnet | `https://fullnode.testnet.sui.io:443` | `http://onara-testnet.flycast` |
| mainnet | `https://fullnode.mainnet.sui.io:443` | `http://onara-mainnet.flycast` |

The CLI verifies both endpoints' immutable chain identifiers before generating
the signer. Override private or mirrored infrastructure explicitly with
`--rpc-url` and `--onara-url`; the network identity checks still apply.

The resolved Onara and RPC URLs are included in every JSON publish receipt.

Mainnet execution requires `--yes` and never opens a prompt. A mainnet dry run
does not require `--yes`.

The client uses Onara's versioned HTTP surface directly (`/status`, `/sponsor`,
and `/sponsor/:digest/status`), so it runs consistently under both Node and Bun.

## Dry runs

```sh
publish ./move/my-package --network testnet --dry-run --json
```

A dry run compiles the package, constructs the full transaction, lets the Sui
SDK simulate it while resolving the gas budget, signs it with a new ephemeral
key, and asks Onara to validate its sponsorship policy. Onara does not submit or
sponsor-sign it. The receipt reports `effect: "not_applied"`.

Each invocation deliberately gets a new sender. A later executable invocation
therefore has different transaction bytes, while retaining the same modules,
dependencies, package digest, and command shape.

## Machine contract

Use `--json` for one JSON result document on stdout. Progress is JSONL on stderr
and can be disabled with `--quiet`. Before a result is available, stdout stays
empty on failure.

```sh
publish . --network testnet --dry-run --json --quiet
```

```json
{
  "schemaVersion": 1,
  "operation": "publish",
  "outcome": "validated",
  "effect": "not_applied",
  "network": "testnet",
  "packagePath": "/absolute/path/to/package",
  "packageDigest": "0x...",
  "moduleCount": 1,
  "dependencyCount": 2,
  "sender": "0x...",
  "sponsor": "0x...",
  "immutable": true,
  "onaraUrl": "http://onara-testnet.flycast",
  "rpcUrl": "https://fullnode.testnet.sui.io:443",
  "suiCliVersion": "sui 1.78.1-...",
  "policy": "allow-all"
}
```

An executed receipt additionally includes `transactionDigest`, `packageId`, and
the `Published.toml` update state. Field names and enum values are part of the
CLI's public protocol; additive fields may be introduced in schema version 1.

Errors are structured on stderr:

```json
{
  "type": "error",
  "error": {
    "code": "SPONSORSHIP_DENIED",
    "message": "Transaction is not eligible for sponsorship.",
    "effect": "not_applied"
  }
}
```

Exit statuses are typed:

| Status | Meaning |
| --- | --- |
| `0` | Publish, dry run, or status read succeeded. |
| `1` | Operational failure with a known applied/not-applied outcome. |
| `2` | Invalid usage or missing mainnet confirmation. |
| `3` | Submission outcome is unknown; reconcile before retrying. |

The CLI does not retry the publish request. A timeout or lost response can hide
a committed transaction, and retrying with a fresh key would create another
package. The locally derived transaction digest is returned whenever possible.

```sh
publish status <TRANSACTION_DIGEST> --network testnet --json
```

## Important package constraints

Immutability is permanent. A successful package cannot be upgraded, rolled back,
or repaired through an upgrade.

The transaction sender is a disposable address. If a package `init` function
creates an admin capability or any other address-owned object for
`tx_context::sender`, that object will be owned by the ephemeral address and
become inaccessible after the process exits. Use this tool only for packages
whose initialization leaves no authority or assets that must remain controlled.

`Published.toml` is local deployment metadata, not proof that the transaction
succeeded. The onchain transaction digest and package ID in the success receipt
are authoritative.

## Full help

```text
publish --help
```

Help, version, and argument errors are local and do not initialize the SDK,
inspect credentials, or contact a network.

## License

MIT
