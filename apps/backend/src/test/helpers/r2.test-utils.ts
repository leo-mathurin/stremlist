import { http, HttpResponse } from "msw";
import { createHash } from "node:crypto";

const LIST_PAGE_SIZE = 2;

/**
 * The objects of the in-memory R2 bucket. Text objects are kept as text, so a
 * test can read and seed them; other objects are kept as latin1 text.
 */
export const r2Objects = new Map<string, string>();

const binaryKeys = new Set<string>();

/** Keys that a bulk delete reports as failed, like a store that keeps them. */
export const r2Undeletable = new Set<string>();

/** Keys whose reads fail, like a store that has an outage. */
export const r2Unreadable = new Set<string>();

/** Key prefixes whose writes fail, like a store that refuses them. */
export const r2Unwritable = new Set<string>();

/**
 * Writes seen, and a hook that runs just before each write is checked, so a
 * test can play another instance that writes in between.
 */
interface R2Puts {
  count: number;
  before: ((key: string) => void | Promise<void>) | null;
}

export const r2Puts: R2Puts = { count: 0, before: null };

/** Empties the bucket and clears every switch. */
export function resetR2() {
  r2Objects.clear();
  binaryKeys.clear();
  r2Undeletable.clear();
  r2Unreadable.clear();
  r2Unwritable.clear();
  r2Puts.count = 0;
  r2Puts.before = null;
}

/** The bytes of a stored object, or undefined. */
export function r2Bytes(key: string) {
  const stored = r2Objects.get(key);
  if (stored === undefined) return undefined;
  return Buffer.from(stored, binaryKeys.has(key) ? "latin1" : "utf8");
}

/** Stores bytes under `key`, as text when they are UTF-8 text. */
export function putR2Bytes(key: string, bytes: Buffer) {
  const asText = bytes.toString("utf8");
  if (Buffer.from(asText, "utf8").equals(bytes)) {
    r2Objects.set(key, asText);
    binaryKeys.delete(key);
  } else {
    r2Objects.set(key, bytes.toString("latin1"));
    binaryKeys.add(key);
  }
}

function etagOf(bytes: Buffer) {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function unescapeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function xml(body: string, status = 200) {
  return new HttpResponse(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function s3Error(code: string, status: number) {
  return xml(
    `<Error><Code>${code}</Code><Message>${code}</Message></Error>`,
    status,
  );
}

function bucketUrl() {
  const endpoint = process.env.R2_ENDPOINT ?? "http://r2.test";
  const bucket = process.env.R2_BUCKET ?? "test-bucket";
  return `${endpoint.replace(/\/$/, "")}/${bucket}`;
}

function keyOf(request: Request, bucket: string) {
  const path = new URL(request.url).pathname;
  const prefix = `${new URL(bucket).pathname}/`;
  return decodeURIComponent(path.slice(prefix.length));
}

async function putObject(request: Request, key: string) {
  r2Puts.count += 1;
  await r2Puts.before?.(key);
  if ([...r2Unwritable].some((prefix) => key.startsWith(prefix))) {
    return s3Error("AccessDenied", 403);
  }
  const current = r2Bytes(key);
  const ifNoneMatch = request.headers.get("If-None-Match");
  const ifMatch = request.headers.get("If-Match");
  if (ifNoneMatch === "*" && current !== undefined) {
    return s3Error("PreconditionFailed", 412);
  }
  if (
    ifMatch !== null &&
    (current === undefined || etagOf(current) !== ifMatch)
  ) {
    return s3Error("PreconditionFailed", 412);
  }
  const bytes = Buffer.from(await request.arrayBuffer());
  putR2Bytes(key, bytes);
  return new HttpResponse(null, {
    status: 200,
    headers: { ETag: etagOf(bytes) },
  });
}

function getObject(key: string) {
  if (r2Unreadable.has(key)) return s3Error("AccessDenied", 403);
  const bytes = r2Bytes(key);
  if (bytes === undefined) return s3Error("NoSuchKey", 404);
  return new HttpResponse(bytes, {
    status: 200,
    headers: {
      ETag: etagOf(bytes),
      "Content-Length": String(bytes.length),
    },
  });
}

function listObjects(url: URL) {
  const prefix = url.searchParams.get("prefix") ?? "";
  const after = url.searchParams.get("continuation-token") ?? "";
  const keys = [...r2Objects.keys()]
    .filter((key) => key.startsWith(prefix) && key > after)
    .sort();
  const page = keys.slice(0, LIST_PAGE_SIZE);
  const truncated = keys.length > LIST_PAGE_SIZE;
  const contents = page
    .map((key) => `<Contents><Key>${escapeXml(key)}</Key></Contents>`)
    .join("");
  const next = truncated
    ? `<NextContinuationToken>${escapeXml(page.at(-1) ?? "")}</NextContinuationToken>`
    : "";
  return xml(
    `<ListBucketResult><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${contents}${next}</ListBucketResult>`,
  );
}

async function deleteObjects(request: Request) {
  const body = await request.text();
  const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) =>
    unescapeXml(match[1]),
  );
  const results = keys.map((key) => {
    if (r2Undeletable.has(key)) {
      return `<Error><Key>${escapeXml(key)}</Key><Code>AccessDenied</Code><Message>AccessDenied</Message></Error>`;
    }
    r2Objects.delete(key);
    binaryKeys.delete(key);
    return `<Deleted><Key>${escapeXml(key)}</Key></Deleted>`;
  });
  return xml(`<DeleteResult>${results.join("")}</DeleteResult>`);
}

function r2HandlersFor(bucket: string) {
  return [
    http.get(bucket, ({ request }) => listObjects(new URL(request.url))),
    http.post(bucket, ({ request }) => {
      if (!new URL(request.url).searchParams.has("delete")) {
        return s3Error("NotImplemented", 501);
      }
      return deleteObjects(request);
    }),
    http.put(`${bucket}/*`, ({ request }) =>
      putObject(request, keyOf(request, bucket)),
    ),
    http.get(`${bucket}/*`, ({ request }) => getObject(keyOf(request, bucket))),
    http.delete(`${bucket}/*`, ({ request }) => {
      const key = keyOf(request, bucket);
      r2Objects.delete(key);
      binaryKeys.delete(key);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

/**
 * MSW handlers that serve the in-memory bucket over the S3 HTTP API, so the
 * real R2 client of `lib/r2` reads and writes it.
 */
export const r2Handlers = r2HandlersFor(bucketUrl());
