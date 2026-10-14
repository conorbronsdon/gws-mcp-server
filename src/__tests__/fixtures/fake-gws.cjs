#!/usr/bin/env node
// Stand-in for the gws CLI's auth commands, backed by a JSON "token store" at
// $FAKE_GWS_STORE: { "scopes": string[] | null }. Mirrors gws 0.22.5:
// `auth status` reports auth_method plus the live-discovered scopes, and
// `auth login` REPLACES the stored grant with whatever it was asked for.
const fs = require("node:fs");
const store = process.env.FAKE_GWS_STORE;
const read = () => JSON.parse(fs.readFileSync(store, "utf8"));
const args = process.argv.slice(2);
const IDENTITY = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile"];

if (args[0] === "auth" && args[1] === "status") {
  const { scopes } = read();
  const out = { auth_method: scopes ? "oauth2" : "none", storage: scopes ? "encrypted" : "none" };
  if (scopes) Object.assign(out, { token_valid: true, scopes, scope_count: scopes.length });
  process.stdout.write(JSON.stringify(out, null, 2));
} else if (args[0] === "auth" && args[1] === "login") {
  const i = args.indexOf("--scopes");
  if (i < 0) { process.stderr.write("fake-gws: only --scopes logins are modelled\n"); process.exit(3); }
  const requested = args[i + 1].split(",");
  fs.writeFileSync(store, JSON.stringify({ scopes: [...new Set([...requested, ...IDENTITY])] }));
  fs.appendFileSync(store + ".log", JSON.stringify(args) + "\n");
} else {
  process.stderr.write(`fake-gws: unsupported ${args.join(" ")}\n`);
  process.exit(3);
}
