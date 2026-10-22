// Cross-platform test runner: expands tests/*.test.mjs ourselves so the npm
// test script works identically on POSIX shells and Windows cmd.exe (which
// never expands globs and where Node 20 also refuses to do it).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const testsDir = path.join(root, "tests");
const files = readdirSync(testsDir)
  // "._name" files are macOS AppleDouble sidecars that appear when the repo
  // lives on a non-APFS volume; they are not tests.
  .filter((f) => f.endsWith(".test.mjs") && !f.startsWith("._"))
  .sort()
  .map((f) => path.join(testsDir, f));

if (files.length === 0) {
  console.error("No *.test.mjs files found in", testsDir);
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
