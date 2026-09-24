import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { ToolDef } from "../services.js";
import { buildArgs, spawnGwsRaw } from "../executor.js";

const windowsIt = process.platform === "win32" ? it : it.skip;
const argvDump = fileURLToPath(new URL("./fixtures/argv-dump.cmd", import.meta.url));

// The escapeForCmd implementation before #37. Keeping it in this Windows-only
// regression test proves the fixture reaches the exact known-bad child argv;
// it must never be used by production code.
function legacyEscapeForCmd(value: string): string {
  return `"${value
    .replace(/[&|<>^%()!]/g, "^$&")
    .replace(/"/g, '\\"')}"`;
}

describe("Windows cmd.exe JSON argument round-trip", () => {
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

  // JSON.stringify turns a value ending in a backslash into `\\"`: a run of
  // two backslashes before the closing quote. The whole run has to be doubled;
  // doubling only the last backslash let the child read that quote as a real
  // closing quote, so the JSON arrived truncated and later fields split into
  // separate argv entries. Asserting the full argv pins both halves.
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

  windowsIt("reproduces the pre-fix corrupted child argv as a negative control", async () => {
    const json = JSON.stringify({ summary: 'Bob "BB" sync' });
    const { stdout } = await spawnGwsRaw(argvDump, [
      "--json",
      legacyEscapeForCmd(json),
    ]);
    const childArgs = JSON.parse(stdout) as string[];
    const corrupted = childArgs[1];

    expect(corrupted).toBe('{"summary":"Bob \\BB\\ sync"}');
    expect(() => JSON.parse(corrupted)).toThrow();
  });
});
