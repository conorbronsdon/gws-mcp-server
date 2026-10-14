/**
 * `gws-mcp-server auth login -s <services>`: incremental authorization on top
 * of `gws auth login`.
 *
 * `gws auth login -s <service>` mints a new refresh token for only the
 * filtered scope set and overwrites the saved credential, so adding Contacts
 * silently drops Drive, Gmail, Calendar and the rest (#68). gws has no flag to
 * extend an existing grant, so this command does the merge itself: it reads
 * the scopes the saved credential holds from `gws auth status`, adds the
 * requested services' scopes, and runs `gws auth login --scopes <union>`. If
 * the current scopes can't be read it refuses instead of guessing, because a
 * guess is exactly how a grant gets narrowed.
 */

import { spawn } from "node:child_process";
import { spawnGwsRaw } from "./executor.js";
import { GwsBinaryConfigurationError, resolveGwsCommand } from "./windows-binary.js";
import { ALL_SERVICES } from "./services.js";

const AUTH = "https://www.googleapis.com/auth/";

/**
 * The scope each service's tools need. `full` matches gws's own default grant
 * (`MINIMAL_SCOPES` in gws's auth_commands.rs) plus `contacts` for people;
 * `readonly` is used with `--readonly`.
 */
export const SERVICE_SCOPES: Readonly<Record<string, { full: string; readonly: string }>> = Object.freeze({
  drive: { full: `${AUTH}drive`, readonly: `${AUTH}drive.readonly` },
  sheets: { full: `${AUTH}spreadsheets`, readonly: `${AUTH}spreadsheets.readonly` },
  calendar: { full: `${AUTH}calendar`, readonly: `${AUTH}calendar.readonly` },
  docs: { full: `${AUTH}documents`, readonly: `${AUTH}documents.readonly` },
  slides: { full: `${AUTH}presentations`, readonly: `${AUTH}presentations.readonly` },
  gmail: { full: `${AUTH}gmail.modify`, readonly: `${AUTH}gmail.readonly` },
  tasks: { full: `${AUTH}tasks`, readonly: `${AUTH}tasks.readonly` },
  people: { full: `${AUTH}contacts`, readonly: `${AUTH}contacts.readonly` },
});

/**
 * Scopes that already grant everything a narrower scope would. gws's login also
 * drops `gmail.metadata` whenever one of its broader alternatives is requested
 * (`filter_redundant_restrictive_scopes`), so a held metadata scope counts as
 * kept when a broader Gmail scope is granted.
 */
const BROADER_SCOPES: Readonly<Record<string, readonly string[]>> = {
  [`${AUTH}gmail.modify`]: ["https://mail.google.com/"],
  [`${AUTH}gmail.readonly`]: [`${AUTH}gmail.modify`, "https://mail.google.com/"],
  [`${AUTH}gmail.metadata`]: [`${AUTH}gmail.modify`, `${AUTH}gmail.readonly`, "https://mail.google.com/"],
};

function isCovered(scope: string, granted: ReadonlySet<string>): boolean {
  if (granted.has(scope)) return true;
  if (scope.endsWith(".readonly") && granted.has(scope.slice(0, -".readonly".length))) return true;
  return (BROADER_SCOPES[scope] ?? []).some((s) => granted.has(s));
}

export interface AuthStatus {
  /** `oauth2` when a saved credential exists, `none` when it doesn't. */
  authMethod: string;
  /**
   * Scopes the saved credential holds. gws discovers these live (refresh
   * token exchange + tokeninfo), so they're absent whenever that fails.
   */
  scopes?: string[];
  tokenError?: string;
}

export function parseAuthStatus(stdout: string): AuthStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Don't echo the output: it isn't what we expected, so we can't know what it holds.
    throw new Error(`Could not parse \`gws auth status\` output as JSON (${stdout.length} characters)`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("`gws auth status` did not return a JSON object");
  const obj = parsed as Record<string, unknown>;
  const scopes = Array.isArray(obj.scopes) && obj.scopes.every((s) => typeof s === "string")
    ? (obj.scopes as string[]).filter((s) => s.length > 0)
    : undefined;
  return {
    authMethod: typeof obj.auth_method === "string" ? obj.auth_method : "unknown",
    scopes,
    tokenError: typeof obj.token_error === "string" ? obj.token_error : undefined,
  };
}

/** Order-preserving union: existing scopes first, then new ones not already covered. */
export function mergeScopes(existing: readonly string[], requested: readonly string[]): string[] {
  const merged = [...new Set(existing)];
  const granted = new Set(merged);
  for (const scope of requested) {
    if (!isCovered(scope, granted)) {
      merged.push(scope);
      granted.add(scope);
    }
  }
  return merged;
}

