import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

export class GwsBinaryConfigurationError extends Error {
  readonly code = "GWS_BINARY_CONFIGURATION";

  constructor(binary: string, detail: string) {
    super(`Cannot run gws binary "${binary}": ${detail}. Set GWS_BINARY or --gws-path to a gws JavaScript entry point or .exe.`);
    this.name = "GwsBinaryConfigurationError";
  }
}

export interface GwsCommand {
  command: string;
  prefix: string[];
}

const resolvedCommands = new Map<string, GwsCommand>();

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findBinary(binary: string): string | undefined {
  const extensions = [".exe", ".cmd", ".bat", ".js", ".cjs", ".mjs"];
  const candidates = extname(binary) ? [binary] : extensions.map((ext) => binary + ext);
  const explicit = isAbsolute(binary) || /[\\/]/.test(binary);
  const dirs = explicit ? [""] : (process.env.PATH || "")
        .split(delimiter)
        .map((dir) => dir.replace(/^"(.*)"$/, "$1"))
        .filter((dir) => dir && isAbsolute(dir));

  for (const dir of dirs) {
    for (const candidate of candidates) {
      const path = explicit ? resolve(candidate) : join(dir, candidate);
      if (isFile(path)) return path;
    }
  }
  return undefined;
}

function scriptFromShim(shim: string): string | undefined {
  let contents: string;
  try {
    contents = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  const match = contents.match(/"((?:%~dp0|%dp0%)[^"\r\n]*?\.(?:cjs|mjs|js))"\s+%\*/i);
  if (!match) return undefined;
  const relative = match[1].replace(/^(?:%~dp0|%dp0%)[\\/]*/i, "");
  const script = resolve(dirname(shim), relative.replace(/\\/g, "/"));
  return isFile(script) ? script : undefined;
}

export function resolveGwsCommand(binary: string): GwsCommand {
  const cached = resolvedCommands.get(binary);
  if (cached) return cached;

  const path = findBinary(binary);
  if (!path) throw new GwsBinaryConfigurationError(binary, "file not found");

  let command: GwsCommand;
  switch (extname(path).toLowerCase()) {
    case ".exe":
      command = { command: path, prefix: [] };
      break;
    case ".js":
    case ".cjs":
    case ".mjs":
      command = { command: process.execPath, prefix: [path] };
      break;
    case ".cmd":
    case ".bat": {
      const script = scriptFromShim(path);
      if (!script) throw new GwsBinaryConfigurationError(binary, "npm shim entry point could not be read");
      command = { command: process.execPath, prefix: [script] };
      break;
    }
    default:
      throw new GwsBinaryConfigurationError(binary, "unsupported file type");
  }

  resolvedCommands.set(binary, command);
  return command;
}
