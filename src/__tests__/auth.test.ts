import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVICE_SCOPES,
  createGwsAuthRunner,
  mergeScopes,
  parseAuthArgs,
  parseAuthStatus,
  planLogin,
  runAuthCli,
  scopesForServices,
  type GwsAuthRunner,
} from "../auth.js";
import { ALL_SERVICES } from "../services.js";

const A = "https://www.googleapis.com/auth/";
const IDENTITY = ["openid", `${A}userinfo.email`, `${A}userinfo.profile`];
// gws's default grant (MINIMAL_SCOPES in gws 0.22.5 auth_commands.rs).
const DEFAULT_GRANT = ["drive", "spreadsheets", "gmail.modify", "calendar", "documents", "presentations", "tasks"].map(
  (s) => A + s,
);

/**
 * In-memory stand-in for gws's saved credential. Behaves like the real CLI:
 * `auth login` replaces the stored grant with exactly what was requested
 * (plus the identity scopes gws always adds), and `auth status` reports the
 * stored scopes unless the live lookup fails.
 */
class FakeTokenStore implements GwsAuthRunner {
  logins: string[][] = [];
  statusLookupFails = false;
  /** Scopes the user unticks on Google's consent screen. */
  declineAtConsent = new Set<string>();

  constructor(public scopes: string[] | null) {}

  async status(): Promise<string> {
    if (!this.scopes) return JSON.stringify({ auth_method: "none", storage: "none" });
    if (this.statusLookupFails) {
      return JSON.stringify({ auth_method: "oauth2", storage: "encrypted", token_valid: false, token_error: "Bad Request" });
    }
    return JSON.stringify({ auth_method: "oauth2", storage: "encrypted", token_valid: true, scopes: this.scopes });
  }

  async login(args: string[]): Promise<void> {
    this.logins.push(args);
    const i = args.indexOf("--scopes");
    if (i < 0) throw new Error("fake store only models --scopes logins");
    const requested = args[i + 1].split(",").filter((s) => !this.declineAtConsent.has(s));
    this.scopes = [...new Set([...requested, ...IDENTITY])];
  }
}

async function run(store: FakeTokenStore, argv: string[]) {
  const lines: string[] = [];
  const code = await runAuthCli(argv, () => store, (l) => lines.push(l));
  return { code, output: lines.join("\n") };
}

describe("auth login -s <service> (#68)", () => {
  it("keeps every existing scope and adds the service's scope", async () => {
    const store = new FakeTokenStore([...DEFAULT_GRANT, ...IDENTITY]);
    const { code } = await run(store, ["login", "-s", "people"]);
    expect(code).toBe(0);
    expect(store.logins).toHaveLength(1);
    for (const scope of DEFAULT_GRANT) expect(store.scopes).toContain(scope);
    expect(store.scopes).toContain(`${A}contacts`);
  });

  it("preserves a custom grant gws's defaults don't know about", async () => {
    const custom = [`${A}drive.readonly`, `${A}calendar.events`, `${A}forms.body`, ...IDENTITY];
    const store = new FakeTokenStore(custom);
    expect((await run(store, ["login", "-s", "people,tasks"])).code).toBe(0);
    expect(store.scopes).toEqual(expect.arrayContaining([...custom, `${A}contacts`, `${A}tasks`]));
  });

  it("does not log in again when the credential already covers the service", async () => {
    const store = new FakeTokenStore([...DEFAULT_GRANT, ...IDENTITY]);
    const { code, output } = await run(store, ["login", "-s", "drive,gmail", "--readonly"]);
    expect(code).toBe(0);
    expect(store.logins).toHaveLength(0);
    expect(output).toMatch(/already covers/);
  });

  it("refuses rather than replacing when a credential exists but its scopes can't be read", async () => {
    const store = new FakeTokenStore([...DEFAULT_GRANT, ...IDENTITY]);
    store.statusLookupFails = true;
    const { code, output } = await run(store, ["login", "-s", "people"]);
    expect(code).toBe(1);
    expect(store.logins).toHaveLength(0);
    expect(store.scopes).toEqual([...DEFAULT_GRANT, ...IDENTITY]);
    expect(output).toMatch(/Bad Request/);
    expect(output).toMatch(/--replace/);
  });

  it("--replace keeps the old replace-the-credential behaviour as an explicit opt-in", async () => {
    const store = new FakeTokenStore([...DEFAULT_GRANT, ...IDENTITY]);
    expect((await run(store, ["login", "-s", "people", "--replace"])).code).toBe(0);
    expect(store.logins[0]).toEqual(["auth", "login", "--scopes", `${A}contacts`]);
    expect(store.scopes).toEqual([`${A}contacts`, ...IDENTITY]);
  });

  it("reports failure when the new grant can't be verified after login", async () => {
    const store = new FakeTokenStore(null);
    const login = store.login.bind(store);
    store.login = async (args) => {
      await login(args);
      store.statusLookupFails = true;
    };
    const { code, output } = await run(store, ["login", "-s", "people"]);
    expect(code).toBe(1);
    expect(output).toMatch(/could not be verified/);
  });

  it("first login with no saved credential requests just the services asked for", async () => {
    const store = new FakeTokenStore(null);
    expect((await run(store, ["login", "-s", "drive,people"])).code).toBe(0);
    expect(store.logins[0]).toEqual(["auth", "login", "--scopes", `${A}drive,${A}contacts`]);
  });

  it("fails when the user unticks a scope on the consent screen", async () => {
    const store = new FakeTokenStore([...DEFAULT_GRANT, ...IDENTITY]);
    store.declineAtConsent.add(`${A}gmail.modify`);
    const { code, output } = await run(store, ["login", "-s", "people"]);
    expect(code).toBe(1);
    expect(output).toContain(`not granted: ${A}gmail.modify`);
  });

  it("--dry-run prints the merged command and leaves the store alone", async () => {
    const store = new FakeTokenStore([`${A}drive`, ...IDENTITY]);
    const { code, output } = await run(store, ["login", "-s", "people", "--dry-run"]);
    expect(code).toBe(0);
    expect(store.logins).toHaveLength(0);
    expect(output).toContain(`auth login --scopes ${A}drive,openid,${A}userinfo.email,${A}userinfo.profile,${A}contacts`);
  });

  it("rejects bad arguments with exit code 2 before touching gws", async () => {
    const store = new FakeTokenStore([`${A}drive`]);
    for (const argv of [["login"], ["login", "-s", "forms"], ["logout"], ["login", "-s", "people", "--full"]]) {
      expect((await run(store, argv)).code, argv.join(" ")).toBe(2);
    }
    expect(store.logins).toHaveLength(0);
  });
});

