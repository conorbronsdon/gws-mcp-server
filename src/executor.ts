/**
 * Executes gws CLI commands and returns results.
 *
 * Windows challenge: gws is an npm global (.cmd wrapper) which requires
 * shell:true to spawn, but cmd.exe mangles JSON in arguments. Solution:
 * wrap JSON args in double quotes with escaped inner quotes for cmd.exe.
 */

import { spawn } from "node:child_process";
import type { ToolDef } from "./services.js";

/** Max output size before truncation (characters) */
const MAX_OUTPUT = 100_000;

/**
 * Escape a JSON string for passing as a CLI argument.
 * On Windows with shell:true, cmd.exe splits on spaces unless the arg is
 * wrapped in double quotes. Inner double quotes must be escaped with backslash.
 */
function escapeJsonArg(json: string): string {
  if (process.platform === "win32") {
    return '"' + json.replace(/"/g, '\\"') + '"';
  }
  return json;
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

  // File upload
  if (tool.supportsUpload && args.uploadPath) {
    cliArgs.push("--upload", String(args.uploadPath));
  }

  return cliArgs;
}

/**
 * Spawn gws and collect output.
 */
function spawnGws(
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

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
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
    const { stdout, stderr } = await spawnGws(gwsBinary, cliArgs);

    let output = stdout;
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + "\n\n[Output truncated]";
    }

    if (stderr) {
      console.error(`[gws-mcp] stderr: ${stderr}`);
    }

    return { success: true, output };
  } catch (err: unknown) {
    const error = err as { message?: string };
    const message = error.message || "Unknown error";
    console.error(`[gws-mcp] Error: ${message}`);
    return { success: false, output: "", error: message };
  }
}
