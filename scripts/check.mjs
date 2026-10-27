import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set([
  "node_modules",
  ".git",
  ".local",
  ".wrangler",
  ".build",
  ".swiftpm",
  "data",
  "snapshots",
  "DerivedData",
  "test-results",
  "playwright-report",
]);
const obsolete =
  /sea[-_ ]?sky[-_ ]?masker|seaskymasker|rasterrill|masksmith|ballrollergames\.com|ParallaxFieldLab|BRGIdentity/i;
let checked = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (entry.name.endsWith(".mjs")) {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
      checked++;
    }
    if (
      /\.(swift|mjs|html|css|json|jsonc|plist|pbxproj|xcscheme|yml|md)$/.test(
        path,
      ) &&
      path !== fileURLToPath(import.meta.url) &&
      !path.endsWith("MIGRATION.md")
    ) {
      if (obsolete.test(await readFile(path, "utf8")))
        throw new Error(
          `Obsolete brand/private service reference: ${relative(root, path)}`,
        );
    }
  }
}
await walk(root);
console.log(
  `HorizonScribe: ${checked} JavaScript modules pass syntax checks; naming/privacy references checked.`,
);