export function scopesForServices(services: readonly string[], readonly: boolean): string[] {
  return services.map((svc) => {
    const entry = SERVICE_SCOPES[svc];
    if (!entry) throw new Error(`Unknown service: ${svc}. Available: ${ALL_SERVICES.join(", ")}`);
    return readonly ? entry.readonly : entry.full;
  });
}

export type LoginPlan =
  | { kind: "login"; scopes: string[]; added: string[]; preserved: string[]; mode: "merge" | "first-login" | "replace" }
  | { kind: "noop"; preserved: string[] }
  | { kind: "refuse"; reason: string };

export function planLogin(
  status: AuthStatus,
  requested: readonly string[],
  opts: { replace?: boolean } = {},
): LoginPlan {
  if (opts.replace) {
    return { kind: "login", scopes: [...new Set(requested)], added: [...new Set(requested)], preserved: [], mode: "replace" };
  }
  if (status.authMethod === "none") {
    return { kind: "login", scopes: [...new Set(requested)], added: [...new Set(requested)], preserved: [], mode: "first-login" };
  }
  if (!status.scopes || status.scopes.length === 0) {
    const why = status.tokenError ? ` (gws reported: ${status.tokenError})` : "";
    return {
      kind: "refuse",
      reason:
        `A saved credential exists, but \`gws auth status\` did not report its scopes${why}. ` +
        "Logging in now would replace it with only the requested scopes. Fix the status lookup and retry, " +
        "or pass --replace if replacing the credential is what you want.",
    };
  }
  const preserved = [...new Set(status.scopes)];
  const scopes = mergeScopes(preserved, requested);
  const added = scopes.slice(preserved.length);
  if (added.length === 0) return { kind: "noop", preserved };
  return { kind: "login", scopes, added, preserved, mode: "merge" };
}

/** The two gws calls this command makes. Tests substitute a fake token store. */
export interface GwsAuthRunner {
  status(): Promise<string>;
  login(args: string[]): Promise<void>;
}

export function createGwsAuthRunner(gwsBinary: string): GwsAuthRunner {
  return {
    async status() {
      return (await spawnGwsRaw(gwsBinary, ["auth", "status"])).stdout;
    },
    login(args) {
      return new Promise((resolve, reject) => {
        let command = gwsBinary;
        let childArgs = args;
        if (process.platform === "win32") {
          const resolved = resolveGwsCommand(gwsBinary);
          command = resolved.command;
          childArgs = [...resolved.prefix, ...args];
        }
        // Inherit stdio: the OAuth flow prints a URL and waits for the browser.
        const proc = spawn(command, childArgs, { stdio: "inherit", shell: false });
        proc.on("error", reject);
        proc.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(code === null ? "gws auth login was interrupted" : `gws auth login exited with code ${code}`)),
        );
      });
    },
  };
}

export const AUTH_HELP = `
gws-mcp-server auth login — add scopes to the saved gws credential

Unlike \`gws auth login -s <service>\`, which replaces the saved credential
with only that service's scopes, this keeps every scope the credential
already holds and adds the requested ones.

USAGE:
  gws-mcp-server auth login --services <list> [options]

OPTIONS:
  --services, -s <list>   Services whose scopes to add (required)
                          Available: ${ALL_SERVICES.join(", ")}
  --readonly              Add the read-only variant of each service's scope
  --replace               Old behaviour: replace the credential with only the
                          requested scopes
  --dry-run               Print the gws command without running it
  --gws-path <path>       Path to gws binary (default: GWS_BINARY or "gws")
  --help, -h              Show this help

EXAMPLE:
  gws-mcp-server auth login -s people
`;

export interface AuthCliOptions {
  services: string[];
  readonly: boolean;
  replace: boolean;
  dryRun: boolean;
  gwsBinary: string;
  help: boolean;
}

export function parseAuthArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): AuthCliOptions {
  const opts: AuthCliOptions = {
    services: [],
    readonly: false,
    replace: false,
    dryRun: false,
    gwsBinary: env.GWS_BINARY || "gws",
    help: false,
  };
  const [sub, ...rest] = argv;
  if (sub === "--help" || sub === "-h" || sub === undefined) return { ...opts, help: true };
  if (sub !== "login") throw new Error(`Unknown auth subcommand: ${sub}. Only "login" is supported.`);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--services" || arg === "-s") {
      const val = rest[++i];
      if (!val) throw new Error(`${arg} needs a comma-separated list of services`);
      opts.services = val.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg === "--readonly") opts.readonly = true;
    else if (arg === "--replace") opts.replace = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--gws-path") {
      const val = rest[++i];
      if (!val) throw new Error("--gws-path needs a path");
      opts.gwsBinary = val;
    } else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.help && opts.services.length === 0) throw new Error("--services is required, e.g. `auth login -s people`");
  const invalid = opts.services.filter((s) => !ALL_SERVICES.includes(s));
  if (invalid.length > 0) {
    throw new Error(`Unknown service(s): ${invalid.join(", ")}. Available: ${ALL_SERVICES.join(", ")}`);
  }
  return opts;
}

