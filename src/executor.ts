/**
 * Executes gws CLI commands and returns results.
 *
 * Argument values are passed directly to the child process on every platform.
 */

import { spawn } from "node:child_process";
import { resolve, normalize, relative, isAbsolute, sep, dirname, basename, join } from "node:path";
import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, realpathSync, statSync, writeFileSync } from "node:fs";
import type { ToolDef } from "./services.js";
import { mapGwsErrorToTyped } from "./errors.js";
import { resolveGwsCommand } from "./windows-binary.js";

/** Max output size before truncation (characters) */
const MAX_OUTPUT = 100_000;

/** Characters disallowed in upload paths */
const UPLOAD_DISALLOWED_RE = /[&|<>^%()!]/;

/**
 * The real path of the directory local file paths must stay inside.
 *
 * Defaults to the server's working directory, which is also where current gws
 * builds confine `--upload` and `-o`.
 */
export function resolveFileRoot(root: string = process.cwd()): string {
  const real = realpathSync.native(resolve(root));
  if (!statSync(real).isDirectory()) {
    throw new Error(`File root is not a directory: ${root}`);
  }
  return real;
}

/**
 * Whether `realPath` sits strictly below `realRoot`. Both must already be real
 * paths. Uses `relative()` rather than a prefix compare, so `/a/root-x` is not
 * inside `/a/root`, and a path on another Windows drive (where `relative()`
 * returns an absolute path) is refused.
 */
export function isInsideRoot(realPath: string, realRoot: string): boolean {
  const rel = relative(realRoot, realPath);
  return !(rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep));
}

/**
 * Validate and sanitize a file upload path.
 * Rejects paths containing shell metacharacters or path traversal sequences,
 * and any file whose real path (symlinks resolved) is outside `root`. A
 * relative path is resolved against `root`. Returns the real path, so a
 * symlink swapped in later is not followed to a new target. gws opens the path
 * itself, so a process that can write inside the root could still swap the file
 * between this check and the upload.
 */
export function sanitizeUploadPath(rawPath: string, root: string = process.cwd()): string {
  // Reject disallowed path characters
  if (UPLOAD_DISALLOWED_RE.test(rawPath) || /[;`$]/.test(rawPath)) {
    throw new Error(`Upload path contains disallowed characters: ${rawPath}`);
  }

  // Reject if the raw path contains traversal indicators
  if (rawPath.includes("..")) {
    throw new Error(`Upload path must not contain path traversal (..): ${rawPath}`);
  }

  const realRoot = resolveFileRoot(root);
  const resolved = resolve(realRoot, normalize(rawPath));

  // Verify the file exists
  if (!existsSync(resolved)) {
    throw new Error(`Upload file does not exist: ${resolved}`);
  }

  const real = realpathSync.native(resolved);
  if (!isInsideRoot(real, realRoot)) {
    throw new Error(
      `Upload path is outside the file root (${realRoot}): ${rawPath}. ` +
        "Move the file under the root, or start the server with --file-root <dir>.",
    );
  }
  // A hard link shares its inode with a file that may live outside the root,
  // and realpath cannot tell. Refuse any file with more than one link.
  const st = statSync(real);
  if (!st.isFile()) {
    throw new Error(`Upload path is not a regular file: ${rawPath}`);
  }
  if (st.nlink > 1) {
    throw new Error(`Upload path is a hard link (${st.nlink} links), so it may alias a file outside the file root: ${rawPath}`);
  }

  return real;
}

/**
 * Validate a local destination for downloaded bytes (`drive_files_download`
 * `savePath`). A relative path resolves against `root`. The parent directory
 * must exist and its real path must be the root or inside it. An existing
 * target must be a regular file with a single link: a symlink or hard link
 * could alias a file outside the root. Returns the path to write.
 */
export function resolveSavePath(rawPath: string, root: string = process.cwd()): string {
  const realRoot = resolveFileRoot(root);
  const target = resolve(realRoot, rawPath);
  const parent = dirname(target);
  if (!existsSync(parent)) {
    throw new Error(`Save directory does not exist: ${parent}`);
  }
  const realParent = realpathSync.native(parent);
  if (realParent !== realRoot && !isInsideRoot(realParent, realRoot)) {
    throw new Error(
      `Save path is outside the file root (${realRoot}): ${rawPath}. ` +
        "Save under the root, or start the server with --file-root <dir>.",
    );
  }
  const final = join(realParent, basename(target));
  let st;
  try {
    st = lstatSync(final);
  } catch {
    return final;
  }
  if (st.isSymbolicLink()) {
    throw new Error(`Save path is a symlink, which may point outside the file root: ${rawPath}`);
  }
  if (!st.isFile()) {
    throw new Error(`Save path exists and is not a regular file: ${rawPath}`);
  }
  if (st.nlink > 1) {
    throw new Error(`Save path is a hard link (${st.nlink} links), so it may alias a file outside the file root: ${rawPath}`);
  }
  return final;
}

/**
 * Write `data` to a path from `resolveSavePath`. A new file is created with
 * O_EXCL, so nothing is created through a symlink swapped in after the check.
 * An existing file is opened without O_CREAT or truncation and re-checked
 * before any byte changes, so a symlink or hard link swapped in is refused.
 * O_NOFOLLOW (not on Windows) also stops the open itself following a symlink.
 */
export function writeSaveFile(path: string, data: Buffer): void {
  const nofollow = constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    fd = openSync(path, constants.O_WRONLY | nofollow);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Save path changed after it was checked and is no longer a plain file: ${path}`);
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, data); // loops until every byte is written; a bare writeSync may stop short
  } finally {
    closeSync(fd);
  }
}

