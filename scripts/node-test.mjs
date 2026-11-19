// Runs every *.test.mjs file in the given directories with `node --test`.
// Shell globs are not expanded on Windows, and Node 20 cannot expand them itself.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = process.argv.slice(2).flatMap(directory =>
  readdirSync(directory).filter(name => name.endsWith(".test.mjs")).sort().map(name => join(directory, name)));
if (!files.length) { console.error("no test files found"); process.exit(1); }
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
