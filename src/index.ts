#!/usr/bin/env node

/**
 * gws-mcp-server — MCP server for Google Workspace CLI
 *
 * Exposes curated Google Workspace tools via Model Context Protocol,
 * wrapping the gws CLI (https://github.com/googleworkspace/cli).
 *
 * Usage:
 *   gws-mcp-server [--services drive,sheets,calendar,docs,gmail,tasks] [--gws-path /path/to/gws]
 *
 * In .mcp.json:
 *   {
 *     "mcpServers": {
 *       "google-workspace": {
 *         "command": "node",
 *         "args": ["path/to/gws-mcp-server/build/index.js", "--services", "drive,sheets,calendar,docs,gmail,tasks"]
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, existsSync, copyFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getToolsForServices, ALL_SERVICES, buildAnnotations, type ToolDef } from "./services.js";
import { executeGws, spawnGwsRaw, escapeJsonArg } from "./executor.js";
import { buildRfc2822, base64url } from "./mime.js";

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
 * Returns true if valid, false if not found (server continues but tools will error).
 */
function validateGwsBinary(gwsBinary: string): boolean {
  // Reject shell metacharacters in the binary path
  if (/[&|<>^%();`$!]/.test(gwsBinary)) {
    console.error(`[gws-mcp] FATAL: --gws-path contains disallowed characters: ${gwsBinary}`);
    process.exit(1);
  }

  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    execFileSync(whichCmd, [gwsBinary], { stdio: "ignore" });
    return true;
  } catch {
    console.error(`[gws-mcp] Warning: gws binary not found: "${gwsBinary}". Tools will error until gws is installed.`);
    return false;
  }
}

// ── Zod schema generation ──────────────────────────────────────────────

export function buildZodSchema(tool: ToolDef): Record<string, z.ZodTypeAny> {
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

// ── Temp file helper ───────────────────────────────────────────────────

/**
 * Generate a CWD-relative temp file name for gws CLI output.
 *
 * Must be relative: the gws CLI rejects --output paths that resolve outside
 * the current working directory. On macOS, os.tmpdir() returns /var/folders/...
 * which canonicalizes to /private/var/... (kernel symlink) and fails the
 * CLI's validate_safe_file_path() check. A bare relative name stays in CWD
 * on every platform. See issue #3.
 */
export function makeTmpFileName(prefix: string): string {
  return `.${prefix}-${randomBytes(8).toString("hex")}`;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const { services, gwsBinary } = parseArgs();

  const gwsAvailable = validateGwsBinary(gwsBinary);

  const tools = getToolsForServices(services);

  if (tools.length === 0) {
    console.error("[gws-mcp] FATAL: No tools registered. Check --services flag.");
    process.exit(1);
  }

  console.error(`[gws-mcp] Starting with ${tools.length} tools from services: ${services.join(", ")}`);
  console.error(`[gws-mcp] Using gws binary: ${gwsBinary}`);

  const server = new McpServer({
    name: "gws-mcp-server",
    version: "0.2.0",
  });

  // Register each tool, attaching MCP annotations derived from the ToolDef's
  // declarative readOnly/destructive flags so clients can reason about side
  // effects and surface clearer consent UI.
  for (const tool of tools) {
    const schema = buildZodSchema(tool);

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: schema,
        annotations: buildAnnotations(tool),
      },
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

    server.registerTool(
      "drive_files_download",
      {
        description: "Download a file's content from Google Drive. Returns the text content for text files, or a base64-encoded string for binary files. For Google Docs/Sheets/Slides, exports to a readable format (plain text by default).",
        inputSchema: {
          fileId: z.string().describe("The file ID to download"),
          exportMimeType: z.string().optional().describe("For Google-native files (Docs/Sheets/Slides): export format. Defaults to text/plain for Docs, text/csv for Sheets. Examples: text/plain, text/csv, application/pdf"),
          savePath: z.string().optional().describe("For binary files (images, PDFs): save to this local path instead of returning content inline. The file path is returned in the response."),
        },
        // Read-only: fetches content, never mutates Drive. (savePath writes a
        // local file, not the user's Drive data.)
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        const tmpFile = makeTmpFileName("gws-dl");
        let keepTmpFile = false;

        try {
          // First, get metadata to determine file type
          const metaParams: Record<string, unknown> = {
            fileId: args.fileId,
            fields: "mimeType,name,size",
            supportsAllDrives: true,
          };

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
              supportsAllDrives: true,
            };

            const paramsJson = JSON.stringify(dlParams);
            const escaped = process.platform === "win32"
              ? (await import("./executor.js")).escapeJsonArg(paramsJson)
              : paramsJson;

            cliArgs = ["drive", "files", "get", "--params", escaped, "-o", tmpFile];
          }

          console.error(`[gws-mcp] Downloading ${fileName} (${fileMimeType}) to ${tmpFile}`);
          await spawnGwsRaw(gwsBinary, cliArgs, 120_000); // 2 min timeout for downloads

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
          } else if (args.savePath) {
            // Save binary file to requested path
            const saveTo = String(args.savePath);
            copyFileSync(tmpFile, saveTo);
            const stat = readFileSync(saveTo);
            content = `[Binary file saved: ${saveTo}]\nName: ${fileName}\nType: ${fileMimeType}\nSize: ${stat.length} bytes`;
          } else {
            // Binary file without savePath — keep temp file so caller can access it
            keepTmpFile = true;
            const buf = readFileSync(tmpFile);
            content = `[Binary file: ${fileName} (${fileMimeType}, ${buf.length} bytes)]\nSaved to: ${tmpFile}\n\nTo save to a specific path, call again with the savePath parameter.`;
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
          // Clean up temp file (unless it's a binary file the caller needs)
          if (!keepTmpFile) {
            try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }
      },
    );

    console.error("[gws-mcp] Registered custom tool: drive_files_download");
  }

  // ── Custom tool: gmail_drafts_create ──────────────────────────────────
  // Creates a Gmail draft. The standard ToolDef pattern can't express the
  // Draft body (a base64url-encoded RFC 2822 message wrapped in
  // {message: {raw, threadId}}), so this is registered separately.
  if (services.includes("gmail")) {
    server.registerTool(
      "gmail_drafts_create",
      {
        description: "Create a Gmail draft. Pass threadId to attach the draft to an existing conversation (it will appear as a reply within that thread). The draft is NOT sent — open Gmail to review and send.",
        inputSchema: {
          to: z.string().describe("Recipient(s). Comma-separated for multiple, e.g. \"a@x.com, b@y.com\""),
          cc: z.string().optional().describe("CC recipient(s), comma-separated"),
          bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
          subject: z.string().optional().describe("Subject line. When attaching to a thread via threadId, Gmail expects the subject to match the thread (typically \"Re: <original>\")."),
          body: z.string().optional().describe("Plain-text body"),
          htmlBody: z.string().optional().describe("HTML body. If both body and htmlBody are provided, the draft is multipart/alternative."),
          threadId: z.string().optional().describe("Thread ID to attach this draft to. Get it from gmail_threads_list / gmail_messages_get."),
          inReplyTo: z.string().optional().describe("Message-ID header value of the message being replied to. Improves threading robustness alongside threadId."),
          references: z.string().optional().describe("References header value (space-separated Message-IDs of ancestor messages)."),
        },
        // Additive write: creates a draft (never sends). Reversible, non-destructive.
        annotations: { readOnlyHint: false },
      },
      async (args) => {
        try {
          const raw = base64url(buildRfc2822({
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            body: args.body,
            htmlBody: args.htmlBody,
            inReplyTo: args.inReplyTo,
            references: args.references,
          }));

          const message: { raw: string; threadId?: string } = { raw };
          if (args.threadId) message.threadId = args.threadId;

          const params = escapeJsonArg(JSON.stringify({ userId: "me" }));
          const json = escapeJsonArg(JSON.stringify({ message }));

          const { stdout } = await spawnGwsRaw(gwsBinary, [
            "gmail", "users", "drafts", "create",
            "--params", params,
            "--json", json,
          ], 30_000);

          return { content: [{ type: "text" as const, text: stdout || "(empty response)" }] };
        } catch (err: unknown) {
          const error = err as { message?: string };
          return {
            content: [{ type: "text" as const, text: `Error creating draft: ${error.message || "Unknown error"}` }],
            isError: true,
          };
        }
      },
    );

    console.error("[gws-mcp] Registered custom tool: gmail_drafts_create");
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
