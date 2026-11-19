import { defineRule } from "vite-plus/lint/plugins";
import type { ESTree, SourceCode, Variable } from "vite-plus/lint/plugins";

import { resolveVariable } from "../shared/scope.ts";

const SOURCE = "vite-plus/test";

const replacingMethods = new Set([
  "mock",
  "doMock",
  "unmock",
  "doUnmock",
  "unstable_mockModule",
  "stubGlobal",
  "fn",
  "mocked",
  "mockObject",
  "importMock",
  "createMockFromModule",
  "genMockFromModule",
  "setMock",
  "replaceProperty",
  "enableAutomock",
]);

const doubleFactories = new Set(["fn", "spyOn", "mocked"]);

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
  "mockStepResult",
  "mockStepError",
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

function keyName(node: ESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function importedName(node: ESTree.Node): string | null {
  if (node.type !== "ImportSpecifier") return null;
  return node.imported.type === "Identifier" ? node.imported.name : String(node.imported.value);
}

function fromVitePlusTest(parent: ESTree.Node | null) {
  return parent?.type === "ImportDeclaration" && parent.source.value === SOURCE;
}

function declaratorOf(variable: Variable) {
  const definition = variable.defs[0];
  return variable.defs.length === 1 &&
    definition?.type === "Variable" &&
    definition.node.type === "VariableDeclarator"
    ? definition.node
    : null;
}

function isReference(node: ESTree.Node): node is ESTree.IdentifierReference {
  return node.type === "Identifier";
}

/** The binding of an identifier, or null for a global or an unknown name. */
function bindingOf(sourceCode: SourceCode, node: ESTree.Node) {
  return isReference(node) ? resolveVariable(sourceCode, node) : null;
}

/** Whether `node` is the namespace object of `import * as x from "vite-plus/test"`. */
function isNamespace(sourceCode: SourceCode, node: ESTree.Node) {
  const definition = bindingOf(sourceCode, node)?.defs[0];
  return (
    definition?.type === "ImportBinding" &&
    definition.node.type === "ImportNamespaceSpecifier" &&
    fromVitePlusTest(definition.parent)
  );
}

/** Whether `node` evaluates to the `vi` object of `vite-plus/test`. */
function isVi(sourceCode: SourceCode, node: ESTree.Node, depth = 0): boolean {
  if (depth > 8) return false;
  if (node.type === "MemberExpression") {
    return propertyName(node) === "vi" && isNamespace(sourceCode, node.object);
  }
  const variable = bindingOf(sourceCode, node);
  if (!variable) return false;
  const definition = variable.defs[0];
  if (definition?.type === "ImportBinding") {
    return importedName(definition.node) === "vi" && fromVitePlusTest(definition.parent);
  }
  const declarator = declaratorOf(variable);
  if (!declarator?.init) return false;
  if (declarator.id.type === "Identifier") {
    return isVi(sourceCode, declarator.init, depth + 1);
  }
  if (declarator.id.type === "ObjectPattern" && isNamespace(sourceCode, declarator.init)) {
    return declarator.id.properties.some(
      (property) =>
        property.type === "Property" &&
        keyName(property.key) === "vi" &&
        property.value.type === "Identifier" &&
        property.value.name === variable.name,
    );
  }
  return false;
}

/** The `vi` method that `node` refers to, through members, aliases and destructuring. */
function viMethod(sourceCode: SourceCode, node: ESTree.Node, depth = 0): string | null {
  if (depth > 8) return null;
  if (node.type === "MemberExpression") {
    return isVi(sourceCode, node.object) ? propertyName(node) : null;
  }
  const variable = bindingOf(sourceCode, node);
  if (!variable) return null;
  const declarator = declaratorOf(variable);
  if (!declarator?.init) return null;
  if (declarator.id.type === "Identifier") {
    return viMethod(sourceCode, declarator.init, depth + 1);
  }
  if (declarator.id.type === "ObjectPattern" && isVi(sourceCode, declarator.init)) {
    for (const property of declarator.id.properties) {
      if (
        property.type === "Property" &&
        property.value.type === "Identifier" &&
        property.value.name === variable.name
      ) {
        return keyName(property.key);
      }
    }
  }
  return null;
}

/** Whether `node` evaluates to a mock or spy that `vi` made. */
function isViDouble(sourceCode: SourceCode, node: ESTree.Node, depth = 0): boolean {
  if (depth > 8) return false;
  if (node.type === "CallExpression") {
    const { callee } = node;
    if (callee.type === "MemberExpression" && mockSetters.has(propertyName(callee) ?? "")) {
      return isViDouble(sourceCode, callee.object, depth + 1);
    }
    return doubleFactories.has(viMethod(sourceCode, callee) ?? "");
  }
  const variable = bindingOf(sourceCode, node);
  const declarator = variable && declaratorOf(variable);
  return (
    declarator?.id.type === "Identifier" &&
    declarator.init !== null &&
    declarator.init !== undefined &&
    isViDouble(sourceCode, declarator.init, depth + 1)
  );
}

/**
 * The mock setter that `node` refers to on a mock or spy that `vi` made:
 * a member (`spy.mockReturnValue`), an alias (`const set =
 * spy.mockReturnValue`) or a destructured name (`const { mockReturnValue } =
 * spy`). Null otherwise.
 */
function viSetter(sourceCode: SourceCode, node: ESTree.Node, depth = 0): string | null {
  if (depth > 8) return null;
  if (node.type === "MemberExpression") {
    const name = propertyName(node);
    return name !== null && mockSetters.has(name) && isViDouble(sourceCode, node.object)
      ? name
      : null;
  }
  const variable = bindingOf(sourceCode, node);
  if (!variable) return null;
  const declarator = declaratorOf(variable);
  if (!declarator?.init) return null;
  if (declarator.id.type === "Identifier") {
    return viSetter(sourceCode, declarator.init, depth + 1);
  }
  if (declarator.id.type === "ObjectPattern" && isViDouble(sourceCode, declarator.init)) {
    for (const property of declarator.id.properties) {
      const name = property.type === "Property" ? keyName(property.key) : null;
      if (
        property.type === "Property" &&
        property.value.type === "Identifier" &&
        property.value.name === variable.name &&
        name !== null &&
        mockSetters.has(name)
      ) {
        return name;
      }
    }
  }
  return null;
}

/**
 * Ban the Vitest test double APIs when `vi` comes from `vite-plus/test`.
 * Landmines `no-test-doubles` sees only `vitest` imports, so this rule closes
 * that gap. It follows `vi` through lexical bindings (aliases, destructuring,
 * namespace imports) and ignores shadowing names. Observing spies
 * (`vi.spyOn` without a mock setter), fake timers and `vi.stubEnv` stay
 * allowed.
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
    return {
      CallExpression(node) {
        const { sourceCode } = context;
        const method = viMethod(sourceCode, node.callee);
        if (method !== null && replacingMethods.has(method)) {
          context.report({ node, messageId: "replacement", data: { name: `vi.${method}` } });
          return;
        }
        const setter = viSetter(sourceCode, node.callee);
        if (setter !== null) {
          context.report({ node, messageId: "replacement", data: { name: setter } });
        }
      },
    };
  },
});