describe("mergeScopes", () => {
  it("is an order-preserving union", () => {
    expect(mergeScopes([`${A}drive`, `${A}drive`], [`${A}contacts`, `${A}drive`])).toEqual([`${A}drive`, `${A}contacts`]);
  });

  it("treats a read-only scope as covered by its read-write scope", () => {
    expect(mergeScopes([`${A}drive`, `${A}gmail.modify`], [`${A}drive.readonly`, `${A}gmail.readonly`])).toEqual([
      `${A}drive`,
      `${A}gmail.modify`,
    ]);
    expect(mergeScopes(["https://mail.google.com/"], [`${A}gmail.modify`])).toEqual(["https://mail.google.com/"]);
  });

  it("still adds read-write when only read-only is held", () => {
    expect(mergeScopes([`${A}drive.readonly`], [`${A}drive`])).toEqual([`${A}drive.readonly`, `${A}drive`]);
  });
});

describe("planLogin / parseAuthStatus", () => {
  it("reads auth_method, scopes and token_error from gws's status JSON", () => {
    expect(parseAuthStatus('{"auth_method":"oauth2","scopes":["a","b"]}')).toEqual({ authMethod: "oauth2", scopes: ["a", "b"] });
    expect(parseAuthStatus('{"auth_method":"oauth2","token_error":"x"}')).toEqual({ authMethod: "oauth2", tokenError: "x" });
    expect(() => parseAuthStatus("not json")).toThrow(/parse/);
  });

  it("refuses an unknown auth_method without scopes", () => {
    expect(planLogin({ authMethod: "unknown" }, [`${A}contacts`]).kind).toBe("refuse");
  });

  it("dedupes repeated existing scopes before computing what's added", () => {
    const plan = planLogin({ authMethod: "oauth2", scopes: [`${A}drive`, `${A}drive`] }, [`${A}contacts`]);
    expect(plan).toMatchObject({ kind: "login", added: [`${A}contacts`], preserved: [`${A}drive`] });
  });
});

describe("SERVICE_SCOPES", () => {
  it("covers every registered service", () => {
    expect(Object.keys(SERVICE_SCOPES).sort()).toEqual([...ALL_SERVICES].sort());
  });

  it("maps the default services onto gws's default grant", () => {
    expect(scopesForServices(["drive", "sheets", "gmail", "calendar", "docs", "slides", "tasks"], false).sort()).toEqual(
      [...DEFAULT_GRANT].sort(),
    );
  });

  it("parseAuthArgs defaults gws path from GWS_BINARY", () => {
    expect(parseAuthArgs(["login", "-s", "people"], { GWS_BINARY: "/opt/gws" }).gwsBinary).toBe("/opt/gws");
  });
});

describe("createGwsAuthRunner against a fake gws binary", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.FAKE_GWS_STORE;
  });

  it("merges through real child processes and a file-backed token store", async () => {
    dir = mkdtempSync(join(tmpdir(), "fake-gws-"));
    const bin = join(dir, "gws.cjs");
    copyFileSync(fileURLToPath(new URL("./fixtures/fake-gws.cjs", import.meta.url)), bin);
    chmodSync(bin, 0o755);
    const store = join(dir, "store.json");
    writeFileSync(store, JSON.stringify({ scopes: [...DEFAULT_GRANT, ...IDENTITY] }));
    process.env.FAKE_GWS_STORE = store;

    const lines: string[] = [];
    const code = await runAuthCli(["login", "-s", "people", "--gws-path", bin], createGwsAuthRunner, (l) => lines.push(l));

    expect(code, lines.join("\n")).toBe(0);
    const saved = JSON.parse(readFileSync(store, "utf8")).scopes as string[];
    expect(saved).toEqual(expect.arrayContaining([...DEFAULT_GRANT, `${A}contacts`]));
    expect(existsSync(`${store}.log`)).toBe(true);
    expect(readFileSync(`${store}.log`, "utf8").trim().split("\n")).toHaveLength(1);
  });
});
