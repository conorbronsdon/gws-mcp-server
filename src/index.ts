#!/usr/bin/env node

/**
 * gws-mcp-server — MCP server for Google Workspace CLI
 *
 * Exposes curated Google Workspace tools via Model Context Protocol,
 * wrapping the gws CLI (https://github.com/googleworkspace/cli).
 *
 * Usage:
 *   gws-mcp-server [--services drive,sheets,calendar,docs,gmail] [--gws-path /path/to/gws]
 *
 * In .mcp.json:
 *   {
 *     "mcpServers": {
 *       "google-workspace": {
 *         "command": "node",
 *         "args": ["path/to/gws-mcp-server/build/index.js", "--services", "drive,sheets,calendar,docs,gmail"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getToolsForServices, ALL_SERVICES, type ToolDef } from "./services.js";
import { executeGws } from "./executor.js";

// ── CLI argument parsing ───────────────────────────────────────────────

function parseArgs(): { services: string[]; gwsBinary: string } {
  const args = process.argv.slice(2);
  let services = ALL_SERVICES;
  let gwsBinary = "gws";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--services" || args[i] === "-s") {
      const val = args[++i];
      if (val) {
        services = val.split(",").map((s) => s.trim().toLowerCase());
      }
    } else if (args[i] === "--gws-path") {
      gwsBinary = args[++i] || "gws";
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.error(`
gws-mcp-server — MCP server for Google Workspace CLI

OPTIONS:
  --services, -s <list>   Comma-separated services to expose (default: all)
                          Available: ${ALL_SERVICES.join(", ")}
  --gws-path <path>       Path to gws binary (default: "gws")
  --help, -h              Show this help

EXAMPLE:
  gws-mcp-server --services drive,sheets,calendar
`);
      process.exit(0);
    }
  }

  return { services, gwsBinary };
}

// ── Zod schema generation ──────────────────────────────────────────────

function buildZodSchema(tool: ToolDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};

  const allParams = [...tool.params, ...(tool.bodyParams || [])];

  for (const p of allParams) {
    let field: z.ZodTypeAny;
    switch (p.type) {
      case "number":
        field = z.number().describe(p.description);
        break;
      case "boolean":
        field = z.boolean().describe(p.description);
        break;
      default:
        field = z.string().describe(p.description);
    }

    if (!p.required) {
      field = field.optional();
    }

    shape[p.name] = field;
  }

  // Add optional uploadPath for tools that support file upload
  if (tool.supportsUpload) {
    shape.uploadPath = z.string().describe("Local file path to upload").optional();
  }

  return shape;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const { services, gwsBinary } = parseArgs();

  const tools = getToolsForServices(services);

  console.error(`[gws-mcp] Starting with ${tools.length} tools from services: ${services.join(", ")}`);
  console.error(`[gws-mcp] Using gws binary: ${gwsBinary}`);

  const server = new McpServer({
    name: "gws-mcp-server",
    version: "0.1.0",
  });

  // Register each tool
  for (const tool of tools) {
    const schema = buildZodSchema(tool);

    server.tool(
      tool.name,
      tool.description,
      schema,
      async (args) => {
        const result = await executeGws(tool, args as Record<string, unknown>, gwsBinary);

        if (result.success) {
          return {
            content: [{ type: "text" as const, text: result.output || "(empty response)" }],
          };
        } else {
          return {
            content: [{ type: "text" as const, text: `Error: ${result.error}` }],
            isError: true,
          };
        }
      },
    );
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[gws-mcp] Server running on stdio");
}

main().catch((err) => {
  console.error("[gws-mcp] Fatal error:", err);
  process.exit(1);
});
