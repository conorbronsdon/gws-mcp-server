# gws-mcp-server

MCP server that exposes Google Workspace CLI (gws) as Model Context Protocol tools.

## Architecture
- `src/index.ts` — MCP server bootstrap, Zod schema generation, tool registration. Also hosts custom tools that don't fit the declarative ToolDef pattern (listed in `CUSTOM_TOOLS`: `drive_files_download`, `gmail_drafts_create`, `drive_permissions_transferOwnership`, `drive_permissions_proposeOwnershipTransfer`).
- `src/services.ts` — Declarative tool definitions across 8 services (drive, sheets, calendar, docs, slides, gmail, tasks, people). Each entry maps to a `gws` CLI command + params/body. `DEFAULT_SERVICES` is the no-flag set; `people` is supported but opt-in because it needs an extra OAuth scope.
- `src/executor.ts` — Command builder and runner with security hardening (shell injection prevention, path validation).
- `src/errors.ts` — Typed error hierarchy; `mapGwsErrorToTyped()` recovers a status code from gws's plain-text stderr.
- `src/mime.ts` — RFC 2822 builder + base64url encoding for `gmail_drafts_create`. Includes CRLF-injection guard on header values.
- `src/__tests__/` — Vitest tests: one file per source module, plus an in-memory MCP client suite, a Windows-only cmd.exe round-trip, and a publish-workflow check.

## Key constraints
- Windows cmd.exe escaping matters — executor handles platform-specific quoting
- Custom tools (`CUSTOM_TOOLS` in `index.ts`) are registered by hand because they do work the declarative `ToolDef` shape can't express (file type detection, MIME building, request-body fields the caller must not be able to set)
- All tools delegate to the `gws` CLI binary — no direct Google API calls
- Gmail draft creation accepts user-controlled header values; `src/mime.ts` rejects CR/LF in any header input to prevent email header injection

## Development
```bash
npm ci
npm run lint    # tsc --noEmit (type-check)
npm run build   # tsc
npm test        # vitest run
```

## Testing
Most tests are unit tests mocking the executor layer. No test hits the real gws CLI or Google.
- `executor.test.ts` — Command escaping, arg building, path validation, security
- `index.test.ts` — Zod schema generation, uploadPath conditional inclusion
- `services.test.ts` — Tool registry integrity, tool uniqueness, param validation
- `mime.test.ts` — base64url, RFC 2047 header encoding, RFC 2822 message construction, CRLF-injection guard
- `errors.test.ts` — Typed error hierarchy, gws error-detail extraction, status mapping
- `annotations.e2e.test.ts` — Real MCP client over an in-memory transport: annotation hints on every tool, `--read-only`, default vs opt-in services, README/server.json counts
- `executor.windows.test.ts` — Windows-only: round-trips JSON args through real cmd.exe via `fixtures/argv-dump.cmd`
- `publish-workflow.test.ts` — Registry gate in `.github/workflows/publish.yml`

## Agent workflow
- Always work on a branch. Never push directly to main.
- Create PRs targeting main. CI must pass (lint + build + test on Node 20 and 22, Ubuntu and Windows).
- Keep changes focused — one feature or fix per PR.
- Run `npm test` locally before pushing.
