#!/usr/bin/env node
// Stand-in for the gws Drive commands drive_files_download makes. Metadata
// comes from $FAKE_DRIVE_META (JSON), file bytes from $FAKE_DRIVE_CONTENT
// (base64). `drive files get` without -o prints the metadata; `drive files
// get|export ... -o <path>` writes the bytes to <path>. Synthetic data only.
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args.indexOf("-o");
const cmd = args.slice(0, 3).join(" ");
if (cmd !== "drive files get" && cmd !== "drive files export") {
  process.stderr.write(`fake-gws-drive: unsupported ${args.join(" ")}\n`);
  process.exit(3);
}
if (out >= 0) {
  fs.writeFileSync(args[out + 1], Buffer.from(process.env.FAKE_DRIVE_CONTENT || "", "base64"));
} else {
  process.stdout.write(process.env.FAKE_DRIVE_META || "{}");
}
