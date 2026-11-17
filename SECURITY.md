# Security

This server shells out to the [`gws` CLI](https://github.com/googleworkspace/cli) and never handles your Google credentials directly: authentication lives entirely in `gws auth login`. There is no token to configure here.

Things worth knowing:

- **What this server logs to stderr.** MCP clients persist stderr to log files, so anything printed there can sit on disk indefinitely. For each registry tool call, the server logs the `gws` subcommand it ran (`sheets spreadsheets values update`) and never the `--params` or `--json` arguments, which carry the request body: cell values, inserted document text, grantee email addresses. Setting `GWS_MCP_DEBUG=1` logs the full command line, request bodies included; use it for debugging, not routinely. Both behaviours are pinned by tests in `src/__tests__/executor.test.ts`. Beyond the subcommand, the log can also contain:
  - **gws's own stderr, verbatim.** Whatever `gws` writes to stderr is logged unfiltered, on success as well as on failure. This server does not redact it.
  - **Error text.** A failed registry tool call logs its error message, built from what gws printed when it failed (on stdout or stderr). Google API error messages may quote values from the request.
  - **Download metadata.** `drive_files_download` logs the Drive file's name, its MIME type and the temporary file it downloads to.
  - **Startup details.** The `gws` binary path and the enabled services.
- **Error text reaches tool output.** A failed call returns the error to the MCP client, and so to the agent. Registry tools return the mapped message, which keeps the API's own detail text (see "Typed errors" in the README); the hand-registered tools (`drive_files_download`, `gmail_drafts_create`, and the two ownership-transfer tools) return gws's raw failure output (from stdout or stderr) unmapped. Apart from the download line above, those four tools log nothing per call: no subcommand, no gws stderr, no errors.
- **Not read-only by default.** Tools can create, update, and delete Drive files, calendar events, sheet values, and docs, and modify Gmail thread labels. Start the server with `--read-only` to register only the read tools: no tool that writes to Google is listed or callable (26 tools with the default services). Scope what an agent can touch further with `--services` (e.g. `--services calendar` exposes only calendar tools); the two flags combine. Both constrain the agent, not the credential: the token `gws` holds keeps whatever scopes it was granted, and `gws auth login --readonly` is what narrows it. Gmail drafts are created but never sent.
- **Command construction is hardened.** `src/executor.ts` spawns `gws` without a shell on every platform (on Windows, npm's `gws.cmd` is resolved to its JavaScript entry point and run with Node) and validates the `--gws-path` binary path. `src/mime.ts` rejects CR/LF in user-supplied header values to prevent email header injection in drafts.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab on this repo and click **Report a vulnerability**. Do not open a public issue for security problems.

I aim to respond within a week. Credit goes to the reporter in the fix notes unless you prefer otherwise.
