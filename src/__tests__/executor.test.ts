import { describe, it, expect, vi } from "vitest";
import { buildArgs, escapeForCmd, escapeJsonArg, sanitizeUploadPath } from "../executor.js";
import type { ToolDef } from "../services.js";

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
