import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vite-plus/test";
import { useMswServer } from "../../test/helpers/msw.test-utils";
import {
  HttpError,
  providerFetch,
  providerFetchJson,
  sourceErrorFromHttp,
} from "../http";
import { SourceUnavailableError } from "../types";

const server = useMswServer();

function serveItems(response: () => Response) {
  const requests: Request[] = [];
  server.use(
    http.all("https://api.example.test/items", ({ request }) => {
      requests.push(request);
      return response();
    }),
  );
  return requests;
}

describe("providerFetch", () => {
  it("sets the query, the JSON body and the bearer token", async () => {
    const requests = serveItems(() => HttpResponse.json({}));
    await providerFetch("https://api.example.test/items?sort=asc", {
      method: "POST",
      query: { page: "2", sort: "desc" },
      json: { ids: [1] },
      bearer: "token-1",
    });
    const [request] = requests;
    expect(request.url).toBe("https://api.example.test/items?sort=desc&page=2");
    expect(request.headers.get("Authorization")).toBe("Bearer token-1");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(request.headers.get("User-Agent")).toMatch(/^Stremlist\//);
    expect(await request.text()).toBe('{"ids":[1]}');
  });

  it("sends no Authorization header without a token", async () => {
    const requests = serveItems(() => HttpResponse.json({}));
    await providerFetch("https://api.example.test/items", { bearer: "" });
    const [request] = requests;
    expect(request.url).toBe("https://api.example.test/items");
    expect(request.headers.has("Authorization")).toBe(false);
  });
});

describe("providerFetchJson", () => {
  it("throws HttpError with the body on non-2xx", async () => {
    serveItems(() => new HttpResponse("nope", { status: 503 }));
    await expect(
      providerFetchJson("https://api.example.test/items", {
        retryOn429: false,
      }),
    ).rejects.toMatchObject({ name: "HttpError", status: 503, body: "nope" });
  });
});

describe("sourceErrorFromHttp", () => {
  const error = new HttpError(404, "", "https://api.example.test/x");

  it("maps a known status to its reason", () => {
    const mapped = sourceErrorFromHttp(error, { 404: "not_found" });
    expect(mapped).toBeInstanceOf(SourceUnavailableError);
    expect(mapped).toMatchObject({
      reason: "not_found",
      message: "HTTP 404 from api.example.test",
    });
  });

  it("uses the given message", () => {
    expect(
      sourceErrorFromHttp(error, { 404: "not_found" }, (reason) => reason),
    ).toMatchObject({ message: "not_found" });
  });

  it("returns other statuses and other errors unchanged", () => {
    expect(sourceErrorFromHttp(error, { 403: "private" })).toBe(error);
    const other = new Error("boom");
    expect(sourceErrorFromHttp(other, { 404: "not_found" })).toBe(other);
  });
});
