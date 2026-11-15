import { defineConfig } from "vite-plus";

const generatedFiles = ["packages/shared/src/database.types.ts"];

export default defineConfig({
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "import"],
    categories: { correctness: "error" },
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    ignorePatterns: [
      "**/dist/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      ".agents/**",
      ".claude/**",
      "tools/oxlint/anti-slop/**",
      // k6 runs these load scripts with its own globals and modules.
      "apps/backend/stress/k6/**",
      ...generatedFiles,
    ],
    options: {
      typeAware: true,
      typeCheck: false,
      denyWarnings: true,
      reportUnusedDisableDirectives: "error",
      respectEslintDisableDirectives: false,
    },
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      eqeqeq: ["error", "smart"],
      "no-unused-expressions": [
        "error",
        {
          allowShortCircuit: false,
          allowTernary: false,
          allowTaggedTemplates: false,
          enforceForJSX: true,
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@stremlist/shared",
              message:
                "Import from the defining @stremlist/shared subpath instead.",
            },
          ],
        },
      ],
      "oxc/no-barrel-file": ["error", { threshold: 0 }],
      "typescript/consistent-type-imports": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              package: "node:test",
              name: ["describe", "it", "suite", "test"],
            },
          ],
        },
      ],
      "typescript/no-misused-promises": "error",
      "typescript/await-thenable": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "typescript/ban-ts-comment": [
        "error",
        { "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": true },
      ],
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "import/no-cycle": "error",
      "import/no-duplicates": "error",
      "import/first": "error",
    },
    overrides: [
      {
        // Plain JavaScript has no types to check, so every value is `any`.
        files: ["**/*.{js,mjs}"],
        rules: {
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
        },
      },
      {
        files: ["apps/frontend/src/**/*.{ts,tsx}"],
        plugins: ["react", "jsx-a11y"],
        jsPlugins: [
          { name: "react-hooks-js", specifier: "eslint-plugin-react-hooks" },
        ],
        env: { browser: true },
        rules: {
          "react-hooks-js/todo": "error",
          "react/rules-of-hooks": "error",
          "react/react-in-jsx-scope": "off",
          "react/exhaustive-deps": "error",
          "react/immutability": "error",
          "react/purity": "error",
          "react/refs": "error",
          "react/globals": "error",
          "react/set-state-in-effect": "error",
          "react/set-state-in-render": "error",
          "react/static-components": "error",
          "react/unsupported-syntax": "error",
          "react/rule-suppression": "error",
          "react/only-export-components": [
            "error",
            { allowConstantExport: true },
          ],
          "jsx-a11y/prefer-tag-over-role": "off",
        },
      },
      {
        files: ["apps/frontend/src/components/ui/**/*.tsx"],
        rules: { "react/only-export-components": "off" },
      },
      {
        // Mirrors the awaitable Supabase query builder, which has `then`.
        files: ["apps/backend/src/__tests__/helpers/supabase/query-builder.ts"],
        rules: { "unicorn/no-thenable": "off" },
      },
      {
        files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
        plugins: ["vitest"],
        rules: {
          "vitest/no-focused-tests": "error",
          "vitest/no-disabled-tests": "error",
          "vitest/require-mock-type-parameters": "off",
          "vitest/require-to-throw-message": "off",
          "vitest/no-conditional-expect": "off",
        },
      },
    ],
  },
  fmt: {
    printWidth: 80,
    sortPackageJson: false,
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules",
      "**/.turbo",
      "**/coverage",
      // Recorded toolkit runs, replayed by content hash.
      "apps/e2e/.e2e/**",
      "tools/oxlint/anti-slop/**",
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
});
