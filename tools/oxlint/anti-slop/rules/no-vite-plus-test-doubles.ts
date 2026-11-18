import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree } from "vite-plus/lint/plugins";

const SOURCE = "vite-plus/test";

const replacingMethods = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "stubGlobal",
  "fn",
  "mocked",
  "importMock",
]);

const mockSetters = new Set([
  "mockImplementation",
  "mockImplementationOnce",
  "mockReturnValue",
  "mockReturnValueOnce",
  "mockResolvedValue",
  "mockResolvedValueOnce",
  "mockRejectedValue",
  "mockRejectedValueOnce",
  "mockReturnThis",
  "withImplementation",
]);

function propertyName(node: ESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  if (node.property.type === "Literal" && typeof node.property.value === "string") {
    return node.property.value;
  }
  return null;
}

/**
 * Ban the Vitest test double APIs when `vi` comes from `vite-plus/test`.
 * Landmines `no-test-doubles` sees only `vitest` imports, so this rule closes
 * that gap. Observing spies (`vi.spyOn` without a mock setter), fake timers
 * and `vi.stubEnv` stay allowed.
 */
export const noVitePlusTestDoublesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow vi.mock, vi.doMock, vi.stubGlobal, vi.fn, vi.mocked and mock setters when vi comes from vite-plus/test.",
    },
    messages: {
      replacement:
        "Do not replace test dependency behavior with `{{name}}`. Use the real implementation, the in-memory resources and MSW; spies must only observe.",
    },
  },
  createOnce(context) {
    const viNames = new Set<string>();
    const namespaces = new Set<string>();
    let importsVitePlusTest = false;

    function isVi(node: ESTree.Node): boolean {
      if (node.type === "Identifier") return viNames.has(node.name);
      return (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        namespaces.has(node.object.name) &&
        propertyName(node) === "vi"
      );
    }

    return {
      Program() {
        viNames.clear();
        namespaces.clear();
        importsVitePlusTest = false;
      },
      ImportDeclaration(node) {
        if (node.source.value !== SOURCE) return;
        importsVitePlusTest = true;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          } else if (
            specifier.type === "ImportSpecifier" &&
            (specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value) === "vi"
          ) {
            viNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (!importsVitePlusTest || node.callee.type !== "MemberExpression") {
          return;
        }
        const name = propertyName(node.callee);
        if (name === null) return;
        if (replacingMethods.has(name) && isVi(node.callee.object)) {
          context.report({ node, messageId: "replacement", data: { name: `vi.${name}` } });
        } else if (mockSetters.has(name)) {
          context.report({ node, messageId: "replacement", data: { name } });
        }
      },
    };
  },
});
