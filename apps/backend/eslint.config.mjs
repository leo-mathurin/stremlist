import honoConfig from "@stremlist/eslint-config/hono";
import prettier from "eslint-config-prettier/flat";

export default [
  {
    ignores: [
      "dist/**",
      "eslint.config.mjs",
      "build.ts",
      "vitest.config.ts",
      // Load test scripts run by k6, not Node: no k6 types to lint against.
      "stress/k6/**",
    ],
  },
  ...honoConfig,
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      curly: ["error", "multi-line"],
    },
  },
  {
    files: ["stress/**/*.ts"],
    languageOptions: {
      parserOptions: { project: "./stress/tsconfig.json" },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      parserOptions: {
        project: null,
        projectService: { allowDefaultProject: ["scripts/*.mjs"] },
      },
    },
  },
  prettier,
];
