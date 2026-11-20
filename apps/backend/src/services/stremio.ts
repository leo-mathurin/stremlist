import { z } from "zod";

const LINK_API = "https://link.stremio.com/api/v2";
const STREMIO_API = "https://api.strem.io/api";
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

const stremioAddonSchema = z
  .object({
    transportUrl: z.string(),
    transportName: z.unknown().optional(),
    manifest: z.object({ id: z.string() }).loose(),
    flags: z.unknown().optional(),
  })
  .loose();
export type StremioAddon = z.infer<typeof stremioAddonSchema>;
const addonCollectionSchema = z.object({ addons: z.array(stremioAddonSchema) });

/** A manifest that Stremlist builds: any object with an ID. */
type BuiltManifest = object & { id: string };

const TIMEOUT_MS = 10_000;

type Fetch = typeof fetch;

async function readJson(response: Response) {
  try {
    const json: unknown = await response.json();
    return json;
  } catch {
    throw new StremioUnavailableError();
  }
}

async function send(fetchImpl: Fetch, input: string, init?: RequestInit) {
  try {
    return await fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new StremioUnavailableError();
  }
}

const apiAnswerSchema = z
  .object({ result: z.unknown().optional(), error: z.unknown().optional() })
  .catch({});

const sessionGoneSchema = z.object({ code: z.literal(SESSION_GONE) });

async function readAnswer(response: Response) {
  return apiAnswerSchema.parse(await readJson(response));
}

function parseResult<T>(result: unknown, schema: z.ZodType<T>) {
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new StremioUnavailableError();
  return parsed.data;
}

async function callStremio(
  method: string,
  body: Record<string, unknown>,
  fetchImpl: Fetch,
) {
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

interface LinkCode {
  code: string;
  link: string;
}

const LINK_CODE = /^[A-Za-z0-9]{1,32}$/;

/** Asks Stremio for a code that the member confirms on stremio.com. */
export async function createLinkCode(fetchImpl: Fetch = fetch) {
  const response = await send(fetchImpl, `${LINK_API}/create?type=Create`);
  const answer = await readAnswer(response);
  const { code, link } = z
    .object({ code: z.unknown().optional(), link: z.unknown().optional() })
    .catch({})
    .parse(answer.result);
  if (!response.ok || typeof code !== "string" || !LINK_CODE.test(code)) {
    throw new StremioUnavailableError();
  }
  if (typeof link !== "string" || !link.startsWith("https://")) {
    throw new StremioUnavailableError();
  }
  return { code, link } satisfies LinkCode;
}

/**
 * The session key once the member confirmed the code, or null while they
 * have not. Stremio gives the same answer for a pending and an expired code,
 * so the caller decides when to stop asking.
 */
export async function readLinkCode(code: string, fetchImpl: Fetch = fetch) {
  const response = await send(
    fetchImpl,
    `${LINK_API}/read?type=Read&code=${encodeURIComponent(code)}`,
  );
  if (!response.ok) throw new StremioUnavailableError();
  const answer = await readAnswer(response);
  const { authKey } = z
    .object({ authKey: z.unknown().optional() })
    .catch({})
    .parse(answer.result);
  return typeof authKey === "string" && authKey ? authKey : null;
}

/** The email of the linked Stremio account, to show which one it is. */
export async function getStremioEmail(
  authKey: string,
  fetchImpl: Fetch = fetch,
) {
  const user = z
    .object({ email: z.unknown().optional() })
    .catch({})
    .parse(await getUser(authKey, fetchImpl));
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
) {
  const user = z
    .object({
      trakt: z.object({ access_token: z.unknown().optional() }).nullish(),
    })
    .catch({})
    .parse(await getUser(authKey, fetchImpl));
  return typeof user.trakt?.access_token === "string";
}

function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

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
      watched: lenient(z.string()),
      lastWatched: lenient(z.string()),
    }),
  ),
});
export type LibraryItem = z.infer<typeof libraryItemSchema>;

async function readStremio(
  method: string,
  body: Record<string, unknown>,
  fetchImpl: Fetch,
) {
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
) {
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
) {
  const meta = await readStremio(
    "datastoreMeta",
    { authKey, collection: "libraryItem" },
    fetchImpl,
  );
  return parseResult(meta, z.array(z.tuple([z.string(), z.number()])));
}

function getUser(authKey: string, fetchImpl: Fetch) {
  return callStremio("getUser", { type: "GetUser", authKey }, fetchImpl);
}

async function isProfilesAdmin(authKey: string, fetchImpl: Fetch) {
  const user = parseResult(
    await getUser(authKey, fetchImpl),
    z.object({
      parent_id: z.string().nullish(),
      features: z.object({ profiles: z.number().nullish() }).nullish(),
    }),
  );
  return !user.parent_id && (user.features?.profiles ?? 0) > 1;
}

async function getCollection(authKey: string, fetchImpl: Fetch) {
  const result = await callStremio(
    "addonCollectionGet",
    { type: "AddonCollectionGet", authKey, update: true },
    fetchImpl,
  );
  return parseResult(result, addonCollectionSchema).addons;
}

async function setCollection(
  authKey: string,
  addons: StremioAddon[],
  fetchImpl: Fetch,
) {
  await callStremio(
    "addonCollectionSet",
    { type: "AddonCollectionSet", authKey, addons },
    fetchImpl,
  );
}

