import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolDef } from "../services.js";
import { buildArgs, spawnGwsRaw } from "../executor.js";
import { GwsBinaryConfigurationError, resolveGwsCommand } from "../windows-binary.js";

const windowsIt = process.platform === "win32" ? it : it.skip;
const argvDump = fileURLToPath(new URL("./fixtures/argv-dump.cmd", import.meta.url));

function withNpmShim<T>(run: (shim: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gws-argv-"));
  const script = join(dir, "argv.cjs");
  const shim = join(dir, "gws.cmd");
  writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\nSET "dp0=%~dp0"\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\argv.cjs" %*\r\n');
  return run(shim).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("Windows npm shim argument delivery", () => {
  windowsIt("round-trips arbitrary argument values", async () => {
    await withNpmShim(async (shim) => {
      const values = [
        "&", "|", "<", ">", "^", "%", "!", '"', "\\", "\n", "\t", "R&D", "trailing\\",
        JSON.stringify({ q: 'a & b | < > ^ % ! " \\ \n \t R&D \\' }),
      ];
      const { stdout } = await spawnGwsRaw(shim, values);
      expect(JSON.parse(stdout)).toEqual(values);
      expect(stdout).toBe(JSON.stringify(values));
    });
  });

});

describe("Windows JSON argument delivery", () => {
  windowsIt("preserves literal double quotes in both --json and --params", async () => {
    const tool: ToolDef = {
      name: "calendar_events_insert",
      description: "test",
      command: ["calendar", "events", "insert"],
      params: [
        { name: "calendarId", description: "calendar", type: "string", required: true },
      ],
      bodyParams: [
        { name: "summary", description: "summary", type: "string", required: true },
      ],
    };
    const input = {
      calendarId: 'team "blue" calendar',
      summary: 'Bob "BB" sync',
    };

    const expectedArgs = buildArgs(tool, input);
    const { stdout } = await spawnGwsRaw(argvDump, expectedArgs);
    const childArgs = JSON.parse(stdout) as string[];

    const paramsIndex = childArgs.indexOf("--params");
    const jsonIndex = childArgs.indexOf("--json");
    expect(JSON.parse(childArgs[paramsIndex + 1])).toEqual({
      calendarId: input.calendarId,
    });
    expect(JSON.parse(childArgs[jsonIndex + 1])).toEqual({
      summary: input.summary,
    });
  });

  windowsIt("preserves values ending in a backslash, and keeps one argv entry per flag", async () => {
    const tool: ToolDef = {
      name: "calendar_events_insert",
      description: "test",
      command: ["calendar", "events", "insert"],
      params: [],
      bodyParams: [
        { name: "summary", description: "summary", type: "string", required: true },
        { name: "description", description: "description", type: "string", required: false },
      ],
    };
    const input = { summary: "C:\\Users\\conor\\", description: "two words" };

    const { stdout } = await spawnGwsRaw(argvDump, buildArgs(tool, input));
    const childArgs = JSON.parse(stdout) as string[];

    expect(childArgs).toEqual(["calendar", "events", "insert", "--json", JSON.stringify(input)]);
  });

});

describe("Windows gws binary resolution", () => {
  windowsIt("resolves an npm-style shim to Node and its script", async () => {
    await withNpmShim(async (shim) => {
      expect(resolveGwsCommand(shim)).toEqual({
        command: process.execPath,
        prefix: [join(dirname(shim), "argv.cjs")],
      });
    });
  });

  windowsIt("finds a shim on PATH", async () => {
    await withNpmShim(async (shim) => {
      const previous = process.env.PATH;
      process.env.PATH = `${dirname(shim)};${previous || ""}`;
      try {
        expect(resolveGwsCommand("gws")).toEqual({
          command: process.execPath,
          prefix: [join(dirname(shim), "argv.cjs")],
        });
      } finally {
        if (previous === undefined) delete process.env.PATH;
        else process.env.PATH = previous;
      }
    });
  });

  windowsIt("runs an exe directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-exe-"));
    try {
      const exe = join(dir, "gws.exe");
      writeFileSync(exe, "");
      expect(resolveGwsCommand(exe)).toEqual({ command: exe, prefix: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  windowsIt("reports a typed error for an unavailable binary", async () => {
    const missing = join(tmpdir(), "gws-unavailable", "gws.cmd");
    expect(() => resolveGwsCommand(missing)).toThrow(GwsBinaryConfigurationError);
    await expect(spawnGwsRaw(missing, [])).rejects.toMatchObject({
      code: "GWS_BINARY_CONFIGURATION",
    });
  });

  windowsIt("rejects a shim without a readable JavaScript entry point", () => {
    const dir = mkdtempSync(join(tmpdir(), "gws-shim-"));
    try {
      const shim = join(dir, "gws.cmd");
      writeFileSync(shim, "@ECHO off\r\nexit /b 0\r\n");
      expect(() => resolveGwsCommand(shim)).toThrow(GwsBinaryConfigurationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
