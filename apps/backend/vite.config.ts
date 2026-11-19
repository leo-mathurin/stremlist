import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  pack: {
    /** The `./client` export serves `src/client.ts`: only its types are built. */
    entry: ["src/index.ts"],
    platform: "node",
    format: "esm",
    fixedExtension: false,
    /** One file, like the esbuild bundle that Vercel served before. */
    outputOptions: { codeSplitting: false },
    /** Vercel deploys `dist` with only the external modules installed. */
    deps: {
      alwaysBundle: [/^(?!@aws-sdk\/client-s3(?:\/|$))/],
      onlyBundle: false,
    },
    /** `tsc --emitDeclarationOnly` writes the RPC types for the frontend. */
    dts: false,
  },
  test: {
    environment: "node",
    testTimeout: 30000,
    /**
     * The live suites call real services. Only `test:live` runs them, with
     * STREMLIST_LIVE_TESTS set, so a plain `vp test run` never finds them.
     */
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.STREMLIST_LIVE_TESTS ? [] : ["**/*.live.test.ts"]),
    ],
    /**
     * Tests never reach TheTVDB with a key from the shell or a .env file.
     * The live TheTVDB tests use TVDB_LIVE_API_KEY and set the key themselves.
     */
    env: {
      TVDB_API_KEY: "",
      /**
       * The real Supabase, R2 and Resend clients run in tests. Their hosts
       * are reserved test names that MSW answers from in-memory stores.
       */
      SUPABASE_URL: "http://supabase.test",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      R2_ENDPOINT: "http://r2.test",
      R2_ACCESS_KEY_ID: "test-access-key",
      R2_SECRET_ACCESS_KEY: "test-secret-key",
      R2_BUCKET: "test-bucket",
      RESEND_API_KEY: "re_test",
    },
  },
});
