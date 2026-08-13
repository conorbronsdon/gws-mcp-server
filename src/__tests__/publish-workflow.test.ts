import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../../.github/workflows/publish.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function stepNamed(name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`publish workflow has no "${name}" step`);

  const next = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

const registryLegGuard =
  "steps.version.outputs.changed == 'true' || github.event_name == 'workflow_dispatch'";

describe("publish workflow registry gate", () => {
  it.each([
    "Sync server.json version from package.json",
    "Check if version is already in the MCP registry",
  ])("gates %s on a new npm version or a manual catch-up", (name) => {
    expect(stepNamed(name)).toContain(`if: ${registryLegGuard}`);
  });

  it("publishes to the registry only when the gated lookup finds a missing version", () => {
    expect(stepNamed("Publish to the MCP registry")).toContain(
      `if: (${registryLegGuard}) && steps.registry.outputs.changed == 'true'`,
    );
  });

  it("checks the exact registry version rather than trusting search results", () => {
    const check = stepNamed("Check if version is already in the MCP registry");
    expect(check).toContain(
      "/v0.1/servers/$SERVER_NAME_ENCODED/versions/$LOCAL_VERSION_ENCODED",
    );
    expect(check).not.toContain("?search=");
  });
});


