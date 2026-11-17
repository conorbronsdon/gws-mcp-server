import { afterAll, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { ToolDef } from "../services.js";

// executeGws spawns the gws CLI via node:child_process's spawn(). Mock it so
// the executeGws wiring tests below (error mapping through to ExecResult.error)
// can drive stdout/stderr/close events without a real gws binary.
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { buildArgs, sanitizeUploadPath, isInsideRoot, executeGws, gwsNotFoundMessage, spawnGwsRaw } from "../executor.js";
import { GwsBinaryConfigurationError, resolveGwsCommand } from "../windows-binary.js";

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

describe("isInsideRoot", () => {
  const r = join(tmpdir(), "gws-root");
  it("is true only for paths strictly below the root", () => {
    expect(isInsideRoot(join(r, "a.txt"), r)).toBe(true);
    expect(isInsideRoot(join(r, "sub", "a.txt"), r)).toBe(true);
    expect(isInsideRoot(r, r)).toBe(false);
    expect(isInsideRoot(r + sep, r)).toBe(false);
    expect(isInsideRoot(`${r}-sibling${sep}a.txt`, r)).toBe(false);
    expect(isInsideRoot(join(r, "..", "a.txt"), r)).toBe(false);
    expect(isInsideRoot(dirname(r), r)).toBe(false);
  });

  it.runIf(process.platform === "win32")("is false for a path on another drive", () => {
    expect(isInsideRoot("D:\\root\\a.txt", "C:\\root")).toBe(false);
  });
});

describe("sanitizeUploadPath file root", () => {
  // Layout: <base>/root is the file root; <base>/root-sibling and <base>/outside
  // sit next to it. The sibling shares the root's string prefix.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gws-upload-root-")));
  const root = join(base, "root");
  const outside = join(base, "outside");
  const sibling = join(base, "root-sibling");
  for (const d of [root, join(root, "sub"), outside, sibling]) mkdirSync(d, { recursive: true });
  const inRoot = join(root, "sub", "report.txt");
  const secret = join(outside, "example-client_secret.json");
  const siblingFile = join(sibling, "file.txt");
  for (const f of [inRoot, secret, siblingFile]) writeFileSync(f, "example");
  const uploadTool: ToolDef = {
    name: "drive_files_create", description: "", command: ["drive", "files", "create"],
    params: [], supportsUpload: true,
  };

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("accepts an absolute path inside the root and returns its real path", () => {
    expect(sanitizeUploadPath(inRoot, root)).toBe(realpathSync.native(inRoot));
  });

  it("refuses an absolute path outside the root", () => {
    expect(() => sanitizeUploadPath(secret, root)).toThrow("outside the file root");
  });

  it("refuses a directory that only shares the root's name prefix", () => {
    expect(() => sanitizeUploadPath(siblingFile, root)).toThrow("outside the file root");
  });

  it("refuses the root directory itself", () => {
    expect(() => sanitizeUploadPath(root, root)).toThrow("outside the file root");
  });

  it("resolves a relative path against the root, not the server's working directory", () => {
    expect(sanitizeUploadPath(join("sub", "report.txt"), root)).toBe(realpathSync.native(inRoot));
    expect(() => sanitizeUploadPath(relative(root, secret), root)).toThrow();
  });

  it("defaults the root to the working directory", () => {
    expect(() => sanitizeUploadPath(secret)).toThrow("outside the file root");
    expect(sanitizeUploadPath("package.json")).toBe(realpathSync.native(join(process.cwd(), "package.json")));
  });

  it("refuses a hard link inside the root to a file outside it", () => {
    const link = join(root, "hardlink.json");
    linkSync(secret, link);
    expect(() => sanitizeUploadPath(link, root)).toThrow("hard link");
  });

  it("also refuses a file hard-linked twice inside the root, since nlink cannot see where the other name is", () => {
    const original = join(root, "twice.txt");
    writeFileSync(original, "in root");
    linkSync(original, join(root, "twice-copy.txt"));
    expect(() => sanitizeUploadPath(original, root)).toThrow("hard link");
  });

  it("buildArgs passes the checked real path to --upload and refuses an out-of-root path", () => {
    expect(buildArgs(uploadTool, { uploadPath: inRoot }, root)).toEqual([
      "drive", "files", "create", "--upload", realpathSync.native(inRoot),
    ]);
    expect(() => buildArgs(uploadTool, { uploadPath: secret }, root)).toThrow("outside the file root");
  });

  // Symlink creation needs a privilege on Windows (WinError 1314 / EPERM), so
  // these skip there when the link cannot be made.
  function trySymlink(target: string, path: string, type?: "dir" | "file"): boolean {
    try { symlinkSync(target, path, type); return true; } catch { return false; }
  }

  it("refuses a symlink inside the root that points outside it", (ctx) => {
    const link = join(root, "link-to-secret.json");
    if (!trySymlink(secret, link, "file")) ctx.skip();
    expect(() => sanitizeUploadPath(link, root)).toThrow("outside the file root");
  });

  it("refuses a path through a symlinked directory that points outside", (ctx) => {
    const link = join(root, "dirlink");
    if (!trySymlink(outside, link, "dir")) ctx.skip();
    expect(() => sanitizeUploadPath(join(link, "example-client_secret.json"), root)).toThrow("outside the file root");
  });

  it("accepts a symlink inside the root that points to another file inside it", (ctx) => {
    const link = join(root, "link-to-report.txt");
    if (!trySymlink(inRoot, link, "file")) ctx.skip();
    expect(sanitizeUploadPath(link, root)).toBe(realpathSync.native(inRoot));
  });

  it("accepts files under a root given as a symlink to the real directory", (ctx) => {
    const rootLink = join(base, "root-link");
    if (!trySymlink(root, rootLink, "dir")) ctx.skip();
    expect(sanitizeUploadPath(inRoot, rootLink)).toBe(realpathSync.native(inRoot));
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

  it("names the package to install and GWS_BINARY when the binary is missing (ENOENT)", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const pending = spawnGwsRaw(mockGws, []);
    proc.emit("error", Object.assign(new Error("spawn gws ENOENT"), { code: "ENOENT" }));
    await expect(pending).rejects.toThrow(gwsNotFoundMessage(mockGws));
    expect(gwsNotFoundMessage("gws")).toBe(
      'gws binary "gws" was not found. Install the Google Workspace CLI ' +
        "(npm install -g @googleworkspace/cli) and authenticate it (gws auth setup " +
        "or gws auth login; see the README prerequisites), or set GWS_BINARY or " +
        "--gws-path to the gws binary.",
    );
  });

  it("passes other spawn errors through unchanged", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const pending = spawnGwsRaw(mockGws, []);
    const eacces = Object.assign(new Error("spawn gws EACCES"), { code: "EACCES" });
    proc.emit("error", eacces);
    await expect(pending).rejects.toBe(eacces);
  });

  it("names the package to install when the Windows resolver cannot find the binary", () => {
    // resolveGwsCommand is the Windows startup and spawn path; its lookup is plain fs, so this runs everywhere.
    const missing = join(tmpdir(), "gws-missing-install-hint", "gws.cmd");
    expect(() => resolveGwsCommand(missing)).toThrow(GwsBinaryConfigurationError);
    expect(() => resolveGwsCommand(missing)).toThrow(/npm install -g @googleworkspace\/cli/);
    expect(() => resolveGwsCommand(missing)).toThrow(/GWS_BINARY or --gws-path/);
  });

  it("executeGws returns the not-found message as the tool error", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
    const pending = executeGws(
      { name: "drive_files_list", description: "test", command: ["drive", "files", "list"], params: [] },
      {},
      // A file that exists, so Windows resolution succeeds and the spawn mock is reached.
      // This exercises the ENOENT handler only; a missing binary on Windows is caught
      // earlier by resolveGwsCommand (see the Windows resolver test above).
      mockGws,
    );
    proc.emit("error", Object.assign(new Error("spawn gws ENOENT"), { code: "ENOENT" }));
    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toBe(gwsNotFoundMessage(mockGws));
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

  // What gws actually prints on an API failure (gws src/error.rs,
  // print_error_json): the JSON body on stdout, a status-free one-line summary
  // on stderr, exit code 1.
  const GWS_404_STDOUT = JSON.stringify(
    { error: { code: 404, message: "File not found: example-file-id", reason: "notFound" } },
    null,
    2,
  ) + "\n";
  const GWS_404_STDERR = "error[api]: File not found: example-file-id\n";

  it("maps gws's real failure shape (JSON on stdout, summary on stderr) to a typed error", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(driveTool, {}, mockGws);
    proc.stdout.emit("data", Buffer.from(GWS_404_STDOUT));
    proc.stderr.emit("data", Buffer.from(GWS_404_STDERR));
    proc.emit("close", 1);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Not found (404): File not found: example-file-id.\n\nHint: If this file is in a shared drive, ensure supportsAllDrives is set (this should be automatic). Check that the file ID is correct and the authenticated account has access.",
    );
  });

  it("maps gws's auth failure (exit 2, code 401 on stdout) to an authentication error", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const resultPromise = executeGws(sheetsTool, {}, mockGws);
    proc.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ error: { code: 401, message: "example-token expired", reason: "authError" } })),
    );
    proc.stderr.emit("data", Buffer.from("error[auth]: example-token expired\n"));
    proc.emit("close", 2);

    const result = await resultPromise;
    expect(result.error).toBe(
      'Authentication error (401): example-token expired. Check that the gws CLI is authenticated ("gws auth login") and that the credentials have access to the requested Google Workspace resource.',
    );
  });

  it("rejects spawnGwsRaw with the stdout JSON body, not the stderr summary", async () => {
    const proc = makeFakeProc();
    vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const pending = spawnGwsRaw(mockGws, []);
    proc.stdout.emit("data", Buffer.from(GWS_404_STDOUT));
    proc.stderr.emit("data", Buffer.from(GWS_404_STDERR));
    proc.emit("close", 1);

    await expect(pending).rejects.toThrow(new Error(GWS_404_STDOUT.trim()));
  });

  it("still prefers stderr when stdout is not a JSON error body", async () => {
    // Must-not-fire: a non-error JSON object or plain text on stdout keeps the
    // old stderr-first order.
    for (const stdout of ['{"id":"example-file-id"}', "partial output"]) {
      const proc = makeFakeProc();
      vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

      const resultPromise = executeGws(driveTool, {}, mockGws);
      proc.stdout.emit("data", Buffer.from(stdout));
      proc.stderr.emit("data", Buffer.from("connect ECONNREFUSED 127.0.0.1:443"));
      proc.emit("close", 1);

      const result = await resultPromise;
      expect(result.error).toBe("connect ECONNREFUSED 127.0.0.1:443");
    }
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
