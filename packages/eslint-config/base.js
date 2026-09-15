import noBarrels from "./no-barrels.js";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** @type {import("typescript-eslint").Config} */
export default [
  ...noBarrels,
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
