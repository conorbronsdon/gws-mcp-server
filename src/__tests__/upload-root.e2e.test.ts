/**
 * uploadPath through a real MCP client: createServer's file root reaches the
 * executor, an in-root file is uploaded by its real path, and an out-of-root
 * file (for example a credential file) never reaches gws.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, parseArgs } from "../index.js";
import { getToolsForServices } from "../services.js";

let base: string;
let root: string;
let bin: string;
let marker: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "gws-upload-e2e-")));
  root = join(base, "root");
  mkdirSync(root);
  mkdirSync(join(base, "outside"));
  writeFileSync(join(root, "report.txt"), "example");
  writeFileSync(join(base, "outside", "example-credentials.json"), "{}");
  // A fake gws that records that it ran, then echoes its argv.
  marker = join(base, "ran");
  bin = join(base, "gws.cjs");
  writeFileSync(
    bin,
    "#!/usr/bin/env node\n" +
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n` +
      readFileSync(fileURLToPath(new URL("./fixtures/argv-dump.cjs", import.meta.url)), "utf-8"),
  );
  chmodSync(bin, 0o755);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function upload(uploadPath: string) {
  rmSync(marker, { force: true });
  const server = createServer(getToolsForServices(["drive"]), ["drive"], bin, true, false, root);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "upload-root-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: "drive_files_create", arguments: { name: "example", uploadPath } });
  let ran = false;
  try { ran = readFileSync(marker, "utf-8") === "1"; } catch { /* gws never ran */ }
  return { isError: result.isError, text: (result.content as Array<{ text: string }>)[0].text, ran };
}

describe("drive_files_create uploadPath file root", () => {
  it("uploads a file inside the file root by its real path", async () => {
    const res = await upload(join(root, "report.txt"));
    expect(res.isError, res.text).toBeFalsy();
    expect(res.ran).toBe(true);
    const argv = JSON.parse(res.text) as string[];
    expect(argv[argv.indexOf("--upload") + 1]).toBe(realpathSync.native(join(root, "report.txt")));
  });

  it("refuses a credential file outside the file root without running gws", async () => {
    const res = await upload(join(base, "outside", "example-credentials.json"));
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the file root");
    expect(res.ran).toBe(false);
  });
});

describe("drive_files_create uploadPath with an unresolvable file root", () => {
  it("returns a tool error for the call and does not run gws", async () => {
    rmSync(marker, { force: true });
    const server = createServer(getToolsForServices(["drive"]), ["drive"], bin, true, false, join(base, "gone"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "upload-root-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "drive_files_create", arguments: { name: "example", uploadPath: "report.txt" } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("File root is not accessible");
    expect(text).toContain(join(base, "gone"));
    for (const raw of ["ENOENT", "EACCES", "realpath"]) expect(text).not.toContain(raw);
    let ran = false;
    try { ran = readFileSync(marker, "utf-8") === "1"; } catch { /* gws never ran */ }
    expect(ran).toBe(false);
  });
});

describe("--file-root at startup", () => {
  function exitOf(args: string[]) {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      parseArgs(args);
      return { code: undefined, stderr: "" };
    } catch (e) {
      return { code: (e as Error).message, stderr: err.mock.calls.map((c) => c.join(" ")).join("\n") };
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  }

  it("exits 1 naming the flag and the value for a missing directory", () => {
    const bad = join(base, "no-such-dir");
    const r = exitOf(["--file-root", bad]);
    expect(r.code).toBe("exit 1");
    expect(r.stderr).toContain("--file-root");
    expect(r.stderr).toContain(JSON.stringify(bad));
  });

  it("exits 1 for a file that is not a directory", () => {
    const r = exitOf(["--file-root", join(root, "report.txt")]);
    expect(r.code).toBe("exit 1");
    expect(r.stderr).toContain("not a directory");
  });

  it("control: resolves a valid --file-root and the default to real paths", () => {
    expect(parseArgs(["--file-root", root]).fileRoot).toBe(realpathSync.native(root));
    expect(parseArgs([]).fileRoot).toBe(realpathSync.native(process.cwd()));
  });
});
