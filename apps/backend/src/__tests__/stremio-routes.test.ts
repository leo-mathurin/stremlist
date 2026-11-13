import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";
import app from "../index.js";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import {
  OWNER,
  getConfig,
  postConfig,
  postJson,
  resetConfigTest,
} from "./helpers/config-api.js";
import {
  LIST_IDS,
  seedAccount,
  seedList,
  useTestEncryptionKey,
} from "./helpers/fixtures.js";
import { db } from "./helpers/mock-supabase.js";
import {
  configBody,
  mustString,
  parseJson,
  readJson,
  stremioManifest,
  unchanged,
} from "./helpers/json.js";

const { backgroundMocks, prewarmMocks, supabaseMocks } = await vi.hoisted(
  () => import("./helpers/config-api-mocks.js"),
);
vi.mock("../lib/background", () => backgroundMocks);
vi.mock("../services/list-prewarm", () => prewarmMocks);
vi.mock("../lib/supabase", () => supabaseMocks);
vi.mock("../services/list-cache", () => import("./helpers/mock-list-cache.js"));
vi.mock("../providers/registry", () => import("./helpers/mock-registry.js"));
vi.mock("../lib/r2", () => import("./helpers/mock-r2.js"));
vi.mock("../lib/resend", () => import("./helpers/mock-resend.js"));

const SESSION = "stremio-session-key";
const EMAIL = "member@example.com";
const ORIGIN = "http://localhost";

interface Addon {
  transportUrl: string;
  transportName?: string;
  manifest: { id: string; name?: string; catalogs?: { name: string }[] };
  flags?: object;
}

const addon = z
  .object({
    transportUrl: z.string(),
    transportName: z.string().optional(),
    manifest: z
      .object({
        id: z.string(),
        name: z.string().optional(),
        catalogs: z
          .array(z.object({ name: z.string() }).passthrough())
          .optional(),
      })
      .passthrough(),
    flags: z.record(z.unknown()).optional(),
  })
  .passthrough() satisfies z.ZodType<Addon>;

/** What the Stremio API receives. */
const apiRequest = z
  .object({
    authKey: z.string(),
    // Kept as sent: Stremlist compares manifests as JSON text.
    addons: z.array(unchanged(addon)).optional(),
  })
  .passthrough();

const cinemeta: Addon = {
  transportUrl: "https://v3-cinemeta.strem.io/manifest.json",
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta" },
  flags: { official: true, protected: true },
};

/**
 * Stremio's code page and API in memory. Every call is recorded by method;
 * `failure` breaks the API.
 */
function fakeStremio(collection: Addon[]) {
  const stremio = {
    collection: structuredClone(collection),
    approved: false,
    failure: null as "down" | "signed-out" | null,
    calls: [] as string[],
    /** Runs before each API answer, to change the world meanwhile. */
    meanwhile: () => {},
    /** While set, the next api.strem.io answer waits for it. */
    hold: null as Promise<void> | null,
    /** How many api.strem.io answers waited. */
    held: 0,
  };
  const respond = (input: string | URL, init?: RequestInit): Response => {
    const url = new URL(String(input));
    const method = url.pathname.split("/").at(-1) ?? "";
    stremio.calls.push(method);
    if (url.host === "link.stremio.com") {
      if (method === "create") {
        return Response.json({
          result: { code: "AB12", link: "https://link.stremio.com/AB12" },
        });
      }
      return Response.json(
        stremio.approved
          ? { result: { authKey: SESSION } }
          : { error: { code: 101, message: "Invalid or expired token" } },
      );
    }
    stremio.meanwhile();
    if (stremio.failure === "down") throw new TypeError("fetch failed");
    const body = parseJson(
      mustString(init?.body, "the Stremio API request body"),
      apiRequest,
    );
    if (stremio.failure === "signed-out" || body.authKey !== SESSION) {
      return Response.json({
        error: { code: 1, message: "Session does not exist" },
      });
    }
    if (method === "getUser")
      return Response.json({ result: { email: EMAIL } });
    if (method === "addonCollectionGet") {
      return Response.json({ result: { addons: stremio.collection } });
    }
    if (method === "addonCollectionSet") {
      stremio.collection = structuredClone(body.addons ?? []);
      return Response.json({ result: { success: true } });
    }
    throw new Error(`Unexpected Stremio call ${method}`);
  };
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    if (stremio.hold && new URL(String(input)).host === "api.strem.io") {
      const hold = stremio.hold;
      stremio.hold = null;
      stremio.held++;
      await hold;
    }
    return respond(input, init);
  });
  return stremio;
}

let accountId = "";

