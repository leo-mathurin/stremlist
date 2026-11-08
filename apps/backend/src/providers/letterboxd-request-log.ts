import { supabase } from "../lib/supabase";
import type { ReadPriority } from "./read-priority";

/**
 * What one Letterboxd request saw, for the request log
 * (supabase/migrations/20261108130000_letterboxd_request_log.sql): every
 * failed request in full, 1% of the others, and per-minute counts of all.
 */
export interface LetterboxdRequestDetails {
  kind: "collection" | "film" | "short_link";
  url: string;
  /** Null when no HTTP response arrived (network error, timeout). */
  status: number | null;
  bytes: number | null;
  /** The network or reading error, when there was one. */
  error: string | null;
  cfRay: string | null;
  cfMitigated: string | null;
  cfCacheStatus: string | null;
  retryAfter: string | null;
  server: string | null;
  /** The first 2 KB of the body, kept for failed requests only. */
  bodyExcerpt: string | null;
}

const EXCERPT_BYTES = 2048;
/** Share of successful requests logged in full, to compare with failures. */
const SUCCESS_SAMPLE = 0.01;

export function requestDetails(
  kind: LetterboxdRequestDetails["kind"],
  url: string,
): LetterboxdRequestDetails {
  return {
    kind,
    url,
    status: null,
    bytes: null,
    error: null,
    cfRay: null,
    cfMitigated: null,
    cfCacheStatus: null,
    retryAfter: null,
    server: null,
    bodyExcerpt: null,
  };
}

/** Copy the status and the headers that explain a refusal. */
export function noteResponse(
  details: LetterboxdRequestDetails,
  response: Response,
) {
  const header = (name: string) => response.headers.get(name);
  details.status = response.status;
  details.cfRay = header("cf-ray");
  details.cfMitigated = header("cf-mitigated");
  details.cfCacheStatus = header("cf-cache-status");
  details.retryAfter = header("retry-after");
  details.server = header("server");
}

/** Read the first 2 KB of a body we do not otherwise use, then drop the rest. */
export async function noteExcerpt(
  details: LetterboxdRequestDetails,
  response: Response,
) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < EXCERPT_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      bytes += part.value.byteLength;
    }
  } catch {
    /* The excerpt is best effort. */
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  details.bodyExcerpt = excerpt(Buffer.concat(chunks).toString("utf8"));
}

export function excerpt(text: string): string {
  return Buffer.from(text, "utf8")
    .subarray(0, EXCERPT_BYTES)
    .toString("utf8")
    .replace(/�+$/, "");
}

export interface LetterboxdRequestEntry extends LetterboxdRequestDetails {
  outcome: "ok" | "rate_limited" | "blocked" | "failed";
  durationMs: number;
  waitMs: number;
  priority: ReadPriority;
  probe: boolean;
}

/** Log one request. Best effort: a failed write never affects a read. */
export async function recordLetterboxdRequest(entry: LetterboxdRequestEntry) {
  const keep = entry.outcome !== "ok" || Math.random() < SUCCESS_SAMPLE;
  const { error } = await supabase.rpc("letterboxd_record", {
    p_request: {
      outcome: entry.outcome,
      page_kind: entry.kind,
      url: entry.url,
      status: entry.status,
      duration_ms: Math.round(entry.durationMs),
      bytes: entry.bytes,
      error: entry.error,
      cf_ray: entry.cfRay,
      cf_mitigated: entry.cfMitigated,
      cf_cache_status: entry.cfCacheStatus,
      retry_after: entry.retryAfter,
      server: entry.server,
      wait_ms: Math.round(entry.waitMs),
      priority: entry.priority,
      probe: entry.probe,
      region: process.env.VERCEL_REGION ?? null,
      body_excerpt: entry.outcome === "ok" ? null : entry.bodyExcerpt,
    },
    p_keep: keep,
  });
  if (error)
    console.error("Logging a Letterboxd request failed:", error.message);
}
