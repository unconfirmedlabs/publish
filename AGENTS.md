# Agent guidance

- Treat the CLI's argv, stdout, stderr, JSON fields, and exit statuses as a public protocol.
- Keep `--help` and `--version` local: they must not initialize the Sui SDK, credentials, or the network.
- Never persist, print, or return the ephemeral publisher's private key.
- Spawn the Sui CLI with an argv array. Never interpolate package paths or options into a shell command.
- A publish is successful only after the Sui result is a successful transaction. Preserve any digest returned for an uncertain outcome.
- When working with `@mysten/*` packages, read `node_modules/@mysten/*/docs/llms-index.md` first, then the relevant version-matched page.
