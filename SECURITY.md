# Security

This server shells out to the [`gws` CLI](https://github.com/googleworkspace/cli) and never handles your Google credentials directly: authentication lives entirely in `gws auth login`. There is no token to configure here and nothing is logged beyond tool names and errors.

Things worth knowing:

- **Not read-only.** Tools can create, update, and delete Drive files, calendar events, sheet values, and docs, and modify Gmail thread labels. Scope what an agent can touch with `--services` (e.g. `--services calendar` exposes only calendar tools). Gmail drafts are created but never sent.
- **Command construction is hardened.** `src/executor.ts` builds `gws` invocations without a shell where possible, validates the `--gws-path` binary path, and escapes JSON args for Windows cmd quoting. `src/mime.ts` rejects CR/LF in user-supplied header values to prevent email header injection in drafts.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
