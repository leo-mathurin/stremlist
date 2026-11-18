import { http, HttpResponse } from "msw";
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
} from "./helpers/account.fixture.js";
import { useBackgroundTasks } from "./helpers/background.test-utils.js";
import { cinemetaWithoutTitles, FakeImdb } from "./helpers/imdb.test-utils.js";
import { db } from "./helpers/mock-supabase.js";
import { useMswServer } from "./helpers/msw.test-utils.js";
import {
  configBody,
  mustString,
  readJson,
  stremioManifest,
  unchanged,
} from "./helpers/json.js";

const server = useMswServer();
const background = useBackgroundTasks();
const imdb = new FakeImdb();

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
        catalogs: z.array(z.object({ name: z.string() }).loose()).optional(),
      })
      .loose(),
    flags: z.record(z.string(), z.unknown()).optional(),
  })
  .loose() satisfies z.ZodType<Addon>;

const apiRequest = z
  .object({
    authKey: z.string(),
    addons: z.array(unchanged(addon)).optional(),
  })
  .loose();

const cinemeta: Addon = {
  transportUrl: "https://v3-cinemeta.strem.io/manifest.json",
  manifest: { id: "com.linvo.cinemeta", name: "Cinemeta" },
  flags: { official: true, protected: true },
};

function fakeStremio(collection: Addon[]) {
  const stremio = {
    collection: structuredClone(collection),
    approved: false,
    failure: null as "down" | "signed-out" | null,
    calls: [] as string[],
    meanwhile: () => {},
    hold: null as Promise<void> | null,
    held: Promise.withResolvers<void>(),
  };
  server.use(
    http.get("https://link.stremio.com/api/v2/:method", ({ params }) => {
      const method = String(params.method);
      stremio.calls.push(method);
      if (method === "create") {
        return HttpResponse.json({
          result: { code: "AB12", link: "https://link.stremio.com/AB12" },
        });
      }
      return HttpResponse.json(
        stremio.approved
          ? { result: { authKey: SESSION } }
          : { error: { code: 101, message: "Invalid or expired token" } },
      );
    }),
    http.post(
      "https://api.strem.io/api/:method",
      async ({ request, params }) => {
        if (stremio.hold) {
          const hold = stremio.hold;
          stremio.hold = null;
          stremio.held.resolve();
          await hold;
        }
        const method = String(params.method);
        stremio.calls.push(method);
        stremio.meanwhile();
        if (stremio.failure === "down") return HttpResponse.error();
        const body = apiRequest.parse(await request.json());
        if (stremio.failure === "signed-out" || body.authKey !== SESSION) {
          return HttpResponse.json({
            error: { code: 1, message: "Session does not exist" },
          });
        }
        if (method === "getUser")
          return HttpResponse.json({ result: { email: EMAIL } });
        if (method === "addonCollectionGet") {
          return HttpResponse.json({ result: { addons: stremio.collection } });
        }
        if (method === "addonCollectionSet") {
          stremio.collection = structuredClone(body.addons ?? []);
          return HttpResponse.json({ result: { success: true } });
        }
        throw new Error(`Unexpected Stremio call ${method}`);
      },
    ),
  );
  return stremio;
}

let accountId = "";

function refusedUpdateClaim() {
  const refused = Promise.withResolvers<unknown>();
  const claim = new URL(
    "/rest/v1/rpc/claim_stremio_update",
    process.env.SUPABASE_URL,
  ).href;
  const answered = ({
    request,
    response,
  }: {
    request: Request;
    response: Response;
  }) => {
    if (request.url !== claim) return;
    server.events.removeListener("response:mocked", answered);
    response.clone().json().then(refused.resolve, refused.reject);
  };
  server.events.on("response:mocked", answered);
  return refused.promise;
}

function addonUrl() {
  return `${ORIGIN}/${accountId}/manifest.json`;
}

async function installed() {
  const res = await app.request(`/${accountId}/manifest.json`);
  return {
    transportUrl: addonUrl(),
    transportName: "http",
    manifest: await readJson(res, unchanged(stremioManifest)),
    flags: {},
  };
}

async function startLink(account = accountId) {
  const res = await postJson(`/${account}/stremio/link`, {});
  return readJson(res, z.object({ link: z.string(), token: z.string() }));
}

function confirmLink(token: string, account = accountId) {
  return postJson(`/${account}/stremio/link/confirm`, { token });
}

async function seedStremioLink() {
  const stremio = fakeStremio([]);
  const { token } = await startLink();
  stremio.approved = true;
  await confirmLink(token);
  server.resetHandlers();
  server.use(imdb.handler, cinemetaWithoutTitles);
}

beforeEach(() => {
  resetConfigTest();
  imdb.reset();
  server.events.removeAllListeners();
  server.use(imdb.handler, cinemetaWithoutTitles);
  useTestEncryptionKey();
  accountId = seedAccount().id;
  seedList(accountId, {
    id: LIST_IDS[0],
    source_ref: OWNER,
    catalog_title: "Watchlist",
  });
});

afterEach(async () => {
  await background.settle();
  vi.useRealTimers();
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const res = await confirmLink(token);
    vi.useRealTimers();
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
    await stremio.held.promise;
    await rename("Second");
    const refused = refusedUpdateClaim();
    const second = update();
    expect(await refused).toBe("busy");
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
    await stremio.held.promise;
    const refused = refusedUpdateClaim();
    const second = update();
    expect(await refused).toBe("busy");
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
    await stremio.held.promise;
    const refused = refusedUpdateClaim();
    const disconnect = app.request(`/${accountId}/stremio`, {
      method: "DELETE",
    });
    expect(await refused).toBe("busy");
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
    vi.useFakeTimers();
    const disconnect = app.request(`/${accountId}/stremio`, {
      method: "DELETE",
    });
    await vi.advanceTimersByTimeAsync(26_000);
    const res = await disconnect;
    vi.useRealTimers();
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
