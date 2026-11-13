import { z } from "zod";

/**
 * Stremio's code page and API, as Stremlist uses them to update the
 * installed Stremlist of a linked Stremio account (ADR 0002).
 *
 * The member links their account with Stremio's own code page (the one
 * Stremio uses for TVs). The code hands over the stremio.com session that
 * confirmed it, so the key ends when the member signs out of stremio.com.
 * Writes replace the manifest of the one matching entry and keep every other
 * addon and the order.
 */

const LINK_API = "https://link.stremio.com/api/v2";
const STREMIO_API = "https://api.strem.io/api";
/** Stremio's answer for a session that was signed out or does not exist. */
const SESSION_GONE = 1;

/** Stremio no longer accepts the session: the member must link again. */
export class StremioSessionError extends Error {
  constructor() {
    super("Stremio signed Stremlist out.");
    this.name = "StremioSessionError";
  }
}

/** Stremio or the network did not answer as expected. Retrying may work. */
export class StremioUnavailableError extends Error {
  constructor(message = "Stremio did not answer.") {
    super(message);
    this.name = "StremioUnavailableError";
  }
}

/** A manifest as Stremio keeps it in the collection. */
interface CollectionManifest {
  id: string;
  [key: string]: unknown;
}

// The collection is written back whole: every field of every addon stays.
const stremioAddonSchema = z
  .object({
    transportUrl: z.string(),
    // Not read, only written back: any value Stremio sends stays as it is.
    transportName: z.unknown(),
    manifest: z.object({ id: z.string() }).passthrough(),
    flags: z.unknown(),
  })
  .passthrough();
export type StremioAddon = z.infer<typeof stremioAddonSchema>;

/** A manifest that Stremlist builds: any object with an ID. */
type BuiltManifest = object & { id: string };

/** How long one Stremio call may take before it counts as an outage. */
const TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new StremioUnavailableError();
  }
}

async function send(
  fetchImpl: Fetch,
  input: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StremioUnavailableError();
  }
}

// Fields of an answer that is not an object read as missing.
const apiAnswerSchema = z
  .object({ result: z.unknown(), error: z.unknown() })
  .catch({});

const sessionGoneSchema = z.object({ code: z.literal(SESSION_GONE) });

async function readAnswer(response: Response) {
  return apiAnswerSchema.parse(await readJson(response));
}

/** A `result` of the shape that `schema` expects, else Stremio is down. */
function parseResult<T>(
  result: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new StremioUnavailableError();
  return parsed.data;
}

