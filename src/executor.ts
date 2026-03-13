/**
 * Executes gws CLI commands and returns results.
 *
 * Security: all user-supplied values are passed through sanitization to
 * prevent command injection, especially on Windows where shell:true is
 * required for .cmd wrappers.
 */

import { spawn } from "node:child_process";
import { resolve, normalize } from "node:path";
import { existsSync } from "node:fs";
import type { ToolDef } from "./services.js";

/** Max output size before truncation (characters) */
const MAX_OUTPUT = 100_000;

/** Characters that are dangerous in cmd.exe when shell:true */
const CMD_METACHAR_RE = /[&|<>^%()!]/g;

/**
 * Escape a string for safe use as a cmd.exe argument.
 * Wraps in double quotes and escapes inner quotes + metacharacters.
 */
export function escapeForCmd(value: string): string {
  // Escape cmd.exe metacharacters with ^ and double quotes with \"
  const escaped = value.replace(CMD_METACHAR_RE, "^$&").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Escape a JSON string for passing as a CLI argument.
 * On Windows with shell:true, cmd.exe interprets metacharacters unless escaped.
 */
export function escapeJsonArg(json: string): string {
  if (process.platform === "win32") {
    return escapeForCmd(json);
  }
  return json;
}

/**
 * Validate and sanitize a file upload path.
 * Rejects paths containing shell metacharacters or path traversal sequences.
 */
function sanitizeUploadPath(rawPath: string): string {
  // Reject shell metacharacters
  if (CMD_METACHAR_RE.test(rawPath) || /[;`$]/.test(rawPath)) {
    throw new Error(`Upload path contains disallowed characters: ${rawPath}`);
  }

  // Resolve to absolute and normalize (collapses ../ etc.)
  const resolved = resolve(normalize(rawPath));

  // Reject if the resolved path still contains traversal indicators
  if (rawPath.includes("..")) {
    throw new Error(`Upload path must not contain path traversal (..): ${rawPath}`);
  }

  // Verify the file exists
  if (!existsSync(resolved)) {
    throw new Error(`Upload file does not exist: ${resolved}`);
  }

  return resolved;
}

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Build gws CLI arguments from a tool definition and the provided arguments.
 */
function buildArgs(
  tool: ToolDef,
  args: Record<string, unknown>,
): string[] {
  const cliArgs = [...tool.command];

  // Collect --params (query/path parameters)
  const params: Record<string, unknown> = {};
  for (const p of tool.params) {
    if (args[p.name] !== undefined) {
      params[p.name] = args[p.name];
    }
  }
  if (Object.keys(params).length > 0) {
    cliArgs.push("--params", escapeJsonArg(JSON.stringify(params)));
  }

  // Collect --json (request body)
  if (tool.bodyParams && tool.bodyParams.length > 0) {
    const body: Record<string, unknown> = {};
    for (const p of tool.bodyParams) {
      if (args[p.name] !== undefined) {
        let val = args[p.name];
        if (typeof val === "string") {
          try {
            const parsed = JSON.parse(val);
            if (typeof parsed === "object") {
              val = parsed;
            }
          } catch {
            // Keep as string
          }
        }
        body[p.name] = val;
      }
    }
    if (Object.keys(body).length > 0) {
      cliArgs.push("--json", escapeJsonArg(JSON.stringify(body)));
    }
  }

  // File upload — validate path before passing to CLI
  if (tool.supportsUpload && args.uploadPath) {
    const safePath = sanitizeUploadPath(String(args.uploadPath));
    if (process.platform === "win32") {
      cliArgs.push("--upload", escapeForCmd(safePath));
    } else {
      cliArgs.push("--upload", safePath);
    }
  }

  return cliArgs;
}

/**
 * Spawn gws and collect output, enforcing output size limits during
 * accumulation to prevent unbounded memory consumption.
 */
export function spawnGwsRaw(
  gwsBinary: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(gwsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      timeout: 30_000,
    });

    let stdout = "";
    let stderr = "";
    let stdoutLimitReached = false;

    proc.stdout.on("data", (data: Buffer) => {
      if (stdoutLimitReached) return;
      stdout += data.toString();
      if (stdout.length > MAX_OUTPUT) {
        stdoutLimitReached = true;
        stdout = stdout.slice(0, MAX_OUTPUT) + "\n\n[Output truncated]";
      }
    });
    proc.stderr.on("data", (data: Buffer) => {
      // Cap stderr too to prevent memory abuse
      if (stderr.length < MAX_OUTPUT) {
        stderr += data.toString();
      }
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const errorDetail = stderr || stdout || `Process exited with code ${code}`;
        reject(new Error(errorDetail));
      }
    });
  });
}

/**
 * Execute a gws CLI command.
 */
export async function executeGws(
  tool: ToolDef,
  args: Record<string, unknown>,
  gwsBinary: string,
): Promise<ExecResult> {
  const cliArgs = buildArgs(tool, args);

  console.error(`[gws-mcp] Executing: ${gwsBinary} ${cliArgs.join(" ")}`);

  try {
    const { stdout, stderr } = await spawnGwsRaw(gwsBinary, cliArgs);

    if (stderr) {
      console.error(`[gws-mcp] stderr: ${stderr}`);
    }

    return { success: true, output: stdout || "(empty response)" };
  } catch (err: unknown) {
    const error = err as { message?: string };
    const message = error.message || "Unknown error";
    console.error(`[gws-mcp] Error: ${message}`);
    return { success: false, output: "", error: message };
  }
}
