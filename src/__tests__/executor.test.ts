import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ToolDef } from "../services.js";

// executeGws spawns the gws CLI via node:child_process's spawn(). Mock it so
// the executeGws wiring tests below (error mapping through to ExecResult.error)
// can drive stdout/stderr/close events without a real gws binary.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { buildArgs, escapeForCmd, escapeJsonArg, sanitizeUploadPath, executeGws } from "../executor.js";

/** Minimal fake ChildProcess: an EventEmitter with EventEmitter stdout/stderr. */
function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

// ── escapeForCmd ────────────────────────────────────────────────────────

describe("escapeForCmd", () => {
  it("wraps value in double quotes", () => {
    expect(escapeForCmd("hello")).toBe('"hello"');
  });

  it("escapes cmd.exe metacharacters with ^", () => {
    const input = "a&b|c<d>e^f%g(h)i!j";
    const result = escapeForCmd(input);
    expect(result).toBe('"a^&b^|c^<d^>e^^f^%g^(h^)i^!j"');
  });

  it("escapes inner double quotes with backslash", () => {
    expect(escapeForCmd('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("handles empty string", () => {
    expect(escapeForCmd("")).toBe('""');
  });
});

// ── escapeJsonArg ───────────────────────────────────────────────────────

describe("escapeJsonArg", () => {
  it("returns raw string on non-win32 platforms", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(escapeJsonArg('{"key":"value"}')).toBe('{"key":"value"}');
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("escapes via escapeForCmd on win32", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const result = escapeJsonArg('{"a":"b"}');
      // Should be wrapped in quotes at minimum
      expect(result.startsWith('"')).toBe(true);
      expect(result.endsWith('"')).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

// ── sanitizeUploadPath ──────────────────────────────────────────────────

describe("sanitizeUploadPath", () => {
  it("rejects paths with path traversal (..)", () => {
    expect(() => sanitizeUploadPath("../etc/passwd")).toThrow("path traversal");
  });

  it("rejects paths with cmd.exe metacharacters", () => {
    expect(() => sanitizeUploadPath("file&name.txt")).toThrow("disallowed characters");
  });

  it("rejects paths with shell injection characters", () => {
    expect(() => sanitizeUploadPath("file;name.txt")).toThrow("disallowed characters");
    expect(() => sanitizeUploadPath("file`name.txt")).toThrow("disallowed characters");
    expect(() => sanitizeUploadPath("file$name.txt")).toThrow("disallowed characters");
  });

  it("rejects nonexistent files", () => {
    expect(() => sanitizeUploadPath("/nonexistent/path/to/file.txt")).toThrow("does not exist");
  });
});

// ── buildArgs ───────────────────────────────────────────────────────────

/**
 * Helper to strip Windows cmd.exe escaping from a JSON arg produced by escapeJsonArg.
 * On win32, escapeJsonArg wraps in quotes and escapes metachars with ^.
 */
function unescapeJsonArg(escaped: string): string {
  let s = escaped;
  // Strip surrounding double quotes
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  // Remove ^ escape prefixes for cmd.exe metachars
  s = s.replace(/\^([&|<>^%()!])/g, "$1");
  // Unescape inner \" back to "
  s = s.replace(/\\"/g, '"');
  return s;
}

describe("buildArgs", () => {
  const baseTool: ToolDef = {
    name: "test_tool",
    description: "A test tool",
    command: ["drive", "files", "list"],
    params: [
      { name: "q", description: "query", type: "string", required: false },
      { name: "pageSize", description: "page size", type: "number", required: false },
    ],
  };

  it("starts with the tool command", () => {
    const args = buildArgs(baseTool, {});
    expect(args.slice(0, 3)).toEqual(["drive", "files", "list"]);
  });

  it("merges defaultParams into --params", () => {
    const tool: ToolDef = {
      ...baseTool,
      defaultParams: { supportsAllDrives: true },
    };
    const args = buildArgs(tool, {});
    const paramsIdx = args.indexOf("--params");
    expect(paramsIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(unescapeJsonArg(args[paramsIdx + 1]));
    expect(parsed.supportsAllDrives).toBe(true);
  });

  it("allows caller to override defaultParams", () => {
    const tool: ToolDef = {
      ...baseTool,
      defaultParams: { supportsAllDrives: true },
      params: [
        { name: "supportsAllDrives", description: "override", type: "boolean", required: false },
      ],
    };
    const args = buildArgs(tool, { supportsAllDrives: false });
    const paramsIdx = args.indexOf("--params");
    const parsed = JSON.parse(unescapeJsonArg(args[paramsIdx + 1]));
    expect(parsed.supportsAllDrives).toBe(false);
  });

  it("includes --params with provided arguments", () => {
    const args = buildArgs(baseTool, { q: "name contains 'test'" });
    const paramsIdx = args.indexOf("--params");
    expect(paramsIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(unescapeJsonArg(args[paramsIdx + 1]));
    expect(parsed.q).toBe("name contains 'test'");
  });

  it("includes --json for bodyParams", () => {
    const tool: ToolDef = {
      ...baseTool,
      bodyParams: [
        { name: "name", description: "file name", type: "string", required: true },
      ],
    };
    const args = buildArgs(tool, { name: "myfile.txt" });
    const jsonIdx = args.indexOf("--json");
    expect(jsonIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(unescapeJsonArg(args[jsonIdx + 1]));
    expect(parsed.name).toBe("myfile.txt");
  });

  it("omits --params when no params are provided and no defaults", () => {
    const tool: ToolDef = {
      ...baseTool,
      params: [],
      defaultParams: undefined,
    };
    const args = buildArgs(tool, {});
    expect(args.includes("--params")).toBe(false);
  });

  it("omits --json when no bodyParams values are provided", () => {
    const tool: ToolDef = {
      ...baseTool,
      bodyParams: [
        { name: "title", description: "doc title", type: "string", required: false },
      ],
    };
    const args = buildArgs(tool, {});
    expect(args.includes("--json")).toBe(false);
  });
});

// ── executeGws (typed-error wiring) ──────────────────────────────────────
//
// These drive the actual executeGws() catch block (see ../executor.ts) end
// to end via a mocked child_process.spawn, rather than just unit-testing
// the mapper in ../errors.ts — confirming the wiring itself, not only the
// pure function it calls.

describe("executeGws", () => {
  const driveTool: ToolDef = {
    name: "drive_files_get",
    description: "test",
    command: ["drive", "files", "get"],
    params: [],
  };

  const sheetsTool: ToolDef = {
    name: "sheets_get",
    description: "test",
    command: ["sheets", "spreadsheets", "get"],
    params: [],
  };

  it("maps a CLI error with a JSON-embedded status to a typed error message", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(sheetsTool, {}, "gws");
    proc.stderr.emit("data", Buffer.from('{"error":{"code":429,"message":"Quota exceeded"}}'));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit error (429)");
    expect(result.error).toContain("Quota exceeded");
  });

  it("maps a plain-text status token and appends the Drive 404 hint for drive commands", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(driveTool, {}, "gws");
    proc.stderr.emit("data", Buffer.from("googleapi: Error 404: File not found: abc123"));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not found (404)");
    expect(result.error).toContain("Hint: If this file is in a shared drive");
  });

  it("does not append the Drive hint for a 404 on a non-drive command", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(sheetsTool, {}, "gws");
    proc.stderr.emit("data", Buffer.from("googleapi: Error 404: Spreadsheet not found: abc123"));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.error).toContain("Not found (404)");
    expect(result.error).not.toContain("Hint:");
  });

  it("passes a message with no recognizable status through unchanged (legacy fallback)", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(driveTool, {}, "gws");
    proc.stderr.emit("data", Buffer.from("connect ECONNREFUSED 127.0.0.1:443"));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("connect ECONNREFUSED 127.0.0.1:443");
  });

  it("returns success with stdout when the process exits 0", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(driveTool, {}, "gws");
    proc.stdout.emit("data", Buffer.from('{"id": "abc123"}'));
    proc.emit("close", 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('{"id": "abc123"}');
    expect(result.error).toBeUndefined();
  });
});
