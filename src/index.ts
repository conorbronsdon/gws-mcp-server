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
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getToolsForServices, ALL_SERVICES, type ToolDef } from "./services.js";
import { executeGws, spawnGwsRaw } from "./executor.js";

// ── CLI argument parsing ───────────────────────────────────────────────

function parseArgs(): { services: string[]; gwsBinary: string } {
  const args = process.argv.slice(2);
  let services = ALL_SERVICES;
  let gwsBinary = "gws";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--services" || args[i] === "-s") {
      const val = args[++i];
      if (val) {
        const requested = val.split(",").map((s) => s.trim().toLowerCase());
        const invalid = requested.filter((s) => !ALL_SERVICES.includes(s));
        if (invalid.length > 0) {
          console.error(`[gws-mcp] Unknown service(s): ${invalid.join(", ")}. Available: ${ALL_SERVICES.join(", ")}`);
          process.exit(1);
        }
        services = requested;
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

/**
 * Validate that the gws binary exists and is reachable.
 * Uses `where` (Windows) or `which` (Unix) for bare names,
 * or checks that a path resolves to an existing file.
 */
function validateGwsBinary(gwsBinary: string): void {
  // Reject shell metacharacters in the binary path
  if (/[&|<>^%();`$!]/.test(gwsBinary)) {
    console.error(`[gws-mcp] FATAL: --gws-path contains disallowed characters: ${gwsBinary}`);
    process.exit(1);
  }

  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execFileSync(whichCmd, [gwsBinary], { stdio: "ignore" });
  } catch {
    console.error(`[gws-mcp] FATAL: gws binary not found: "${gwsBinary}". Is gws installed and on PATH?`);
    process.exit(1);
  }
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

  validateGwsBinary(gwsBinary);

  const tools = getToolsForServices(services);

  if (tools.length === 0) {
    console.error("[gws-mcp] FATAL: No tools registered. Check --services flag.");
    process.exit(1);
  }

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

  // ── Custom tool: drive_files_download ─────────────────────────────────
  // Downloads actual file content (not just metadata) from Google Drive.
  // Uses alt=media for binary/text files, or export for Google-native files.
  if (services.includes("drive")) {
    const GOOGLE_NATIVE_TYPES = new Set([
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.google-apps.presentation",
      "application/vnd.google-apps.drawing",
    ]);

    const EXPORT_DEFAULTS: Record<string, string> = {
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.google-apps.spreadsheet": "text/csv",
      "application/vnd.google-apps.presentation": "text/plain",
      "application/vnd.google-apps.drawing": "image/png",
    };

    server.tool(
      "drive_files_download",
      "Download a file's content from Google Drive. Returns the text content for text files, or a base64-encoded string for binary files. For Google Docs/Sheets/Slides, exports to a readable format (plain text by default).",
      {
        fileId: z.string().describe("The file ID to download"),
        supportsAllDrives: z.boolean().optional().describe("Support shared drives (set true for shared drive files)"),
        exportMimeType: z.string().optional().describe("For Google-native files (Docs/Sheets/Slides): export format. Defaults to text/plain for Docs, text/csv for Sheets. Examples: text/plain, text/csv, application/pdf"),
      },
      async (args) => {
        const tmpFile = join(tmpdir(), `gws-dl-${randomBytes(8).toString("hex")}`);

        try {
          // First, get metadata to determine file type
          const metaParams: Record<string, unknown> = {
            fileId: args.fileId,
            fields: "mimeType,name,size",
          };
          if (args.supportsAllDrives) metaParams.supportsAllDrives = true;

          const metaParamsJson = JSON.stringify(metaParams);
          const metaEscaped = process.platform === "win32"
            ? (await import("./executor.js")).escapeJsonArg(metaParamsJson)
            : metaParamsJson;

          const metaResult = await spawnGwsRaw(gwsBinary, [
            "drive", "files", "get", "--params", metaEscaped,
          ]);
          const meta = JSON.parse(metaResult.stdout);
          const fileMimeType: string = meta.mimeType || "";
          const fileName: string = meta.name || "unknown";
          const isGoogleNative = GOOGLE_NATIVE_TYPES.has(fileMimeType);

          let cliArgs: string[];

          if (isGoogleNative) {
            // Use export endpoint for Google-native files
            const exportMime = args.exportMimeType || EXPORT_DEFAULTS[fileMimeType] || "text/plain";
            const exportParams: Record<string, unknown> = {
              fileId: args.fileId,
              mimeType: exportMime,
            };
            const paramsJson = JSON.stringify(exportParams);
            const escaped = process.platform === "win32"
              ? (await import("./executor.js")).escapeJsonArg(paramsJson)
              : paramsJson;

            cliArgs = ["drive", "files", "export", "--params", escaped, "-o", tmpFile];
          } else {
            // Use alt=media for regular files
            const dlParams: Record<string, unknown> = {
              fileId: args.fileId,
              alt: "media",
            };
            if (args.supportsAllDrives) dlParams.supportsAllDrives = true;

            const paramsJson = JSON.stringify(dlParams);
            const escaped = process.platform === "win32"
              ? (await import("./executor.js")).escapeJsonArg(paramsJson)
              : paramsJson;

            cliArgs = ["drive", "files", "get", "--params", escaped, "-o", tmpFile];
          }

          console.error(`[gws-mcp] Downloading ${fileName} (${fileMimeType}) to ${tmpFile}`);
          await spawnGwsRaw(gwsBinary, cliArgs);

          if (!existsSync(tmpFile)) {
            return {
              content: [{ type: "text" as const, text: "Error: Download produced no output file" }],
              isError: true,
            };
          }

          // Determine if content is text or binary
          const isText = fileMimeType.startsWith("text/")
            || fileMimeType.includes("json")
            || fileMimeType.includes("xml")
            || fileMimeType.includes("yaml")
            || fileMimeType.includes("csv")
            || isGoogleNative;

          let content: string;
          if (isText) {
            content = readFileSync(tmpFile, "utf-8");
            // Truncate if too large
            if (content.length > 100_000) {
              content = content.slice(0, 100_000) + "\n\n[Content truncated at 100,000 characters]";
            }
          } else {
            const buf = readFileSync(tmpFile);
            content = `[Binary file: ${fileName} (${fileMimeType}, ${buf.length} bytes)]\n\nBase64 content (first 50KB):\n${buf.toString("base64").slice(0, 50_000)}`;
          }

          return {
            content: [{ type: "text" as const, text: content }],
          };
        } catch (err: unknown) {
          const error = err as { message?: string };
          return {
            content: [{ type: "text" as const, text: `Error downloading file: ${error.message || "Unknown error"}` }],
            isError: true,
          };
        } finally {
          // Clean up temp file
          try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* ignore */ }
        }
      },
    );

    console.error("[gws-mcp] Registered custom tool: drive_files_download");
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
