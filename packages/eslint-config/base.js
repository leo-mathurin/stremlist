import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** @type {import("typescript-eslint").Config} */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
