import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { ToolDef } from "../services.js";

// executeGws spawns the gws CLI via node:child_process's spawn(). Mock it so
// the executeGws wiring tests below (error mapping through to ExecResult.error)
// can drive stdout/stderr/close events without a real gws binary.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { buildArgs, sanitizeUploadPath, executeGws, spawnGwsRaw } from "../executor.js";
import { GwsBinaryConfigurationError } from "../windows-binary.js";

const mockGws = fileURLToPath(new URL("./fixtures/argv-dump.cjs", import.meta.url));

/** Minimal fake ChildProcess with stdout and stderr emitters. */
function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

describe("sanitizeUploadPath", () => {
  it("rejects path traversal", () => {
    expect(() => sanitizeUploadPath("../etc/passwd")).toThrow("path traversal");
  });

  it("rejects disallowed upload path characters", () => {
    for (const path of ["file&name.txt", "file;name.txt", "file`name.txt", "file$name.txt"]) {
      expect(() => sanitizeUploadPath(path)).toThrow("disallowed characters");
    }
  });

  it("rejects nonexistent files", () => {
    expect(() => sanitizeUploadPath("/nonexistent/path/to/file.txt")).toThrow("does not exist");
  });
});

describe("spawnGwsRaw", () => {
  it("passes argument values directly with the shell disabled", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const value = 'R&D "quoted" \\';
    const pending = spawnGwsRaw(mockGws, [value]);
    const expectedArgs = process.platform === "win32" ? [mockGws, value] : [value];
    const expectedCommand = process.platform === "win32" ? process.execPath : mockGws;
    expect(spawn).toHaveBeenLastCalledWith(expectedCommand, expectedArgs, expect.objectContaining({ shell: false }));
    proc.emit("close", 0);
    await expect(pending).resolves.toEqual({ stdout: "", stderr: "" });
  });

  it.skipIf(process.platform !== "win32")("rejects an unavailable binary before spawning", async () => {
    vi.mocked(spawn).mockClear();
    await expect(spawnGwsRaw(mockGws + ".missing.cmd", [])).rejects.toBeInstanceOf(GwsBinaryConfigurationError);
    expect(spawn).not.toHaveBeenCalled();
  });
});

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

  it("keeps JSON parameter text unchanged", () => {
    const value = 'R&D "quoted" \\';
    const args = buildArgs(baseTool, { q: value });
    expect(args[args.indexOf("--params") + 1]).toBe(JSON.stringify({ q: value }));
  });

  it("merges defaultParams into --params", () => {
    const tool: ToolDef = {
      ...baseTool,
      defaultParams: { supportsAllDrives: true },
    };
    const args = buildArgs(tool, {});
    const paramsIdx = args.indexOf("--params");
    expect(paramsIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(args[paramsIdx + 1]);
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
    const parsed = JSON.parse(args[paramsIdx + 1]);
    expect(parsed.supportsAllDrives).toBe(false);
  });

  it("includes --params with provided arguments", () => {
    const args = buildArgs(baseTool, { q: "name contains 'test'" });
    const paramsIdx = args.indexOf("--params");
    expect(paramsIdx).toBeGreaterThan(-1);
    const parsed = JSON.parse(args[paramsIdx + 1]);
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
    const parsed = JSON.parse(args[jsonIdx + 1]);
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

  // Drive types a comment's `anchor` as a string that happens to hold JSON.
  // Without literalString, buildArgs decoded it and sent an object, which the
  // API rejects — so the documented usage of drive_comments_create's anchor
  // could never succeed.
  it("sends a literalString body param as the string it is", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const tool: ToolDef = {
        ...baseTool,
        bodyParams: [
          { name: "anchor", description: "region", type: "string", required: false, literalString: true },
          { name: "requests", description: "array", type: "string", required: false },
        ],
      };
      const args = buildArgs(tool, { anchor: '{"line":10}', requests: '[{"a":1}]' });
      const body = JSON.parse(args[args.indexOf("--json") + 1]);
      expect(body.anchor).toBe('{"line":10}');
      // Negative control: an ordinary string param is still decoded.
      expect(body.requests).toEqual([{ a: 1 }]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
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

    const resultPromise = executeGws(sheetsTool, {}, mockGws);
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

    const resultPromise = executeGws(driveTool, {}, mockGws);
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

    const resultPromise = executeGws(sheetsTool, {}, mockGws);
    proc.stderr.emit("data", Buffer.from("googleapi: Error 404: Spreadsheet not found: abc123"));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.error).toContain("Not found (404)");
    expect(result.error).not.toContain("Hint:");
  });

  it("passes a message with no recognizable status through unchanged (legacy fallback)", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(driveTool, {}, mockGws);
    proc.stderr.emit("data", Buffer.from("connect ECONNREFUSED 127.0.0.1:443"));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe("connect ECONNREFUSED 127.0.0.1:443");
  });

  it("returns success with stdout when the process exits 0", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(driveTool, {}, mockGws);
    proc.stdout.emit("data", Buffer.from('{"id": "abc123"}'));
    proc.emit("close", 0);

    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.output).toBe('{"id": "abc123"}');
    expect(result.error).toBeUndefined();
  });
});

// ── Request bodies must not reach the logs ──────────────────────────────
// SECURITY.md: "nothing is logged beyond tool names and errors." That was a
// prose promise with no mechanism; executeGws logged the full command line,
// including --params and --json. MCP clients persist stderr to disk.

describe("executeGws logging", () => {
  const sheetsUpdate: ToolDef = {
    name: "sheets_values_update",
    description: "test",
    command: ["sheets", "spreadsheets", "values", "update"],
    params: [{ name: "spreadsheetId", description: "id", type: "string", required: true }],
    bodyParams: [{ name: "values", description: "values", type: "string", required: false }],
  };

  const SECRET_ID = "SHEET_ID_THAT_MUST_NOT_BE_LOGGED";
  const SECRET_BODY = "555-01-9999";

  async function runAndCaptureLogs(): Promise<string> {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const p = executeGws(
        sheetsUpdate,
        { spreadsheetId: SECRET_ID, values: SECRET_BODY },
        mockGws,
      );
      proc.stdout.emit("data", Buffer.from("{}"));
      proc.emit("close", 0);
      await p;
      return lines.join("\n");
    } finally {
      spy.mockRestore();
    }
  }

  it("logs the subcommand but neither the params nor the request body", async () => {
    delete process.env.GWS_MCP_DEBUG;
    const logged = await runAndCaptureLogs();

    // The operation is still identifiable...
    expect(logged).toContain("sheets spreadsheets values update");
    // ...but the caller's data is not in it.
    expect(logged).not.toContain(SECRET_ID);
    expect(logged).not.toContain(SECRET_BODY);
    expect(logged).not.toContain("--params");
    expect(logged).not.toContain("--json");
  });

  it("logs the full command line when GWS_MCP_DEBUG is set", async () => {
    // Asserted so the test above cannot pass merely because nothing is logged.
    process.env.GWS_MCP_DEBUG = "1";
    try {
      const logged = await runAndCaptureLogs();
      expect(logged).toContain(SECRET_ID);
      expect(logged).toContain("--json");
    } finally {
      delete process.env.GWS_MCP_DEBUG;
    }
  });
});
