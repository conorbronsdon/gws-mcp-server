/**
 * drive_files_download through a real MCP client and a fake gws binary.
 *
 * The tool decides between returning text inline and saving bytes from the
 * MIME type of what it actually downloaded. For a Google-native file that is
 * the export format, not the Drive MIME type: a Drawing exports to PNG by
 * default, and a Doc can be exported to PDF on request.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../index.js";
import { getToolsForServices } from "../services.js";

// Bytes that are not valid UTF-8: a PNG signature and a 0xFF run.
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80]);

let dir: string;
let bin: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-gws-drive-"));
  bin = join(dir, "gws.cjs");
  copyFileSync(fileURLToPath(new URL("./fixtures/fake-gws-drive.cjs", import.meta.url)), bin);
  chmodSync(bin, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_DRIVE_META;
  delete process.env.FAKE_DRIVE_CONTENT;
});

async function download(
  meta: Record<string, unknown>,
  content: Buffer,
  args: Record<string, unknown>,
  fileRoot: string | undefined = dir,
) {
  process.env.FAKE_DRIVE_META = JSON.stringify(meta);
  process.env.FAKE_DRIVE_CONTENT = content.toString("base64");
  const server = createServer(getToolsForServices(["drive"]), ["drive"], bin, true, false, fileRoot);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "download-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: "drive_files_download", arguments: args });
  return { isError: result.isError, text: (result.content as Array<{ text: string }>)[0].text };
}

describe("drive_files_download", () => {
  it("saves a Google Drawing's default PNG export byte-for-byte to savePath", async () => {
    const savePath = join(dir, "drawing.png");
    const res = await download(
      { mimeType: "application/vnd.google-apps.drawing", name: "example-drawing" },
      BINARY,
      { fileId: "example-file-id", savePath },
    );
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(savePath).equals(BINARY)).toBe(true);
  });

  it("saves a Google Doc exported to PDF byte-for-byte to savePath", async () => {
    const savePath = join(dir, "doc.pdf");
    const res = await download(
      { mimeType: "application/vnd.google-apps.document", name: "example-doc" },
      BINARY,
      { fileId: "example-file-id", exportMimeType: "application/pdf", savePath },
    );
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(savePath).equals(BINARY)).toBe(true);
  });

  it("saves an uploaded .docx (an Office Open XML zip, not XML text) byte-for-byte", async () => {
    const savePath = join(dir, "report.docx");
    const res = await download(
      { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", name: "example.docx" },
      BINARY,
      { fileId: "example-file-id", savePath },
    );
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(savePath).equals(BINARY)).toBe(true);
  });

  it("saves a Google Sheet exported to xlsx byte-for-byte to savePath", async () => {
    const savePath = join(dir, "sheet.xlsx");
    const res = await download(
      { mimeType: "application/vnd.google-apps.spreadsheet", name: "example-sheet" },
      BINARY,
      { fileId: "example-file-id", exportMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", savePath },
    );
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(savePath).equals(BINARY)).toBe(true);
  });

  it("still returns JSON and SVG files inline as text", async () => {
    for (const mimeType of ["application/json", "image/svg+xml"]) {
      const res = await download({ mimeType, name: "example" }, Buffer.from("<example/>", "utf-8"), { fileId: "example-file-id" });
      expect(res.isError, res.text).toBeFalsy();
      expect(res.text).toBe("<example/>");
    }
  });

  it("still returns a Google Doc's default text/plain export inline", async () => {
    const res = await download(
      { mimeType: "application/vnd.google-apps.document", name: "example-doc" },
      Buffer.from("example document text", "utf-8"),
      { fileId: "example-file-id" },
    );
    expect(res.isError, res.text).toBeFalsy();
    expect(res.text).toBe("example document text");
  });
});

describe("drive_files_download savePath file root", () => {
  const PNG = { mimeType: "image/png", name: "example.png" };
  const ORIGINAL = Buffer.from("example original credential bytes");
  let root: string;
  let outside: string;
  let victim: string;

  beforeAll(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "gws-save-root-")));
    root = join(base, "root");
    outside = join(base, "outside");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside);
    mkdirSync(join(base, "root-sibling"));
    victim = join(outside, "example-client_secret.json");
  });

  beforeEach(() => writeFileSync(victim, ORIGINAL));

  function victimUntouched() {
    expect(readFileSync(victim).equals(ORIGINAL)).toBe(true);
  }

  it("saves inside the file root, including into a subdirectory", async () => {
    const savePath = join(root, "sub", "out.png");
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath }, root);
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(savePath).equals(BINARY)).toBe(true);
  });

  it("resolves a relative savePath against the file root", async () => {
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: "relative.png" }, root);
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(join(root, "relative.png")).equals(BINARY)).toBe(true);
  });

  it("still overwrites an existing regular file inside the root", async () => {
    const savePath = join(root, "again.png");
    writeFileSync(savePath, "old");
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath }, root);
    expect(res.isError, res.text).toBeFalsy();
    expect(readFileSync(savePath).equals(BINARY)).toBe(true);
  });

  it("refuses to overwrite a credential file outside the root", async () => {
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: victim }, root);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the file root");
    victimUntouched();
  });

  it("refuses a new file outside the root, a name-prefix sibling, and ../ escapes", async () => {
    for (const savePath of [
      join(outside, "new.png"),
      join(root + "-sibling", "new.png"),
      join("..", "outside", "new.png"),
      join(root, "sub", "..", "..", "outside", "new.png"),
    ]) {
      const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath }, root);
      expect(res.isError, savePath).toBe(true);
      expect(res.text, savePath).toContain("outside the file root");
    }
    expect(existsSync(join(outside, "new.png"))).toBe(false);
    expect(existsSync(join(root + "-sibling", "new.png"))).toBe(false);
  });

  it("refuses a hard link inside the root to a file outside it", async () => {
    const link = join(root, "hardlink.json");
    linkSync(victim, link);
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: link }, root);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("hard link");
    victimUntouched();
  });

  it("refuses a savePath whose directory does not exist", async () => {
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: join(root, "missing", "x.png") }, root);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("does not exist");
    expect(existsSync(join(root, "missing"))).toBe(false);
  });

  it("defaults the root to the working directory", async () => {
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: join(root, "default.png") }, undefined);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the file root");
    expect(existsSync(join(root, "default.png"))).toBe(false);
  });

  // Symlink creation needs a privilege on Windows (EPERM), so these skip there
  // when the link cannot be made.
  function trySymlink(target: string, path: string, type: "dir" | "file"): boolean {
    try {
      symlinkSync(target, path, type);
      return true;
    } catch (err) {
      // Only Windows without the symlink privilege may skip; anything else is a failure.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return false;
      throw err;
    }
  }

  it("refuses a symlink inside the root that points to a file outside it", async (ctx) => {
    const link = join(root, "link-to-secret.json");
    if (!trySymlink(victim, link, "file")) ctx.skip();
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: link }, root);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("symlink");
    victimUntouched();
  });

  it("refuses a path through a symlinked directory that points outside", async (ctx) => {
    const link = join(root, "dirlink");
    if (!trySymlink(outside, link, "dir")) ctx.skip();
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: join(link, "example-client_secret.json") }, root);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("outside the file root");
    victimUntouched();
  });

  it("refuses a dangling symlink inside the root", async (ctx) => {
    const link = join(root, "dangling.png");
    if (!trySymlink(join(outside, "not-yet.png"), link, "file")) ctx.skip();
    const res = await download(PNG, BINARY, { fileId: "example-file-id", savePath: link }, root);
    expect(res.isError).toBe(true);
    expect(existsSync(join(outside, "not-yet.png"))).toBe(false);
  });
});