/**
 * Read and parse `gws auth status`. A failed run's error carries gws's raw
 * stderr/stdout, so only messages this module or Node wrote are passed on.
 */
async function readStatus(runner: GwsAuthRunner): Promise<AuthStatus> {
  let stdout: string;
  try {
    stdout = await runner.status();
  } catch (err) {
    const safe = err instanceof GwsBinaryConfigurationError || typeof (err as NodeJS.ErrnoException)?.code === "string";
    throw new Error(safe ? (err as Error).message : "`gws auth status` failed; run it yourself to see why");
  }
  return parseAuthStatus(stdout);
}

/** Returns the process exit code. Logs go to `log` (stderr in production). */
export async function runAuthCli(
  argv: readonly string[],
  makeRunner: (gwsBinary: string) => GwsAuthRunner = createGwsAuthRunner,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  let opts: AuthCliOptions;
  try {
    opts = parseAuthArgs(argv);
  } catch (err) {
    log(`[gws-mcp] ${(err as Error).message}`);
    log(AUTH_HELP);
    return 2;
  }
  if (opts.help) {
    log(AUTH_HELP);
    return 0;
  }

  const runner = makeRunner(opts.gwsBinary);
  // --replace discards the current grant, so it doesn't need to read it: it
  // must keep working when `gws auth status` itself is what's broken.
  let status: AuthStatus = { authMethod: "unknown" };
  if (!opts.replace) {
    try {
      status = await readStatus(runner);
    } catch (err) {
      log(`[gws-mcp] Could not read the saved credential's scopes: ${(err as Error).message}`);
      return 1;
    }
  }

  const requested = scopesForServices(opts.services, opts.readonly);
  const plan = planLogin(status, requested, { replace: opts.replace });

  if (plan.kind === "refuse") {
    log(`[gws-mcp] ${plan.reason}`);
    return 1;
  }
  if (plan.kind === "noop") {
    log(`[gws-mcp] The saved credential already covers ${opts.services.join(", ")}. Nothing to do.`);
    return 0;
  }

  if (plan.mode === "merge") {
    log(`[gws-mcp] Keeping ${plan.preserved.length} existing scope(s) and adding: ${plan.added.join(", ")}`);
  } else if (plan.mode === "replace") {
    log("[gws-mcp] --replace: the saved credential will hold ONLY the requested scopes.");
  } else {
    log("[gws-mcp] No saved credential found; requesting only the requested services' scopes.");
  }

  const loginArgs = ["auth", "login", "--scopes", plan.scopes.join(",")];
  // gws overwrites the saved credential with whatever the consent screen
  // returns, so print the full list first: it is the way back if a box gets
  // unticked or the run is interrupted.
  // Quoting an executable path differs between shells (PowerShell needs `&`),
  // so a custom binary is named beside the command rather than inside it.
  const via = opts.gwsBinary === "gws" ? "" : ` (use your gws binary, ${JSON.stringify(opts.gwsBinary)}, in place of gws)`;
  const retry = `gws auth login --scopes "${plan.scopes.join(",")}"${via}`;
  if (opts.dryRun) {
    log(`[gws-mcp] Dry run. Would run: ${retry}`);
    return 0;
  }

  log(`[gws-mcp] Requesting ${plan.scopes.length} scope(s). If anything goes wrong, this re-requests the same set: ${retry}`);
  try {
    await runner.login(loginArgs);
  } catch (err) {
    log(`[gws-mcp] ${(err as Error).message}. The saved credential may be unchanged; run \`gws auth status\` to check.`);
    return 1;
  }

  // Google's consent screen lets the user untick individual scopes, so check
  // what was actually granted instead of assuming the request went through.
  let after: AuthStatus;
  try {
    after = await readStatus(runner);
  } catch (err) {
    log(`[gws-mcp] Logged in, but could not verify the new grant: ${(err as Error).message}`);
    return 1;
  }
  if (!after.scopes) {
    log("[gws-mcp] Logged in, but `gws auth status` did not report scopes, so the new grant could not be verified.");
    return 1;
  }
  const granted = new Set(after.scopes);
  const missing = plan.scopes.filter((s) => !isCovered(s, granted));
  if (missing.length > 0) {
    log(`[gws-mcp] Logged in, but these requested scopes were not granted: ${missing.join(", ")}`);
    const lost = missing.filter((s) => plan.preserved.includes(s));
    if (lost.length > 0) {
      log(`[gws-mcp] The saved credential no longer holds ${lost.length} scope(s) it had before (gws saves only what the consent screen granted).`);
    }
    log(`[gws-mcp] To request the full set again, run: ${retry}`);
    return 1;
  }
  log(`[gws-mcp] Done. The saved credential now holds ${after.scopes.length} scope(s).`);
  return 0;
}
