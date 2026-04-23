# gws-mcp-server

MCP server that exposes Google Workspace CLI (gws) as Model Context Protocol tools.

## Architecture
- `src/index.ts` — MCP server bootstrap, Zod schema generation, tool registration. Also hosts custom tools that don't fit the declarative ToolDef pattern (`drive_files_download`, `gmail_drafts_create`).
- `src/services.ts` — Declarative tool definitions across 5 services (drive, sheets, calendar, docs, gmail). Each entry maps to a `gws` CLI command + params/body.
- `src/executor.ts` — Command builder and runner with security hardening (shell injection prevention, path validation).
- `src/mime.ts` — RFC 2822 builder + base64url encoding for `gmail_drafts_create`. Includes CRLF-injection guard on header values.
- `src/__tests__/` — Vitest unit tests, one file per source module.

## Key constraints
- Windows cmd.exe escaping matters — executor handles platform-specific quoting
- Custom tools (`drive_files_download`, `gmail_drafts_create`) are registered in `index.ts` because they do work the declarative `ToolDef` shape can't express (file type detection, MIME building)
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
Tests are pure unit tests mocking the executor layer. No integration tests hit the real gws CLI.
- `executor.test.ts` — Command escaping, arg building, path validation, security
- `index.test.ts` — Zod schema generation, uploadPath conditional inclusion
- `services.test.ts` — Tool registry integrity, tool uniqueness, param validation
- `mime.test.ts` — base64url, RFC 2047 header encoding, RFC 2822 message construction, CRLF-injection guard

## Agent workflow
- Always work on a branch. Never push directly to main.
- Create PRs targeting main. CI must pass (lint + build + test on Node 20 and 22).
- Keep changes focused — one feature or fix per PR.
- Run `npm test` locally before pushing.
