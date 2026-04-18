# gws-mcp-server

<a href="https://glama.ai/mcp/servers/conorbronsdon/gws-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/conorbronsdon/gws-mcp-server/badge" alt="gws-mcp-server MCP server" />
</a>

[![npm version](https://img.shields.io/npm/v/gws-mcp-server)](https://www.npmjs.com/package/gws-mcp-server)
[![license](https://img.shields.io/npm/l/gws-mcp-server)](./LICENSE)

MCP server that exposes [Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli) operations as [Model Context Protocol](https://modelcontextprotocol.io/) tools.

## Why?

The `gws` CLI had a built-in MCP server that was [removed in v0.8.0](https://github.com/googleworkspace/cli/pull/275) because it exposed 200-400 tools — causing context window bloat in MCP clients. This server takes a curated approach: you choose which Google services to expose, and only a focused set of high-value, narrowly scoped operations are registered as tools.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [`gws` CLI](https://github.com/googleworkspace/cli) installed and authenticated (`npm install -g @googleworkspace/cli && gws auth login`)

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
        "--services", "drive,sheets,calendar,docs,gmail"
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

## Available services & tools

### `drive` (8 tools)
- `drive_files_list` — Search and list files
- `drive_files_get` — Get file metadata
- `drive_files_create` — Create files (with optional upload)
- `drive_files_copy` — Copy files (useful for format conversion)
- `drive_files_update` — Update file metadata/content
- `drive_files_delete` — Delete files
- `drive_files_export` — Export Google Workspace files (Doc, Sheet, Slide) to other formats
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
- `calendar_events_update` — Update events
- `calendar_events_delete` — Delete events

### `docs` (3 tools)
- `docs_get` — Get document content
- `docs_create` — Create documents
- `docs_batchUpdate` — Apply document updates

### `gmail` (4 tools)
- `gmail_messages_list` — Search messages
- `gmail_messages_get` — Read a message
- `gmail_threads_list` — Search threads
- `gmail_threads_get` — Read a full thread

**Total: 24 tools** (vs 200-400 in the old implementation)

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

## Architecture

```
MCP Client (Claude) ←→ stdio ←→ gws-mcp-server ←→ gws CLI ←→ Google APIs
```

The server is a thin wrapper: it translates MCP tool calls into `gws` CLI invocations, passes `--params` and `--json` as appropriate, and returns the JSON output.

---

## Disclaimer

*All views, opinions, and statements expressed on this account are solely my own and are made in my personal capacity. They do not reflect, and should not be construed as reflecting, the views, positions, or policies of Modular. This account is not affiliated with, authorized by, or endorsed by Modular in any way.*

## License

MIT