export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Build gws CLI arguments from a tool definition and the provided arguments.
 */
export function buildArgs(
  tool: ToolDef,
  args: Record<string, unknown>,
  fileRoot: string = process.cwd(),
): string[] {
  const cliArgs = [...tool.command];

  // Collect --params (query/path parameters)
  // Start with defaults (e.g. supportsAllDrives), then overlay caller values
  const params: Record<string, unknown> = { ...(tool.defaultParams || {}) };
  for (const p of tool.params) {
    if (args[p.name] !== undefined) {
      params[p.name] = args[p.name];
    }
  }
  if (Object.keys(params).length > 0) {
    cliArgs.push("--params", JSON.stringify(params));
  }

  // Collect --json (request body)
  if (tool.bodyParams && tool.bodyParams.length > 0) {
    const body: Record<string, unknown> = {};
    for (const p of tool.bodyParams) {
      if (args[p.name] !== undefined) {
        let val = args[p.name];
        if (typeof val === "string" && !p.literalString) {
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
      cliArgs.push("--json", JSON.stringify(body));
    }
  }

  // File upload — validate path before passing to CLI
  if (tool.supportsUpload && args.uploadPath) {
    const safePath = sanitizeUploadPath(String(args.uploadPath), fileRoot);
    cliArgs.push("--upload", safePath);
  }

  return cliArgs;
}

/**
 * Pick the text that describes a failed gws run.
 *
 * gws prints a failure as a JSON body on stdout
 * (`{"error":{"code":404,"message":"...","reason":"notFound"}}`) and a
 * one-line `error[api]: <message>` summary on stderr, which carries no status
 * code. Preferring stderr whenever it was non-empty threw the JSON away, so
 * `mapGwsErrorToTyped()` never saw a status and every API failure fell through
 * to the untyped fallback. Use stdout when it is that JSON error body;
 * otherwise keep the old order (stderr, then stdout, then the exit code).
 */
export function failureDetail(stdout: string, stderr: string, code: number | null): string {
  const out = stdout.trim();
  if (out.startsWith("{")) {
    try {
      const parsed = JSON.parse(out) as { error?: unknown };
      if (parsed && typeof parsed.error === "object" && parsed.error !== null) {
        return out;
      }
    } catch {
      // Not JSON (or truncated): fall through to the old order.
    }
  }
  return stderr || stdout || `Process exited with code ${code}`;
}

/**
 * What to tell the user when the gws binary cannot be found. Node's own
 * `spawn gws ENOENT` names neither the package to install nor the setting
 * that points at an installed copy.
 */
export function gwsNotFoundMessage(gwsBinary: string): string {
  return (
    `gws binary "${gwsBinary}" was not found. Install the Google Workspace CLI ` +
    "(npm install -g @googleworkspace/cli) and authenticate it (gws auth setup " +
    "or gws auth login; see the README prerequisites), or set GWS_BINARY or " +
    "--gws-path to the gws binary."
  );
}

/**
 * Spawn gws and collect output, enforcing output size limits during
 * accumulation to prevent unbounded memory consumption.
 */
export function spawnGwsRaw(
  gwsBinary: string,
  args: string[],
  timeoutMs: number = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let command = gwsBinary;
    let childArgs = args;
    if (process.platform === "win32") {
      try {
        const resolved = resolveGwsCommand(gwsBinary);
        command = resolved.command;
        childArgs = [...resolved.prefix, ...args];
      } catch (error) {
        reject(error);
        return;
      }
    }
    const proc = spawn(command, childArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      timeout: timeoutMs,
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

    proc.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new Error(gwsNotFoundMessage(gwsBinary)) : error);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(failureDetail(stdout, stderr, code)));
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
  fileRoot: string = process.cwd(),
): Promise<ExecResult> {
  const cliArgs = buildArgs(tool, args, fileRoot);

  // Log the subcommand only. cliArgs carries --params and --json, which hold
  // the full request body: spreadsheet cell values, inserted document text,
  // grantee email addresses, calendar event details. MCP clients persist
  // stderr to log files, so anything printed here lands on disk indefinitely.
  // SECURITY.md promises nothing is logged beyond tool names and errors.
  if (process.env.GWS_MCP_DEBUG) {
    console.error(`[gws-mcp] Executing: ${gwsBinary} ${cliArgs.join(" ")}`);
  } else {
    console.error(`[gws-mcp] Executing: ${gwsBinary} ${tool.command.join(" ")}`);
  }

  try {
    const { stdout, stderr } = await spawnGwsRaw(gwsBinary, cliArgs);

    if (stderr) {
      console.error(`[gws-mcp] stderr: ${stderr}`);
    }

    return { success: true, output: stdout || "(empty response)" };
  } catch (err: unknown) {
    const error = err as { message?: string };
    const rawMessage = error.message || "Unknown error";

    // Map the raw CLI error text to a typed error (see ./errors.ts). This
    // recovers a status-like code from the text where possible (JSON error
    // body or a plain-text status token) and builds a fully-formatted
    // message — including the Drive shared-drive hint for 404s on drive
    // commands, which used to be appended inline here. Messages with no
    // recognizable status code pass through unchanged (legacy fallback).
    const typedError = mapGwsErrorToTyped(rawMessage, tool.command);

    console.error(`[gws-mcp] Error: ${typedError.message}`);
    return { success: false, output: "", error: typedError.message };
  }
}
