import baseConfig from "@stremlist/eslint-config/base";
import prettier from "eslint-config-prettier/flat";

export default [
  { ignores: ["eslint.config.mjs", "playwright-report/**", "test-results/**"] },
  ...baseConfig,
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
