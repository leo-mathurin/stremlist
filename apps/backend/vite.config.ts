import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    // The `./client` export serves `src/client.ts`: only its types are built.
    entry: ["src/index.ts"],
    platform: "node",
    format: "esm",
    fixedExtension: false,
    // One file, like the esbuild bundle that Vercel served before.
    outputOptions: { codeSplitting: false },
    // Vercel deploys `dist` with only the external modules installed.
    deps: {
      alwaysBundle: [/^(?!@aws-sdk\/client-s3(?:\/|$))/],
      onlyBundle: false,
    },
    // `tsc --emitDeclarationOnly` writes the RPC types for the frontend.
    dts: false,
  },
  test: {
    environment: "node",
    testTimeout: 30000,
  },
});
