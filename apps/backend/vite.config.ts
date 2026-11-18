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
    // Tests never reach TheTVDB with a key from the shell or a .env file.
    // The live TheTVDB tests use TVDB_LIVE_API_KEY and set the key themselves.
    env: { TVDB_API_KEY: "" },
  },
});