async function getProfileCollections(authKey: string, fetchImpl: Fetch) {
  const result = await callStremio(
    "premiumPrefs/getProfilesAddons",
    { type: "GetProfilesAddons", authKey },
    fetchImpl,
  );
  return parseResult(
    result,
    z.object({ profiles: z.record(z.string(), addonCollectionSchema) }),
  ).profiles;
}

async function setProfileAddon(
  authKey: string,
  profileId: string,
  addon: StremioAddon,
  fetchImpl: Fetch,
) {
  await callStremio(
    "premiumPrefs/setProfileAddons",
    { type: "SetProfileAddons", authKey, profileId, addAddon: addon },
    fetchImpl,
  );
}

function pathSegments(url: string) {
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
export function isThisStremlist(addon: StremioAddon, addonUrl: string) {
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

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type UpdateResult = "updated" | "unchanged" | "missing";

type CollectionUpdate =
  | { kind: "missing" | "unchanged" }
  | { kind: "updated"; index: number; addon: StremioAddon };

const planManifestUpdate: (
  collection: StremioAddon[],
  addonUrl: string,
  manifest: BuiltManifest,
) => CollectionUpdate = (collection, addonUrl, manifest) => {
  const index = collection.findIndex((addon) =>
    isThisStremlist(addon, addonUrl),
  );
  if (index < 0) return { kind: "missing" };
  if (sameJson(collection[index].manifest, manifest)) {
    return { kind: "unchanged" };
  }
  return {
    kind: "updated",
    index,
    addon: { ...collection[index], manifest },
  };
};

async function readIfAvailable<T>(read: Promise<T>) {
  try {
    return await read;
  } catch (error) {
    if (error instanceof StremioUnavailableError) return null;
    throw error;
  }
}

async function updateLinkedCollection(
  authKey: string,
  addonUrl: string,
  manifest: BuiltManifest,
  fetchImpl: Fetch,
) {
  const collection = await getCollection(authKey, fetchImpl);
  const plan = planManifestUpdate(collection, addonUrl, manifest);
  if (plan.kind !== "updated") return plan.kind;
  await setCollection(
    authKey,
    collection.map((addon, index) =>
      index === plan.index ? plan.addon : addon,
    ),
    fetchImpl,
  );
  const written = await readIfAvailable(getCollection(authKey, fetchImpl));
  if (
    written &&
    planManifestUpdate(written, addonUrl, manifest).kind !== "unchanged"
  ) {
    throw new StremioUnavailableError("Stremio did not keep the update.");
  }
  return "updated" satisfies UpdateResult;
}

async function updateSecondaryCollections(
  authKey: string,
  addonUrl: string,
  manifest: BuiltManifest,
  fetchImpl: Fetch,
) {
  if (!(await isProfilesAdmin(authKey, fetchImpl))) {
    return "missing" satisfies UpdateResult;
  }

  const profiles = await getProfileCollections(authKey, fetchImpl);
  const plans = Object.entries(profiles).map(([profileId, { addons }]) => ({
    profileId,
    ...planManifestUpdate(addons, addonUrl, manifest),
  }));
  const changes = plans.filter((plan) => plan.kind === "updated");
  if (changes.length === 0) {
    return plans.some((plan) => plan.kind === "unchanged")
      ? "unchanged"
      : "missing";
  }

  const outcomes = await Promise.allSettled(
    changes.map(({ profileId, addon }) =>
      setProfileAddon(authKey, profileId, addon, fetchImpl),
    ),
  );
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") throw outcome.reason;
  }

  const written = await readIfAvailable(
    getProfileCollections(authKey, fetchImpl),
  );
  if (
    written &&
    changes.some(
      ({ profileId }) =>
        planManifestUpdate(written[profileId]?.addons ?? [], addonUrl, manifest)
          .kind !== "unchanged",
    )
  ) {
    throw new StremioUnavailableError("Stremio did not keep the update.");
  }
  return "updated" satisfies UpdateResult;
}

/**
 * Updates the linked collection while discovering and updating matching
 * Supporter profiles. Each secondary write replaces one addon in place.
 * The account lease covers both paths, including when either path fails.
 */
export const updateInstalledStremlist: (
  authKey: string,
  addonUrl: string,
  manifest: BuiltManifest,
  fetchImpl?: Fetch,
) => Promise<UpdateResult> = async (
  authKey,
  addonUrl,
  manifest,
  fetchImpl = fetch,
) => {
  const [linked, secondary] = await Promise.allSettled([
    updateLinkedCollection(authKey, addonUrl, manifest, fetchImpl),
    updateSecondaryCollections(authKey, addonUrl, manifest, fetchImpl),
  ]);
  if (linked.status === "rejected") throw linked.reason;
  if (secondary.status === "rejected") throw secondary.reason;

  if (linked.value === "updated" || secondary.value === "updated")
    return "updated";
  return linked.value === "unchanged" || secondary.value === "unchanged"
    ? "unchanged"
    : "missing";
};

/**
 * Adds this Stremlist to the linked account after the member removed it and
 * asked to install it again. Never called on its own.
 */
export async function installStremlist(
  authKey: string,
  addonUrl: string,
  built: BuiltManifest,
  fetchImpl: Fetch = fetch,
) {
  const collection = await getCollection(authKey, fetchImpl);
  if (collection.some((addon) => isThisStremlist(addon, addonUrl))) return;
  await setCollection(
    authKey,
    [
      ...collection,
      {
        transportUrl: addonUrl,
        transportName: "http",
        manifest: built,
        flags: {},
      },
    ],
    fetchImpl,
  );
}
