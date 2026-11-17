/**
 * drive_files_download through a real MCP client and a fake gws binary.
 *
 * The tool decides between returning text inline and saving bytes from the
 * MIME type of what it actually downloaded. For a Google-native file that is
 * the export format, not the Drive MIME type: a Drawing exports to PNG by
 * default, and a Doc can be exported to PDF on request.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function download(meta: Record<string, unknown>, content: Buffer, args: Record<string, unknown>) {
  process.env.FAKE_DRIVE_META = JSON.stringify(meta);
  process.env.FAKE_DRIVE_CONTENT = content.toString("base64");
  const server = createServer(getToolsForServices(["drive"]), ["drive"], bin, true);
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
