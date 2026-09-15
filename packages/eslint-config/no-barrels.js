export default [
  {
    rules: {
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
    },
  },
  {
    files: ["**/index.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ExportAllDeclaration, ExportNamedDeclaration[source!=null], ExportNamedDeclaration > ExportSpecifier",
          message:
            "Barrel index files are not allowed. Import from the defining module instead.",
        },
      ],
    },
  },
];
