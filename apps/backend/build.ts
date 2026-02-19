import * as esbuild from "esbuild";
import { execSync } from "child_process";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  platform: "node",
  format: "esm",
  bundle: true,
});

// Build the client entry (used by frontend for RPC types) without bundling
await esbuild.build({
  entryPoints: ["src/client.ts"],
  outdir: "dist",
  platform: "node",
  format: "esm",
  bundle: false,
});

// Generate TypeScript declaration files for frontend type resolution
execSync("tsc --emitDeclarationOnly", { stdio: "inherit" });
