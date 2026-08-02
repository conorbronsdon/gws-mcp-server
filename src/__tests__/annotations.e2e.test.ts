/**
 * End-to-end annotation checks against an assembled server.
 *
 * `services.test.ts` covers `buildAnnotations`, but that function only sees
 * registry tools. `drive_files_download` and `gmail_drafts_create` are
 * registered by hand with annotation object literals, so a unit test over the
 * builder cannot see them — which is how `gmail_drafts_create` shipped
 * advertising itself as destructive. These tests drive a real MCP client over
 * an in-memory transport and assert on the `tools/list` payload a client
 * actually receives.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, countRegisteredTools, SERVER_VERSION } from "../index.js";
import { getToolsForServices, ALL_SERVICES } from "../services.js";

/** Drive a real MCP client against an assembled server and return it. */
async function connect(services: string[], readOnly = false): Promise<Client> {
  const server = createServer(
    getToolsForServices(services),
    services,
    "gws",
    // gwsAvailable: nothing is executed here, only metadata is read.
    false,
    readOnly,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annotations-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ListedTool = {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

let tools: ListedTool[];

beforeAll(async () => {
  const client = await connect(ALL_SERVICES);
  tools = (await client.listTools()).tools as ListedTool[];
});

const byName = (n: string): ListedTool => {
  const t = tools.find((x) => x.name === n);
  if (!t) throw new Error(`tool not registered: ${n}`);
  return t;
};

describe("advertised annotations", () => {
  it("registers both hand-written tools alongside the registry tools", () => {
    expect(tools.length).toBe(39);
    expect(byName("drive_files_download")).toBeDefined();
    expect(byName("gmail_drafts_create")).toBeDefined();
  });

  it("no advertised write omits destructiveHint", () => {
    // The regression. MCP defaults destructiveHint to true, so an omitted hint
    // on a write advertises it as destructive to every client.
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false);
    expect(writes.length).toBeGreaterThan(0);
    const omitted = writes
      .filter((t) => typeof t.annotations?.destructiveHint !== "boolean")
      .map((t) => t.name);
    expect(omitted).toEqual([]);
  });

  it("gmail_drafts_create is advertised as a non-destructive write", () => {
    // The README's safety argument rests on this tool never sending mail.
    // Asserts the two hints this test is about; the full four-hint object is
    // pinned in the idempotentHint/openWorldHint block below.
    const a = byName("gmail_drafts_create").annotations;
    expect(a?.readOnlyHint).toBe(false);
    expect(a?.destructiveHint).toBe(false);
  });

  it("drive_files_download is advertised read-only (savePath writes locally, not to Drive)", () => {
    expect(byName("drive_files_download").annotations?.readOnlyHint).toBe(true);
  });

  it("reports the version from package.json, not a hardcoded literal", async () => {
    // `version` in index.ts was pinned at "0.4.0" while the publish workflow
    // derived server.json from package.json, so the next bump would have
    // shipped a stale version to every client. Compare against package.json
    // read here rather than against SERVER_VERSION, which would only prove the
    // constant equals itself.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };

    const client = await connect(ALL_SERVICES);
    const advertised = client.getServerVersion();

    expect(advertised?.name).toBe("gws-mcp-server");
    expect(advertised?.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it("only irreversible removals are advertised as destructive", () => {
    // tasks_tasks_clear is in this list and is not a *_delete: it permanently
    // removes completed tasks from a list, so it belongs here.
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();
    expect(destructive).toEqual([
      "calendar_events_delete",
      "drive_files_delete",
      "tasks_tasklists_delete",
      "tasks_tasks_clear",
      "tasks_tasks_delete",
    ]);
  });
});

describe("startup tool count", () => {
  // The startup log read `tools.length` from the registry, which is taken
  // before the two hand-registered tools are added — it said 37 while a client
  // saw 39. `countRegisteredTools` restates createServer's registration guards,
  // so it is only trustworthy if checked against a real tools/list. Subsets
  // matter: the custom tools are gated on drive and gmail individually.
  const cases: string[][] = [
    ALL_SERVICES,
    ["drive"],
    ["gmail"],
    ["drive", "gmail"],
    ["sheets"],
    ["calendar", "docs", "tasks"],
  ];

  for (const services of cases) {
    it(`matches what a client lists for --services ${services.join(",")}`, async () => {
      const client = await connect(services);
      const listed = (await client.listTools()).tools;
      expect(countRegisteredTools(getToolsForServices(services), services)).toBe(listed.length);
    });
  }

  it("counts the custom tools that the registry does not", () => {
    // Guards against the fix being "fudge the string": the number has to come
    // from somewhere other than the registry length.
    const registry = getToolsForServices(ALL_SERVICES);
    expect(registry.length).toBe(37);
    expect(countRegisteredTools(registry, ALL_SERVICES)).toBe(39);
    expect(countRegisteredTools(registry, ["sheets"])).toBe(registry.length);
  });
});

describe("--read-only", () => {
  // The flag's whole value is that it is enforced at the server boundary
  // instead of in prose, so every assertion here goes through a real
  // tools/list. A unit test over selectTools would miss gmail_drafts_create,
  // which is registered by hand — the same blind spot that let it ship
  // advertising itself as destructive.
  let roTools: ListedTool[];

  beforeAll(async () => {
    const client = await connect(ALL_SERVICES, true);
    roTools = (await client.listTools()).tools as ListedTool[];
  });

  it("exposes exactly the 17 read-only tools", () => {
    expect(roTools.length).toBe(17);
    expect(countRegisteredTools(getToolsForServices(ALL_SERVICES), ALL_SERVICES, true)).toBe(17);
  });

  it("lists no tool that advertises itself as a write", () => {
    const writes = roTools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    expect(writes).toEqual([]);
  });

  it("drops every write the default server exposes", () => {
    const dropped = tools
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name);
    // 39 default - 17 read-only = 22 writes, all gone.
    expect(dropped.length).toBe(22);
    for (const name of dropped) {
      expect(roTools.find((t) => t.name === name)).toBeUndefined();
    }
  });

  it("drops the hand-registered write and keeps the hand-registered read", () => {
    // gmail_drafts_create bypasses the registry filter entirely.
    expect(roTools.find((t) => t.name === "gmail_drafts_create")).toBeUndefined();
    expect(roTools.find((t) => t.name === "drive_files_download")).toBeDefined();
  });

  it("keeps no destructive tool", () => {
    expect(roTools.filter((t) => t.annotations?.destructiveHint === true)).toEqual([]);
  });

  it("is additive — the default server is unchanged", () => {
    expect(tools.length).toBe(39);
    expect(tools.find((t) => t.name === "gmail_drafts_create")).toBeDefined();
    expect(tools.find((t) => t.name === "drive_files_delete")).toBeDefined();
  });

  it("narrows per service, and the count still matches a real tools/list", async () => {
    for (const services of [["drive"], ["gmail"], ["sheets"], ["calendar", "tasks"]]) {
      const client = await connect(services, true);
      const listed = (await client.listTools()).tools;
      expect(countRegisteredTools(getToolsForServices(services), services, true)).toBe(listed.length);
      expect(listed.every((t) => (t.annotations as ListedTool["annotations"])?.readOnlyHint === true)).toBe(true);
    }
  });
});

describe("idempotentHint / openWorldHint", () => {
  // Asserted from tools/list, never from buildAnnotations. The builder does not
  // see drive_files_download or gmail_drafts_create at all — #24 shipped a
  // wrong hint on the second of those while every builder unit test passed.

  it("every tool advertises openWorldHint", () => {
    const missing = tools
      .filter((t) => typeof t.annotations?.openWorldHint !== "boolean")
      .map((t) => t.name);
    expect(missing).toEqual([]);
    // All 39 reach Google Workspace, whose state changes independently of us.
    expect(tools.filter((t) => t.annotations?.openWorldHint === true).length).toBe(39);
  });

  it("every write advertises idempotentHint, and no read does", () => {
    // Only meaningful when readOnlyHint is false; the spec ignores it on reads,
    // which is the same rule this file already applies to destructiveHint.
    const writesMissing = tools
      .filter((t) => t.annotations?.readOnlyHint === false)
      .filter((t) => typeof t.annotations?.idempotentHint !== "boolean")
      .map((t) => t.name);
    expect(writesMissing).toEqual([]);

    const readsCarrying = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .filter((t) => t.annotations?.idempotentHint !== undefined)
      .map((t) => t.name);
    expect(readsCarrying).toEqual([]);
  });

  it("marks exactly the repeatable writes idempotent", () => {
    // Values, not shape: a test that only counted booleans would pass with
    // every one of these flipped. Patches and deletes repeat cleanly; a second
    // delete errors but adds no further effect.
    const idempotent = tools
      .filter((t) => t.annotations?.idempotentHint === true)
      .map((t) => t.name)
      .sort();
    expect(idempotent).toEqual([
      "calendar_events_delete",
      "calendar_events_update",
      "drive_files_delete",
      "drive_files_update",
      "gmail_threads_modify",
      "sheets_values_update",
      "tasks_tasklists_delete",
      "tasks_tasklists_update",
      "tasks_tasks_clear",
      "tasks_tasks_delete",
      "tasks_tasks_move",
      "tasks_tasks_update",
    ]);
  });

  it("leaves every creating write non-idempotent", () => {
    // Each of these produces another entity per call, so a client must not
    // treat a retry as free. sheets_values_append is the subtle one: it is an
    // append, not a ranged write like sheets_values_update.
    const notIdempotent = tools
      .filter((t) => t.annotations?.idempotentHint === false)
      .map((t) => t.name)
      .sort();
    expect(notIdempotent).toEqual([
      "calendar_events_insert",
      "docs_batchUpdate",
      "docs_create",
      "drive_files_copy",
      "drive_files_create",
      "drive_permissions_create",
      "gmail_drafts_create",
      "sheets_values_append",
      "tasks_tasklists_insert",
      "tasks_tasks_insert",
    ]);
  });

  it("gives the hand-registered tools all the hints the builder would", () => {
    // The #24 regression in one assertion.
    expect(byName("gmail_drafts_create").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName("drive_files_download").annotations).toEqual({
      readOnlyHint: true,
      openWorldHint: true,
    });
  });

  it("accounts for all 39 tools", () => {
    const reads = tools.filter((t) => t.annotations?.readOnlyHint === true).length;
    const idem = tools.filter((t) => t.annotations?.idempotentHint === true).length;
    const nonIdem = tools.filter((t) => t.annotations?.idempotentHint === false).length;
    expect(reads).toBe(17);
    expect(idem + nonIdem).toBe(39 - reads);
    expect(idem).toBe(12);
    expect(nonIdem).toBe(10);
  });
});
