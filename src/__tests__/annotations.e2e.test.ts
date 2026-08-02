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
async function connect(services: string[]): Promise<Client> {
  const server = createServer(
    getToolsForServices(services),
    services,
    "gws",
    // gwsAvailable: nothing is executed here, only metadata is read.
    false,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "annotations-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type ListedTool = {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
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
    expect(byName("gmail_drafts_create").annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
    });
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