function addonUrl() {
  return `${ORIGIN}/${accountId}/manifest.json`;
}

/** The installed Stremlist, with the manifest that Stremlist serves now. */
async function installed(): Promise<Addon> {
  const res = await app.request(`/${accountId}/manifest.json`);
  return {
    transportUrl: addonUrl(),
    transportName: "http",
    manifest: await readJson(res, unchanged(stremioManifest)),
    flags: {},
  };
}

/** Asks for a code, as the configure page does. */
async function startLink(account = accountId) {
  const res = await postJson(`/${account}/stremio/link`, {});
  return readJson(res, z.object({ link: z.string(), token: z.string() }));
}

function confirmLink(token: string, account = accountId) {
  return postJson(`/${account}/stremio/link/confirm`, { token });
}

/** Links the Stremio account through the code page, as a member would. */
async function seedStremioLink() {
  const stremio = fakeStremio([]);
  const { token } = await startLink();
  stremio.approved = true;
  await confirmLink(token);
  vi.unstubAllGlobals();
}

beforeEach(() => {
  resetConfigTest();
  useTestEncryptionKey();
  accountId = seedAccount().id;
  seedList(accountId, {
    id: LIST_IDS[0],
    source_ref: OWNER,
    catalog_title: "Watchlist",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("linking a Stremio account", () => {
  it("keeps the session key encrypted on the server and shows only the email", async () => {
    const stremio = fakeStremio([]);
    const start = await startLink();
    expect(start.link).toBe("https://link.stremio.com/AB12");

    const waiting = await confirmLink(start.token);
    expect(await waiting.json()).toEqual({ stremio: null });
    expect(db.getTable("stremio_connections")).toHaveLength(0);

    stremio.approved = true;
    const linked = await confirmLink(start.token);
    expect(await linked.json()).toEqual({ stremio: { email: EMAIL } });

    const [row] = db.getTable("stremio_connections");
    expect(row.auth_key).not.toContain(SESSION);
    expect(decryptSecret(mustString(row.auth_key, "auth_key"))).toBe(SESSION);

    const config = await getConfig(accountId);
    const body = await readJson(config, configBody);
    expect(body.stremio).toEqual({ email: EMAIL });
    expect(JSON.stringify(body)).not.toContain(SESSION);
  });

  it("links only the Account that asked for the code", async () => {
    const stremio = fakeStremio([]);
    const { token } = await startLink();
    stremio.approved = true;
    const other = seedAccount().id;
    const res = await confirmLink(token, other);
    expect(res.status).toBe(410);
    expect(db.getTable("stremio_connections")).toHaveLength(0);
    // A token made up from the code alone is refused too.
    const forged = await confirmLink(
      `AB12.${Date.now() + 60_000}.${"A".repeat(43)}`,
    );
    expect(forged.status).toBe(410);
    expect(stremio.calls).toEqual(["create"]);
  });

  it("stops asking about a code after ten minutes", async () => {
    const stremio = fakeStremio([]);
    const { token } = await startLink();
    stremio.approved = true;
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const res = await confirmLink(token);
    vi.restoreAllMocks();
    expect(res.status).toBe(410);
    expect(db.getTable("stremio_connections")).toHaveLength(0);
  });

  it("is refused through a Legacy alias", async () => {
    fakeStremio([]);
    const res = await postJson(`/${OWNER}/stremio/link`, {});
    expect(res.status).toBe(400);
    const config = await getConfig(OWNER);
    expect((await readJson(config, configBody)).stremio).toBeNull();
  });

  it("replaces the previous link", async () => {
    await seedStremioLink();
    await seedStremioLink();
    expect(db.getTable("stremio_connections")).toHaveLength(1);
  });
});

describe("updating the installed Stremlist", () => {
  beforeEach(seedStremioLink);

  function update() {
    return postJson(`/${accountId}/stremio/update`, {});
  }

  it("writes the manifest of the last save and keeps the other addons", async () => {
    const before = await installed();
    const stremio = fakeStremio([cinemeta, before]);
    await postConfig(accountId, {
      lists: [
        {
          id: LIST_IDS[0],
          sourceRef: OWNER,
          catalogTitle: "Renamed",
          sortOption: "added_at-asc",
        },
      ],
    });

    const res = await update();
    expect(await res.json()).toEqual({ result: "updated" });
    const after = await installed();
    expect(after.manifest).not.toEqual(before.manifest);
    expect(stremio.collection).toEqual([cinemeta, after]);
    expect(stremio.calls).not.toContain("logout");
  });

  it("writes nothing when Stremio already has it", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    expect(await (await update()).json()).toEqual({ result: "unchanged" });
    expect(stremio.calls).not.toContain("addonCollectionSet");
  });

  it("reports a removed Stremlist, and adds it back only on request", async () => {
    const stremio = fakeStremio([cinemeta]);
    expect(await (await update()).json()).toEqual({ result: "missing" });
    expect(stremio.collection).toEqual([cinemeta]);

    const res = await postJson(`/${accountId}/stremio/install`, {});
    expect(await res.json()).toEqual({ result: "updated" });
    expect(stremio.collection).toEqual([cinemeta, await installed()]);
  });

  it("runs one update at a time, so the last save reaches Stremio", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    let release = () => {};
    stremio.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rename = (catalogTitle: string) =>
      postConfig(accountId, {
        lists: [
          {
            id: LIST_IDS[0],
            sourceRef: OWNER,
            catalogTitle,
            sortOption: "added_at-asc",
          },
        ],
      });

    await rename("First");
    const first = update();
    await vi.waitFor(() => {
      expect(stremio.held).toBe(1);
    });
    // The second update starts while the first waits for Stremio. Without
    // one update at a time, it would write first, and the first would
    // undo it.
    await rename("Second");
    const second = update();
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();

    const results = await Promise.all(
      (await Promise.all([first, second])).map((res) => res.json()),
    );
    expect(results).toEqual([{ result: "updated" }, { result: "updated" }]);
    expect(stremio.collection).toEqual([cinemeta, await installed()]);
    expect(JSON.stringify(stremio.collection[1].manifest.catalogs)).toContain(
      "Second",
    );
  });

  it("builds the manifest from the settings saved while it waited", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    let release = () => {};
    stremio.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = update();
    await vi.waitFor(() => {
      expect(stremio.held).toBe(1);
    });
    // This request waits for the first update.
    const second = update();
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const row of db.getTable("accounts")) {
      if (row.id === accountId) row.new_titles_catalog = true;
    }
    release();

    await Promise.all([first, second]);
    expect(stremio.collection).toEqual([cinemeta, await installed()]);
    expect(JSON.stringify(stremio.collection[1].manifest.catalogs)).toContain(
      "New titles",
    );
  });

  it("disconnecting waits for a running update", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    let release = () => {};
    stremio.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = update();
    await vi.waitFor(() => {
      expect(stremio.held).toBe(1);
    });
    const disconnect = app.request(`/${accountId}/stremio`, {
      method: "DELETE",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The update still holds the link: a new link cannot start meanwhile.
    expect(db.getTable("stremio_connections")).toHaveLength(1);
    release();

    expect((await disconnect).status).toBe(200);
    expect((await running).status).toBe(200);
    expect(db.getTable("stremio_connections")).toHaveLength(0);
  });

  it("disconnects even when an update holds the lease too long", async () => {
    fakeStremio([cinemeta]);
    for (const row of db.getTable("stremio_connections")) {
      row.update_locked_until = "2100-01-01T00:00:00.000Z";
    }
    // Each read of the clock moves it 10 s on: the 25 s wait is over soon.
    const start = Date.now();
    let calls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => start + calls++ * 10_000);
    const res = await app.request(`/${accountId}/stremio`, {
      method: "DELETE",
    });
    vi.restoreAllMocks();
    expect(res.status).toBe(200);
    expect(db.getTable("stremio_connections")).toHaveLength(0);
  });

  it("keeps the link when Stremio does not answer", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    stremio.failure = "down";
    const res = await update();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ reason: "unavailable" });
    expect(db.getTable("stremio_connections")).toHaveLength(1);
  });

  it("forgets a signed-out session", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    stremio.failure = "signed-out";
    const res = await update();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ reason: "signed-out" });
    expect(db.getTable("stremio_connections")).toHaveLength(0);
    expect(
      (await readJson(await getConfig(accountId), configBody)).stremio,
    ).toBeNull();
  });

  it("keeps a link made while the refused key was in use", async () => {
    const stremio = fakeStremio([cinemeta, await installed()]);
    stremio.failure = "signed-out";
    stremio.meanwhile = () => {
      // The member links Stremio again in another tab.
      db.getTable("stremio_connections")[0].auth_key = encryptSecret("new");
    };
    await update();
    expect(db.getTable("stremio_connections")).toHaveLength(1);
  });

  it("disconnecting forgets the key without a Stremio logout", async () => {
    const stremio = fakeStremio([cinemeta]);
    const res = await app.request(`/${accountId}/stremio`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    expect(db.getTable("stremio_connections")).toHaveLength(0);
    expect(stremio.calls).toEqual([]);

    const again = await update();
    expect(await again.json()).toEqual({ reason: "signed-out" });
  });
});
