// Loaded only by the isolated provider-contract backend process. The real SDK,
// GraphQL parser and HTTP handlers run; every outbound request is intercepted.
// No fallback to native fetch is permitted, including for unexpected hosts.
import { strict as assert } from "node:assert";

Object.defineProperty(globalThis, "fetch", {
  value: async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(request.method, "POST");
    const body = await request.json();
    if (url.origin === "https://api.resend.com") {
      assert.equal(url.pathname, "/audiences/fixture-audience/contacts");
      assert.equal(body.unsubscribed, false);
      assert.match(body.email, /@example\.test$/);
      const scenario = body.email.split("@")[0];
      if (scenario === "offline")
        throw new TypeError("Fixture provider offline");
      if (scenario === "success")
        return Response.json({ id: "fixture-contact" });
      const errors: Record<
        string,
        { statusCode: number; message: string; name: string }
      > = {
        duplicate: {
          statusCode: 409,
          name: "validation_error",
          message: "Contact already exists",
        },
        invalid: {
          statusCode: 422,
          name: "validation_error",
          message: "Invalid email address",
        },
        unauthorized: {
          statusCode: 401,
          name: "validation_error",
          message: "Invalid API key",
        },
        unavailable: {
          statusCode: 503,
          name: "application_error",
          message: "Provider unavailable",
        },
      };
      const error = errors[scenario];
      assert.ok(error, `Unexpected newsletter scenario ${scenario}`);
      return Response.json(error, { status: error.statusCode });
    }
    if (url.origin === "https://api.graphql.imdb.com") {
      assert.equal(body.operationName, "ValidateList");
      assert.match(body.query, /list\(id: \$listId\)/);
      const id = body.variables.listId;
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
