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
  /**
   * The excerpt being read in the background: a refusal is reported to the
   * gate at once, even when its body is slow to arrive.
   */
  pendingExcerpt?: Promise<void>;
}

const EXCERPT_BYTES = 2048;
/** How long the log waits for a background excerpt. */
const EXCERPT_WAIT_MS = 3000;
const REDACTED = "[redacted]";
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

/**
 * Start reading the first 2 KB of a body we do not otherwise use, then drop
 * the rest. The read goes on in the background; the log waits for it.
 */
export function noteExcerpt(
  details: LetterboxdRequestDetails,
  response: Response,
) {
  details.pendingExcerpt = readExcerpt(details, response);
}

async function readExcerpt(
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
      // Kept as it arrives: a body that stalls still shows its first bytes.
      details.bodyExcerpt = excerpt(Buffer.concat(chunks).toString("utf8"));
    }
  } catch {
    /* The excerpt is best effort. */
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function excerpt(text: string): string {
  return Buffer.from(text, "utf8")
    .subarray(0, EXCERPT_BYTES)
    .toString("utf8")
    .replace(/�+$/, "");
}

/** How the gate saw the request. */
export interface LetterboxdRequestOutcome {
  outcome: "ok" | "rate_limited" | "blocked" | "failed";
  durationMs: number;
  waitMs: number;
  priority: ReadPriority;
  probe: boolean;
}

/**
 * The secrets in a Letterboxd URL: a Share link token, or a boxd.it code
 * (a short link to a Share link carries its token). Stored references keep
 * them encrypted, so the log must not keep them in plaintext.
 */
function secretsOf(url: string): string[] {
  const share = /\/share\/([^/?#]+)/.exec(url)?.[1];
  const short = /^https:\/\/boxd\.it\/([^/?#]+)/.exec(url)?.[1];
  return [share, short].filter((value): value is string => Boolean(value));
}

function redact(text: string | null, secrets: string[]): string | null {
  if (text === null) return null;
  return secrets.reduce(
    (result, secret) => result.split(secret).join(REDACTED),
    text,
  );
}

/** Log one request. Best effort: a failed write never affects a read. */
export async function recordLetterboxdRequest(
  details: LetterboxdRequestDetails,
  outcome: LetterboxdRequestOutcome,
) {
  if (details.pendingExcerpt)
    await Promise.race([
      details.pendingExcerpt,
      new Promise<void>((resolve) => setTimeout(resolve, EXCERPT_WAIT_MS)),
    ]);
  const entry = { ...details, ...outcome };
  const secrets = secretsOf(entry.url);
  const keep = entry.outcome !== "ok" || Math.random() < SUCCESS_SAMPLE;
  const { error } = await supabase.rpc("letterboxd_record", {
    p_request: {
      outcome: entry.outcome,
      page_kind: entry.kind,
      url: redact(entry.url, secrets),
      status: entry.status,
      duration_ms: Math.round(entry.durationMs),
      bytes: entry.bytes,
      error: redact(entry.error, secrets),
      cf_ray: entry.cfRay,
      cf_mitigated: entry.cfMitigated,
      cf_cache_status: entry.cfCacheStatus,
      retry_after: entry.retryAfter,
      server: entry.server,
      wait_ms: Math.round(entry.waitMs),
      priority: entry.priority,
      probe: entry.probe,
      region: process.env.VERCEL_REGION ?? null,
      body_excerpt:
        entry.outcome === "ok" ? null : redact(entry.bodyExcerpt, secrets),
    },
    p_keep: keep,
  });
  if (error)
    console.error("Logging a Letterboxd request failed:", error.message);
}
