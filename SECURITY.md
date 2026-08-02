# Security

This server shells out to the [`gws` CLI](https://github.com/googleworkspace/cli) and never handles your Google credentials directly: authentication lives entirely in `gws auth login`. There is no token to configure here.

Things worth knowing:

- **Logging stops at the subcommand.** Each call logs the `gws` subcommand it ran (`sheets spreadsheets values update`) plus any error, and never the `--params` or `--json` arguments — those carry the request body: cell values, inserted document text, grantee email addresses. MCP clients persist stderr to log files, so this is the difference between a transient value and one on disk indefinitely. Setting `GWS_MCP_DEBUG=1` logs the full command line, request bodies included; use it for debugging, not routinely. Both behaviours are pinned by tests in `src/__tests__/executor.test.ts`.
- **Not read-only.** Tools can create, update, and delete Drive files, calendar events, sheet values, and docs, and modify Gmail thread labels. Scope what an agent can touch with `--services` (e.g. `--services calendar` exposes only calendar tools). Gmail drafts are created but never sent.
- **Command construction is hardened.** `src/executor.ts` builds `gws` invocations without a shell where possible, validates the `--gws-path` binary path, and escapes JSON args for Windows cmd quoting. `src/mime.ts` rejects CR/LF in user-supplied header values to prevent email header injection in drafts.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
