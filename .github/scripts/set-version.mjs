// Writes a new version (argv[2], e.g. "1.5.0") to every source of truth:
//   1. root package.json           — the repo/app version
//   2. packages/shared/constants.ts — ADDON_VERSION, surfaced in the Stremio manifest
//
// The user-facing changelog (apps/frontend/src/pages/Changelog.tsx) is curated by
// hand and intentionally left untouched.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error(`Invalid version argument: ${version}`);
  process.exit(1);
}

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

const constPath = "packages/shared/src/constants.ts";
const src = readFileSync(constPath, "utf8");
const re = /(export const ADDON_VERSION = ")[^"]*(")/;
if (!re.test(src)) {
  console.error(`Could not find ADDON_VERSION in ${constPath}`);
  process.exit(1);
}
writeFileSync(constPath, src.replace(re, `$1${version}$2`));

console.log(`Set version ${version} in ${pkgPath} and ${constPath}`);
