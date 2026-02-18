import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outdir: "dist",
  platform: "node",
  format: "esm",
  bundle: true,
});
