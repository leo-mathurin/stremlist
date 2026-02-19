import honoConfig from "@stremlist/eslint-config/hono";
import prettier from "eslint-config-prettier/flat";

export default [
  { ignores: ["dist/**", "eslint.config.mjs", "build.ts"] },
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
  prettier,
];
