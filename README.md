<div align="center">

# gws-mcp-server

Google Workspace for AI agents: Gmail, Calendar, Drive, Sheets, Docs, Slides, and Tasks as a curated set of 44 [Model Context Protocol](https://modelcontextprotocol.io/) tools, built on the official [Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli).

[![npm version](https://img.shields.io/npm/v/gws-mcp-server?style=flat-square)](https://www.npmjs.com/package/gws-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-18+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Podcast](https://img.shields.io/badge/Podcast-Chain_of_Thought-purple?style=flat-square)](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=gws-mcp-server)
[![X](https://img.shields.io/badge/X-@ConorBronsdon-black?style=flat-square&logo=x)](https://x.com/ConorBronsdon)

<img src="docs/demo.gif" alt="Demo: an agent calls the calendar_events_list tool and gets events back (sample data)" width="800">

</div>

---


## Why?

The `gws` CLI had a built-in MCP server that was [removed in v0.8.0](https://github.com/googleworkspace/cli/pull/275) because it exposed 200-400 tools — causing context window bloat in MCP clients. This server takes a curated approach: you choose which Google services to expose, and only a focused set of high-value, narrowly scoped operations are registered as tools. Every tool declares all four MCP annotation hints — `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` — so clients can reason about side effects, know which writes are safe to retry, and surface clearer consent prompts. This is the permissions leg of trust infrastructure for agents: a deliberately narrow tool surface, side effects declared on every tool, and no send tool at all.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [`gws` CLI](https://github.com/googleworkspace/cli) installed and authenticated (`npm install -g @googleworkspace/cli && gws auth login`)

### Grant fewer scopes than the default

This server exposes **no send tool** — the closest thing is `gmail_drafts_create`, which explicitly does not send. The token `gws auth login` mints is broader than that.

`gws auth login` opens a scope picker listing **nine** scopes. The default grant is **seven**: full read-write `drive`, `spreadsheets`, `gmail.modify` (Google documents it as "Read, compose, and send emails"), `calendar`, `documents`, `presentations`, and `tasks` — the same seven you get running non-interactively as `DEFAULT_SCOPES`.

The other two rows are Cloud Pub/Sub and Cloud Platform, and neither is part of the default grant — `gws auth login --help` describes `--full` as "Request all scopes incl. pubsub + cloud-platform."

Which rows start *checked* has not been verified against a live picker — the seven above are the documented default grant, not an observation of the TUI. Read the checkboxes before pressing Enter rather than trusting this paragraph.

So the token on disk can send mail and rewrite Drive even though nothing here will. **Deselect what you do not need in the picker**, or:

```bash
gws auth login --readonly    # read-only across services
```

`-s gmail` limits the picker to Gmail, per the flag's own help text ("Comma-separated service names to limit scope picker"). It cannot pull in `cloud-platform` or `pubsub`, because those two are reachable only through `--full`.

**On Linux there is no keyring, and the encryption key is a file next to the data it encrypts.** `gws` enables the `keyring` crate's native backends only for macOS and Windows; on every other platform the dependency is declared with no backend feature, so the store falls through to writing `.encryption_key` into `~/.config/gws/`. That file is not a backup of a key held elsewhere — it is the key, and the credential store's own doc comment says it is never deleted. Setting `GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND=file` changes nothing there because that is already the only path. On macOS and Windows the key file is removed once the OS keyring holds the key. **If you run this headless on Linux, treat `~/.config/gws/` as a password file: anyone who can read the directory has the credentials.**

## Quick start

```bash
# Install
npm install -g gws-mcp-server

# Or run from source
git clone https://github.com/conorbronsdon/gws-mcp-server.git
cd gws-mcp-server
npm install && npm run build
```

## Configuration

### Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": [
        "gws-mcp-server",
        "--services", "drive,sheets,calendar,docs,gmail,tasks"
      ]
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": [
        "gws-mcp-server",
        "--services", "drive,sheets,calendar"
      ]
    }
  }
}
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--services, -s` | Comma-separated list of services to expose | All services |
| `--gws-path` | Path to the `gws` binary | `gws` |
| `--read-only` | Register only the read-only tools | off |

### `--read-only`

`--read-only` registers **20 tools** instead of 44. Every tool that writes to Google is left unregistered, so it never appears in `tools/list` and there is nothing for an agent to call — including `gmail_drafts_create`, which is a write even though it never sends. `drive_files_download` stays, since it reads.

```bash
gws-mcp-server --read-only
gws-mcp-server --read-only --services drive,calendar   # combines with -s
```

This constrains the **agent, not the credential**. The token on disk keeps whatever scopes it was granted, and anything else on the machine can still use it. `gws auth login --readonly` is what narrows the token; the two are complementary. For an MCP server the agent is the threat model, but that is the limit of the claim.

### Trimming context cost

Every registered tool rides along in each conversation: the full registry is roughly 27 KB of `tools/list` payload (about 6.7K tokens) that your MCP client loads before anything else happens. The two flags above compose, and dropping whole services you don't use is the cheapest context win there is:

```bash
gws-mcp-server --services calendar                       # calendar assistant: 5 tools
gws-mcp-server --services drive,docs                     # document work, nothing else
gws-mcp-server --read-only --services drive,docs,sheets  # research setup: reads only
```

In `.mcp.json` or `claude_desktop_config.json`, the same trimming is just editing the `args` array:

```json
"args": ["gws-mcp-server", "--services", "drive,calendar"]
```

A service's tool count (headers below) tracks its context cost: dropping `tasks` (12 tools) saves the most, `docs` (3 tools) the least. There is no per-tool exclude flag today — if service granularity is too coarse for your setup, [open an issue](https://github.com/conorbronsdon/gws-mcp-server/issues) describing the split you need.

## Available services & tools

### `drive` (9 tools)
- `drive_files_list` — Search and list files
- `drive_files_get` — Get file metadata
- `drive_files_create` — Create files (with optional upload)
- `drive_files_copy` — Copy files (useful for format conversion)
- `drive_files_update` — Update file metadata/content
- `drive_files_delete` — Delete files
- `drive_files_export` — Export Google Workspace files (Doc, Sheet, Slide) to other formats
- `drive_files_download` — Download file content (text inline, binary as base64 or saved to a path; Google-native files are exported to a readable format)
- `drive_permissions_create` — Share files

### `sheets` (4 tools)
- `sheets_get` — Get spreadsheet metadata
- `sheets_values_get` — Read cell values
- `sheets_values_update` — Write cell values
- `sheets_values_append` — Append rows

### `calendar` (5 tools)
- `calendar_events_list` — List events
- `calendar_events_get` — Get event details
- `calendar_events_insert` — Create events
- `calendar_events_update` — Update events (only supplied fields change)
- `calendar_events_delete` — Delete events

### `docs` (3 tools)
- `docs_get` — Get document content
- `docs_create` — Create documents
- `docs_batchUpdate` — Apply document updates

### `slides` (5 tools)
- `slides_get` — Get a presentation's slides, layouts, masters, and page elements
- `slides_create` — Create a blank presentation
- `slides_batchUpdate` — Apply updates (insert/update/delete slides, text, shapes, tables, etc)
- `slides_pages_get` — Get a single page (slide, layout, or master)
- `slides_pages_getThumbnail` — Get a thumbnail image URL for a page

### `gmail` (6 tools)
- `gmail_messages_list` — Search messages
- `gmail_messages_get` — Read a message
- `gmail_threads_list` — Search threads
- `gmail_threads_get` — Read a full thread
- `gmail_threads_modify` — Add/remove labels on a thread (archive, mark read, star)
- `gmail_drafts_create` — Create a draft (plain text and/or HTML, with reply threading via `threadId`). Drafts are never auto-sent

### `tasks` (12 tools)
- `tasks_tasklists_list` — List task lists
- `tasks_tasklists_get` — Get a task list
- `tasks_tasklists_insert` — Create a task list
- `tasks_tasklists_update` — Update a task list (only supplied fields change)
- `tasks_tasklists_delete` — Delete a task list
- `tasks_tasks_list` — List tasks (filters: completed/hidden/due dates)
- `tasks_tasks_get` — Get a task
- `tasks_tasks_insert` — Create a task (optionally nested or positioned)
- `tasks_tasks_update` — Update a task (only supplied fields change; common use: mark complete)
- `tasks_tasks_move` — Move a task within/across lists or reorder
- `tasks_tasks_delete` — Delete a task
- `tasks_tasks_clear` — Hide all completed tasks in a list

> **Update semantics:** the `*_update` tools (calendar events, tasks, task lists) use the Google API's `patch` verb — they merge the fields you supply and leave the rest untouched. To *clear* an existing value, pass it explicitly (e.g. an empty string) rather than omitting it.

**Total: 44 tools** (vs 200-400 in the old implementation)

## Adding new tools

Edit `src/services.ts` to add tool definitions. Each tool maps directly to a `gws` CLI command:

```typescript
{
  name: "drive_files_list",           // MCP tool name
  description: "List files in Drive", // Shown to AI
  command: ["drive", "files", "list"],// gws CLI args
  params: [                           // Maps to --params JSON
    { name: "q", description: "Search query", type: "string", required: false },
  ],
  bodyParams: [                       // Maps to --json body
    { name: "name", description: "File name", type: "string", required: true },
  ],
}
```

### Typed errors

Tool call failures are mapped to a typed error hierarchy (`src/errors.ts`): `AuthenticationError` (401/403), `RateLimitError` (429), `ValidationError` (400), `NotFoundError` (404, with a shared-drive access hint for `drive` commands), and `ServerError` (5xx), all extending a base `GwsError`. Unlike an HTTP API client, this server has no response object to read a status code from — it spawns the `gws` CLI as a subprocess and only sees plain text (stdout/stderr, or a rejected promise's `.message`). `mapGwsErrorToTyped()` recovers a status-like code from that text, handling both a raw JSON error body (Google's own `{"error":{"code":...,"message":...}}` shape) and plain text containing an HTTP-status-like token (e.g. `"Error 404: ..."`). If neither pattern is found, the original message passes through unchanged rather than forcing an invented status onto it.

## Architecture

```
MCP Client (Claude) ←→ stdio ←→ gws-mcp-server ←→ gws CLI ←→ Google APIs
```

The server is a thin wrapper: it translates MCP tool calls into `gws` CLI invocations, passes `--params` and `--json` as appropriate, and returns the JSON output. Authentication stays in the `gws` CLI — this server never sees or stores your Google credentials.

## Development

```bash
git clone https://github.com/conorbronsdon/gws-mcp-server.git
cd gws-mcp-server
npm ci
npm run lint    # type-check
npm run build
npm test        # vitest, mocks the executor layer — no real gws calls
```

## Contributing

Issues and pull requests are welcome. The most useful contributions are new tool definitions in `src/services.ts` for high-value `gws` operations (see "Adding new tools" above). Keep the curated contract: a focused set of narrowly scoped tools, not a 1:1 mirror of every Google API surface. See [SECURITY.md](./SECURITY.md) for how to report vulnerabilities.

## Other options

This server is deliberately narrow: a curated tool surface, side effects declared on every tool, no freestanding send tool. That is the right trade for some workflows and the wrong one for others. The real alternatives:

| You want | Use |
|---|---|
| Every Workspace API, self-hosted, with tiers and multi-user OAuth | [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) — 120+ tools across 12 services, MIT, `--tool-tier core\|extended\|complete` |
| Google's own servers, hosted by Google | [Google Workspace remote MCP servers](https://developers.google.com/workspace/guides/configure-mcp-servers) — 8 endpoints, 42 tools. Developer Preview: requires an application, a Workspace account (not personal Gmail), and a supported client plan |
| No MCP at all — CLI plus agent skills | [googleworkspace/cli](https://github.com/googleworkspace/cli) — 100+ Agent Skills on the same `gws auth login` this server uses |

Worth saying plainly: Google's official Gmail MCP server is also draft-only, with no send tool — the curated-surface argument is no longer contrarian. What this server still does that those don't: Google Tasks (Google's official lineup has no Tasks server), all four MCP annotation hints on every tool, a local stdio server with no preview application or plan gating, and `--read-only` as a single flag.

### The analytics siblings

| Data | Server |
|---|---|
| Google Workspace | this repo |
| Search Console | [gsc-mcp](https://github.com/conorbronsdon/gsc-mcp) — same curated approach, including derived views like `gsc_striking_distance` |
| YouTube Analytics | [yt-analytics-mcp](https://github.com/conorbronsdon/yt-analytics-mcp) — owner-side channel, video, and playlist metrics; read-only, nine tools |
| Google Analytics 4 | [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) — Google's own, read-only |
| BigQuery | [googleapis/mcp-toolbox](https://github.com/googleapis/mcp-toolbox) — Google's own |

These are separate credential families, not one login: Workspace authenticates with `gws auth login`, Search Console with a `webmasters` OAuth credential, YouTube Analytics with a `yt-analytics.readonly` OAuth credential, GA4 with Application Default Credentials scoped `analytics.readonly`. Nothing here shares a token with anything else.

## About

Built and maintained by [Conor Bronsdon](https://github.com/conorbronsdon). I host the [Chain of Thought](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=gws-mcp-server) podcast, which covers AI infrastructure, developer tools, and how practitioners actually use this stuff. I built this to give the agent workflows that run the show safe, curated access to Gmail, Calendar, Drive, Sheets, Docs, Slides, and Tasks.

<a href="https://glama.ai/mcp/servers/conorbronsdon/gws-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/conorbronsdon/gws-mcp-server/badge" alt="gws-mcp-server MCP server" />
</a>

Companion tools:

- [Transistor-MCP](https://github.com/conorbronsdon/Transistor-MCP): the Transistor.fm MCP server. Episodes, transcripts, and download counts.
- [substack-mcp](https://github.com/conorbronsdon/substack-mcp): read posts and manage drafts on Substack, safe for agent workflows.
- [podcastindex-mcp](https://github.com/conorbronsdon/podcastindex-mcp): the Podcast Index MCP server, search by person or topic, trending shows, feed health.
- [op3-mcp](https://github.com/conorbronsdon/op3-mcp): podcast analytics through OP3. Downloads, geography, apps. Read-only.
- [ai-tools-for-creators](https://github.com/conorbronsdon/ai-tools-for-creators): a curated list of AI skills and MCP servers for people who ship ideas for a living.

More at [chainofthought.show](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=gws-mcp-server) and on [X](https://x.com/ConorBronsdon).

---

## Disclaimer

*This is an independent personal project, not affiliated with, sponsored by, or endorsed by any company. All views expressed are my own.*

## License

MIT
