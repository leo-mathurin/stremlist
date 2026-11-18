import { strict as assert } from "node:assert";
import { appendFileSync } from "node:fs";
import { HttpResponse, http, passthrough } from "msw";
import { setupServer } from "msw/node";
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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function unexpectedLog() {
  const file = process.env.E2E_UNEXPECTED_REQUEST_LOG;
  if (!file) throw new Error("E2E_UNEXPECTED_REQUEST_LOG is not set");
  return file;
}
const unexpectedFile = unexpectedLog();

function refuse(request: Request, reason: string) {
  appendFileSync(
    unexpectedFile,
    `${JSON.stringify({ method: request.method, url: request.url, reason })}\n`,
  );
  return HttpResponse.error();
}

function expected(answer: (body: Record<string, unknown>) => Response) {
  return async ({ request }: { request: Request }) => {
    try {
      const body: unknown = await request.json();
      assert.ok(isRecord(body), "Expected a JSON object body");
      return answer(body);
    } catch (error) {
      return refuse(
        request,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}

function newsletter(body: Record<string, unknown>) {
  assert.equal(body.unsubscribed, false);
  const { email } = body;
  assert.ok(typeof email === "string", "Expected an email");
  assert.match(email, /@example\.test$/);
  const scenario = email.split("@")[0];
  if (scenario === "offline") return HttpResponse.error();
  if (scenario === "success") return Response.json({ id: "fixture-contact" });
  const error = NEWSLETTER_ERRORS.get(scenario);
  assert.ok(error, `Unexpected newsletter scenario ${scenario}`);
  return Response.json(error, { status: error.statusCode });
}

function imdb(body: Record<string, unknown>) {
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

setupServer(
  http.all(
    ({ request }) => LOOPBACK.has(new URL(request.url).hostname),
    () => passthrough(),
  ),
  http.post(
    "https://api.resend.com/audiences/fixture-audience/contacts",
    expected(newsletter),
  ),
  http.post("https://api.graphql.imdb.com/", expected(imdb)),
  http.all("*", ({ request }) =>
    refuse(request, "No fixture answers this request"),
  ),
).listen({ onUnhandledRequest: "error" });
