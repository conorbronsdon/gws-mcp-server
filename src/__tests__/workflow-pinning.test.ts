import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Third-party actions must be pinned to a full commit SHA, not a movable tag
// (supply-chain hardening; the awesome-ai-plugins source scan checks this too).
const workflowsDir = new URL("../../.github/workflows/", import.meta.url);

function unpinnedUses(yaml: string): string[] {
  const bad: string[] = [];
  for (const line of yaml.replace(/\r\n/g, "\n").split("\n")) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)/);
    if (!m) continue;
    const ref = m[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
    if (!/@[0-9a-f]{40}$/.test(ref)) bad.push(ref);
  }
  return bad;
}

describe("unpinnedUses", () => {
  it("flags a tag-pinned action", () => {
    expect(unpinnedUses("      - uses: actions/checkout@v6\n")).toEqual(["actions/checkout@v6"]);
  });

  it("flags a short SHA and a branch ref", () => {
    expect(
      unpinnedUses("- uses: actions/checkout@d23441a\n  - uses: foo/bar@main\n"),
    ).toEqual(["actions/checkout@d23441a", "foo/bar@main"]);
  });

  it("accepts a full-SHA pin with a version comment, and local actions", () => {
    expect(
      unpinnedUses(
        "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0\n" +
          "      - uses: ./.github/actions/local\n",
      ),
    ).toEqual([]);
  });
});

describe("workflows in this repo", () => {
  const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));

  it("has the workflows this test is meant to cover", () => {
    expect(files.sort()).toEqual(["ci.yml", "publish.yml"]);
  });

  it.each(files)("%s pins every action to a full commit SHA", (file) => {
    const yaml = readFileSync(new URL(file, workflowsDir), "utf8");
    expect(yaml).toMatch(/uses:/);
    expect(unpinnedUses(yaml)).toEqual([]);
  });

  it("dependabot watches the github-actions ecosystem", () => {
    const dependabot = readFileSync(
      new URL("../../.github/dependabot.yml", import.meta.url),
      "utf8",
    );
    expect(dependabot).toMatch(/^\s*- package-ecosystem: github-actions$/m);
  });
});