async function callStremio(
  method: string,
  body: Record<string, unknown>,
  fetchImpl: Fetch,
): Promise<unknown> {
  const response = await send(fetchImpl, `${STREMIO_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const answer = await readAnswer(response);
  if (sessionGoneSchema.safeParse(answer.error).success) {
    throw new StremioSessionError();
  }
  if (!response.ok || answer.error || answer.result === undefined) {
    throw new StremioUnavailableError();
  }
  return answer.result;
}

export interface LinkCode {
  code: string;
  /** The Stremio page where the member confirms the code. */
  link: string;
}

/** The codes that Stremlist's link token can carry (`stremio-link.ts`). */
const LINK_CODE = /^[A-Za-z0-9]{1,32}$/;

/** Asks Stremio for a code that the member confirms on stremio.com. */
export async function createLinkCode(
  fetchImpl: Fetch = fetch,
): Promise<LinkCode> {
  const response = await send(fetchImpl, `${LINK_API}/create?type=Create`);
  const answer = await readAnswer(response);
  const { code, link } = z
    .object({ code: z.unknown(), link: z.unknown() })
    .catch({})
    .parse(answer.result);
  // A code in another format could never be confirmed: report it now.
  if (!response.ok || typeof code !== "string" || !LINK_CODE.test(code)) {
    throw new StremioUnavailableError();
  }
  if (typeof link !== "string" || !link.startsWith("https://")) {
    throw new StremioUnavailableError();
  }
  return { code, link };
}

/**
 * The session key once the member confirmed the code, or null while they
 * have not. Stremio gives the same answer for a pending and an expired code,
 * so the caller decides when to stop asking.
 */
export async function readLinkCode(
  code: string,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  const response = await send(
    fetchImpl,
    `${LINK_API}/read?type=Read&code=${encodeURIComponent(code)}`,
  );
  // A pending code is an answer with an error, not an HTTP error.
  if (!response.ok) throw new StremioUnavailableError();
  const answer = await readAnswer(response);
  const { authKey } = z
    .object({ authKey: z.unknown() })
    .catch({})
    .parse(answer.result);
  return typeof authKey === "string" && authKey ? authKey : null;
}

/** The email of the linked Stremio account, to show which one it is. */
export async function getStremioEmail(
  authKey: string,
  fetchImpl: Fetch = fetch,
): Promise<string | null> {
  const user = z
    .object({ email: z.unknown() })
    .catch({})
    .parse(
      await callStremio("getUser", { type: "GetUser", authKey }, fetchImpl),
    );
  return typeof user.email === "string" ? user.email : null;
}

/**
 * Whether Stremio's own Trakt integration is connected on this account: its
 * user record then holds a Trakt token. Watch tracking writes nothing to
 * Trakt meanwhile, so a play is never written twice (ADR 0003).
 */
export async function hasStremioTrakt(
  authKey: string,
  fetchImpl: Fetch = fetch,
): Promise<boolean> {
  const user = z
    .object({ trakt: z.object({ access_token: z.unknown() }).nullish() })
    .catch({})
    .parse(
      await callStremio("getUser", { type: "GetUser", authKey }, fetchImpl),
    );
  return typeof user.trakt?.access_token === "string";
}

/**
 * A field that Stremio may leave out, send as null, or send with another
 * type: each reads as absent, so one odd item never fails the whole read.
 */
function lenient<T extends z.ZodTypeAny>(schema: T) {
  return schema.optional().catch(undefined);
}

/** A library item, with the fields that Watch tracking reads. */
const libraryItemSchema = z.object({
  _id: z.string(),
  type: z.string(),
  _mtime: lenient(z.union([z.string(), z.number()])),
  state: lenient(
    z.object({
      timeWatched: lenient(z.number()),
      duration: lenient(z.number()),
      timesWatched: lenient(z.number()),
      video_id: lenient(z.string()),
      /** `{anchor video}:{anchor length}:{base64 zlib bits}` (series). */
      watched: lenient(z.string()),
      lastWatched: lenient(z.string()),
    }),
  ),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

/** A read: tried once more when the first try gets no answer. */
async function readStremio(
  method: string,
  body: Record<string, unknown>,
  fetchImpl: Fetch,
): Promise<unknown> {
  try {
    return await callStremio(method, body, fetchImpl);
  } catch (error) {
    if (!(error instanceof StremioUnavailableError)) throw error;
    return callStremio(method, body, fetchImpl);
  }
}

/** These items of the library (at most 100 IDs a call). */
export async function getLibraryItems(
  authKey: string,
  ids: string[],
  fetchImpl: Fetch = fetch,
): Promise<LibraryItem[]> {
  const items = await readStremio(
    "datastoreGet",
    { authKey, collection: "libraryItem", ids, all: false },
    fetchImpl,
  );
  return parseResult(items, z.array(libraryItemSchema));
}

/** Every item of the library as [ID, last change in ms]. */
export async function getLibraryMeta(
  authKey: string,
  fetchImpl: Fetch = fetch,
): Promise<[string, number][]> {
  const meta = await readStremio(
    "datastoreMeta",
    { authKey, collection: "libraryItem" },
    fetchImpl,
  );
  return parseResult(meta, z.array(z.tuple([z.string(), z.number()])));
}

async function getCollection(
  authKey: string,
  fetchImpl: Fetch,
): Promise<StremioAddon[]> {
  const result = await callStremio(
    "addonCollectionGet",
    { type: "AddonCollectionGet", authKey, update: true },
    fetchImpl,
  );
  return parseResult(result, z.object({ addons: z.array(stremioAddonSchema) }))
    .addons;
}

async function setCollection(
  authKey: string,
  addons: StremioAddon[],
  fetchImpl: Fetch,
): Promise<void> {
  await callStremio(
    "addonCollectionSet",
    { type: "AddonCollectionSet", authKey, addons },
    fetchImpl,
  );
}

function pathSegments(url: string): string[] | null {
  try {
    return new URL(url.replace(/^stremio:\/\//, "https://")).pathname
      .split("/")
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Whether a collection entry is this Account's Stremlist install. The entry
 * keeps the address it was installed from, which can be an older Stremlist
 * domain, so the path and the manifest decide, not the host.
 */
export function isThisStremlist(
  addon: StremioAddon,
  addonUrl: string,
): boolean {
  const installed = pathSegments(addon.transportUrl);
  const ours = pathSegments(addonUrl);
  if (!installed || !ours || ours.length < 2) return false;
  const [key, file] = ours.slice(-2);
  const [installedKey, installedFile] = installed.slice(-2);
  const samePath = installedKey === key && installedFile === file;
  const sameHost =
    new URL(addon.transportUrl.replace(/^stremio:\/\//, "https://")).host ===
    new URL(addonUrl).host;
  return (
    samePath && (sameHost || addon.manifest.id.startsWith("com.stremlist"))
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type UpdateResult =
  /** Stremio now reads the saved catalogs. */
  | "updated"
  /** Stremio already read them: nothing was written. */
  | "unchanged"
  /** This Stremlist is not installed in the linked Stremio account. */
  | "missing";

/**
 * Gives the installed Stremlist `manifest`, built from the last save. Reads
 * the collection just before the write and checks it after. The caller runs
 * one update at a time per Account (`stremio-link.ts`). Another Stremio app
 * that writes the collection between the read and the write can still lose
 * its change: Stremio has no conditional write (ADR 0002).
 */
export async function updateInstalledStremlist(
  authKey: string,
  addonUrl: string,
  built: BuiltManifest,
  fetchImpl: Fetch = fetch,
): Promise<UpdateResult> {
  // Stremio keeps the manifest as the JSON object it was given.
  const manifest = built as CollectionManifest;
  const collection = await getCollection(authKey, fetchImpl);
  const index = collection.findIndex((addon) =>
    isThisStremlist(addon, addonUrl),
  );
  if (index < 0) return "missing";
  if (sameJson(collection[index].manifest, manifest)) return "unchanged";

  const next = collection.map((addon, position) =>
    position === index ? { ...addon, manifest } : addon,
  );
  await setCollection(authKey, next, fetchImpl);

  // Stremio accepted the write. A check that gets no answer does not undo it.
  const written = await getCollection(authKey, fetchImpl).catch(
    (error: unknown) => {
      if (error instanceof StremioUnavailableError) return null;
      throw error;
    },
  );
  if (!written) return "updated";
  const entry = written.find((addon) => isThisStremlist(addon, addonUrl));
  if (!entry || !sameJson(entry.manifest, manifest)) {
    throw new StremioUnavailableError("Stremio did not keep the update.");
  }
  return "updated";
}

/**
 * Adds this Stremlist to the linked account after the member removed it and
 * asked to install it again. Never called on its own.
 */
export async function installStremlist(
  authKey: string,
  addonUrl: string,
  built: BuiltManifest,
  fetchImpl: Fetch = fetch,
): Promise<void> {
  // Stremio keeps the manifest as the JSON object it was given.
  const manifest = built as CollectionManifest;
  const collection = await getCollection(authKey, fetchImpl);
  if (collection.some((addon) => isThisStremlist(addon, addonUrl))) return;
  await setCollection(
    authKey,
    [
      ...collection,
      { transportUrl: addonUrl, transportName: "http", manifest, flags: {} },
    ],
    fetchImpl,
  );
}
