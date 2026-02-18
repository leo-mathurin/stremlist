import baseConfig from "@stremlist/eslint-config/base";
import turboConfig from "@stremlist/eslint-config/turbo";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist/**"]),
  ...turboConfig,
  {
    files: ["**/*.ts"],
    extends: baseConfig,
  },
]);
