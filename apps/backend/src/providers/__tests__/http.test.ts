import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpError,
  providerFetch,
  providerFetchJson,
  sourceErrorFromHttp,
} from "../http";
import { SourceUnavailableError } from "../types";

function mockFetch(response: () => Response) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(response()));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("providerFetch", () => {
  it("sets the query, the JSON body and the bearer token", async () => {
    const fetchMock = mockFetch(() => new Response("{}"));
    await providerFetch("https://api.example.test/items?sort=asc", {
      method: "POST",
      query: { page: "2", sort: "desc" },
      json: { ids: [1] },
      bearer: "token-1",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/items?sort=desc&page=2");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-1");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("User-Agent")).toMatch(/^Stremlist\//);
    expect(init?.body).toBe('{"ids":[1]}');
  });

  it("sends no Authorization header without a token", async () => {
    const fetchMock = mockFetch(() => new Response("{}"));
    await providerFetch("https://api.example.test/items", { bearer: "" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/items");
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  });
});

describe("providerFetchJson", () => {
  it("throws HttpError with the body on non-2xx", async () => {
    mockFetch(() => new Response("nope", { status: 503 }));
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
