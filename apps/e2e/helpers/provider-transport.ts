// Loaded only by the isolated provider-contract backend process. The real SDK,
// GraphQL parser and HTTP handlers run; every outbound request is intercepted.
// No fallback to native fetch is permitted, including for unexpected hosts.
import { strict as assert } from "node:assert";
import { isRecord } from "./json.js";

const NEWSLETTER_ERRORS = new Map([
  [
    "duplicate",
    {
      statusCode: 409,
      name: "validation_error",
      message: "Contact already exists",
    },
  ],
  [
    "invalid",
    {
      statusCode: 422,
      name: "validation_error",
      message: "Invalid email address",
    },
  ],
  [
    "unauthorized",
    {
      statusCode: 401,
      name: "validation_error",
      message: "Invalid API key",
    },
  ],
  [
    "unavailable",
    {
      statusCode: 503,
      name: "application_error",
      message: "Provider unavailable",
    },
  ],
]);

Object.defineProperty(globalThis, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(request.method, "POST");
    const body: unknown = await request.json();
    assert.ok(isRecord(body), "Expected a JSON object body");
    if (url.origin === "https://api.resend.com") {
      assert.equal(url.pathname, "/audiences/fixture-audience/contacts");
      assert.equal(body.unsubscribed, false);
      const { email } = body;
      assert.ok(typeof email === "string", "Expected an email");
      assert.match(email, /@example\.test$/);
      const scenario = email.split("@")[0];
      if (scenario === "offline")
        throw new TypeError("Fixture provider offline");
      if (scenario === "success")
        return Response.json({ id: "fixture-contact" });
      const error = NEWSLETTER_ERRORS.get(scenario);
      assert.ok(error, `Unexpected newsletter scenario ${scenario}`);
      return Response.json(error, { status: error.statusCode });
    }
    if (url.origin === "https://api.graphql.imdb.com") {
      const { operationName, query, variables } = body;
      assert.equal(operationName, "ValidateList");
      assert.ok(typeof query === "string", "Expected a GraphQL query");
      assert.match(query, /list\(id: \$listId\)/);
      assert.ok(isRecord(variables), "Expected GraphQL variables");
      const id = variables.listId;
      assert.ok(typeof id === "string", "Expected a list ID");
      switch (id) {
        case "ls99000001":
          return Response.json({
            data: { list: { id, visibility: { id: "PUBLIC" } } },
          });
        case "ls99000002":
          return Response.json({
            data: { list: { id, visibility: { id: "PRIVATE" } } },
          });
        case "ls99000003":
          return Response.json({
            errors: [
              { message: "Not permitted", extensions: { code: "FORBIDDEN" } },
            ],
          });
        case "ls99000004":
          return Response.json({ data: { list: null } });
        default:
          throw new Error(`Unexpected IMDb list ${id}`);
      }
    }
    throw new Error(
      `Provider fixture refuses outbound request to ${url.origin}`,
    );
  },
});
