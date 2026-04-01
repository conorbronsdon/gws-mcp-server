# gws-mcp-server

MCP server that exposes Google Workspace CLI (gws) as Model Context Protocol tools.

## Architecture
- `src/index.ts` (331 LOC) — MCP server bootstrap, Zod schema generation, tool registration
- `src/services.ts` (375 LOC) — Tool definitions for 25 tools across 5 services (drive, sheets, calendar, docs, gmail)
- `src/executor.ts` (210 LOC) — Command builder and runner with security hardening (shell injection prevention, path validation)
- `src/__tests__/` — Vitest unit tests (113 assertions across 3 files)

## Key constraints
- Windows cmd.exe escaping matters — executor handles platform-specific quoting
- `drive_files_download` is a custom tool with complex file type detection (Google-native vs regular files, export vs alt=media)
- All tools delegate to the `gws` CLI binary — no direct Google API calls

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

## Agent workflow
- Always work on a branch. Never push directly to main.
- Create PRs targeting main. CI must pass (lint + build + test on Node 20 and 22).
- Keep changes focused — one feature or fix per PR.
- Run `npm test` locally before pushing.
