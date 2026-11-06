# publish

An SDK for composing immutable Sui Move package publishes, plus a thin CLI that
publishes one through five packages atomically with a fresh in-memory signer and
[Onara](https://github.com/unconfirmedlabs/onara)-sponsored gas.

```sh
publish . --network testnet --onara-url <URL> --dry-run
publish . --network testnet --onara-url <URL>
publish package-a package-b --network testnet --onara-url <URL>
publish . --network testnet --onara-url <URL> --created-objects-recipient <ADDRESS>

publish . --network mainnet --onara-url <URL> --dry-run
publish . --network mainnet --onara-url <URL> --yes
```

Every successful publish is one atomic programmable transaction:

```text
Publish(modules, dependencies) -> UpgradeCap
0x2::package::make_immutable(UpgradeCap)
```

If either command fails, neither takes effect. The Ed25519 key is generated only
after compilation, kept in process memory, used to sign that transaction, and
never printed or returned. It is written to disk only in one case: when created
objects are forwarded with `--created-objects-recipient`, it is saved to a
0600 recovery file before submission and deleted again once forwarding succeeds
or the publish is known not to have applied (see
[Recovering created objects](#recovering-created-objects)). Onara pays gas from
its address balance.

## SDK

`@unconfirmed/publish` exposes transaction composition separately from build,
signing, gas selection, execution, and deployment metadata:

```ts
import { Transaction } from '@mysten/sui/transactions'
import { addImmutablePublish } from '@unconfirmed/publish'

const transaction = new Transaction()
addImmutablePublish(transaction, artifact)

// The caller chooses the sender, gas strategy, signer, and executor.
```

For independent package batches, `createImmutablePublishTransaction(artifacts)`
creates the complete PTB. It accepts one through five artifacts, matching Sui's
publish-command limit, and adds one `make_immutable` call immediately after each
publish. Neither transaction helper sets sender or gas data.

The root export also provides:

- `buildMovePackage` and `parseBuildOutput` for argv-safe stock Sui builds;
- `OnaraHttpClient` and `createBoundedFetch` for sponsored execution;
- `extractExecutionResult` and `extractPublishedPackageIds` for execution-effect
  normalization, including all package IDs from a batch;
- `transactionStatus` and `sponsorshipError` for digest-based reconciliation;
- `updatePublishedFile` and `updatePublishedText` for explicit, atomic deployment
  metadata updates;
- `publishPackages` as the one-to-five-package ephemeral-signer batch workflow
  used by the CLI (with `createdObjectsRecipient`, `allowLostCreatedObjects`,
  and `recoveryKeyDirectory` options), `publishPackagesWithClients` for the same
  workflow with an injected Sui client and Onara sponsor, plus `publishPackage`
  for compatibility with one-package SDK callers; and
- `selectCreatedOwnedObjects`, `checkStoreAbilities`, and `readModuleDatatypes`
  for finding created address-owned objects in effects and checking whether
  their declared types have `store`.

The core publishing options contain network and execution inputs only. CLI
presentation, confirmation, and metadata-write switches are intentionally not
part of the SDK contract. `Published.toml` is never changed by transaction
composition or effect parsing; callers invoke the metadata helper explicitly
after an applied publish.

Mutation receipts and errors use `effect: "applied" | "not_applied" |
"unknown"`. An unknown outcome carries the locally derived digest whenever one
is available and must be reconciled before retrying.

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

After a successful transaction, the selected network section in each package's
`Published.toml` is updated atomically. Other networks and surrounding comments
are preserved. New records intentionally have no `upgrade-capability` field.
Use `--no-write-published` for read-only checkouts.

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

`--network` and `--onara-url` are always required. There are no ambient
defaults for either one; callers bring their own Onara deployment.

| Network | Default Sui gRPC |
| --- | --- |
| testnet | `https://fullnode.testnet.sui.io:443` |
| mainnet | `https://fullnode.mainnet.sui.io:443` |

The CLI verifies both endpoints' immutable chain identifiers before generating
the signer. Override private or mirrored Sui infrastructure explicitly with
`--rpc-url`; the network identity checks still apply.

The resolved Onara and RPC URLs are included in every JSON publish receipt.

Mainnet execution requires `--yes` and never opens a prompt. A mainnet dry run
does not require `--yes`.

The client uses Onara's versioned HTTP surface directly (`/status`, `/sponsor`,
and `/sponsor/:digest/status`), so it runs consistently under both Node and Bun.

## Dry runs

```sh
publish ./move/my-package --network testnet --onara-url <URL> --dry-run --json
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
publish . --network testnet --onara-url <URL> --dry-run --json --quiet
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
  "onaraUrl": "<URL>",
  "rpcUrl": "https://fullnode.testnet.sui.io:443",
  "suiCliVersion": "sui 1.78.1-...",
  "policy": "allow-all"
}
```

An executed receipt additionally includes `transactionDigest`, `packageId`, and
the `Published.toml` update state. Field names and enum values are part of the
CLI's public protocol; additive fields may be introduced in schema version 1.

When a publish creates address-owned objects for the ephemeral sender, or when
`--created-objects-recipient` is given, the receipt has a `createdObjects`
field:

```json
{
  "createdObjects": {
    "recipient": "0x...",
    "forwarded": true,
    "objects": [
      { "objectId": "0x...", "type": "0x...::admin::AdminCap", "owner": "0x..." }
    ],
    "transactionDigest": "<FORWARDING_DIGEST>"
  }
}
```

- `recipient` is the normalized recipient address, or `null` with
  `--allow-lost-created-objects`.
- `forwarded` is `true` only after the forwarding transaction succeeded.
- `objects[].owner` is the owner the publish assigned (the ephemeral sender).
  Dry runs omit `objectId`, because those IDs belong to a transaction that is
  never submitted.
- `transactionDigest` is the forwarding transaction, when one is known.
- `recoveryKeyFile` and `error` are present when forwarding did not succeed.

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
| `4` | Published, but created objects were not forwarded; a recovery key file was kept. |

The CLI does not retry the publish request. A timeout or lost response can hide
a committed transaction, and retrying with a fresh key would create another
package. The locally derived transaction digest is returned whenever possible.

```sh
publish status <TRANSACTION_DIGEST> --network testnet --onara-url <URL> --json
```

## Important package constraints

Immutability is permanent. A successful package cannot be upgraded, rolled back,
or repaired through an upgrade.

The transaction sender is a disposable address. If a package `init` function
transfers an admin capability or any other address-owned object to
`tx_context::sender`, that object is owned by the ephemeral address. Objects
created by the publish cannot be used later in the same transaction, so they
are moved in a second transaction.

Before contacting Onara, the CLI simulates the publish and lists the created
objects that would be owned by the ephemeral sender:

- If there are none, nothing changes.
- If there are some and no option is given, the publish is refused with
  `CREATED_OBJECTS_RECIPIENT_REQUIRED` (exit `2`), including for dry runs.
- With `--created-objects-recipient <ADDRESS>`, the CLI checks that each
  object's declared type has `store`: from the batch's own bytecode for types it
  defines, or from the Sui RPC for dependency types. A type that lacks `store`
  is refused with `CREATED_OBJECTS_NOT_TRANSFERABLE` (exit `1`); there is no
  override. An object whose type the simulation does not report is refused with
  `CREATED_OBJECTS_TYPE_UNKNOWN` (exit `1`), because the forward must name the
  type. A known type whose `store` ability cannot be checked is allowed, and
  the forwarding transaction itself is the final check. After the publish
  succeeds, the same ephemeral key signs a forwarding transaction with one
  `0x2::transfer::public_transfer<T>` call per object, where `T` is the object's
  full type, also sponsored through Onara. It never touches the gas coin. The
  zero address is rejected.
- With `--allow-lost-created-objects`, the publish goes ahead and the objects
  stay with the discarded key. The receipt lists them, with `recipient: null`.
  It cannot be combined with a recipient.

A dry run reports what would be forwarded and never writes a key file.

`Published.toml` is local deployment metadata, not proof that the transaction
succeeded. The onchain transaction digest and package ID in the success receipt
are authoritative.

## Recovering created objects

With `--created-objects-recipient`, the ephemeral key is written to
`publish-recovery-<SENDER>.key` in the current directory (mode `0600`, never
overwritten) before the publish is submitted. It holds the Bech32
`suiprivkey1...` secret on one line. The file is deleted when forwarding
succeeds, or when the publish is known not to have applied. It is kept when:

- forwarding fails after a successful publish. The CLI still writes
  `Published.toml`, prints the receipt with `createdObjects.forwarded: false`
  and `recoveryKeyFile`, reports `CREATED_OBJECTS_NOT_FORWARDED` on stderr, and
  exits `4`; or
- the publish outcome is unknown (exit `3`). The error carries
  `recoveryKeyFile` and the expected object IDs. Reconcile the publish with
  `publish status` first.

If the receipt or error shows a forwarding `transactionDigest`, first check it:

```sh
publish status <FORWARDING_DIGEST> --network <NETWORK> --onara-url <URL>
```

If the forwarding did not apply, move the objects yourself with the Sui CLI in
an isolated configuration, never your normal keystore. These commands pay gas
from the ephemeral address itself, so send it a little SUI first.

```sh
export SUI_CONFIG_DIR="$(mktemp -d)"
sui client --yes envs
sui keytool import "$(cat publish-recovery-<SENDER>.key)" ed25519
sui client switch --address <SENDER> --env <NETWORK>
sui client transfer --object-id <OBJECT_ID> --to <RECIPIENT>
```

For several objects, use one transaction:

```sh
sui client ptb --transfer-objects "[@<OBJECT_ID_1>, @<OBJECT_ID_2>]" @<RECIPIENT>
```

Then delete the key file and the temporary configuration directory.

## Full help

```text
publish --help
```

Help, version, and argument errors are local and do not initialize the SDK,
inspect credentials, or contact a network.

## License

MIT
