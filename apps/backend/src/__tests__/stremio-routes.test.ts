/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const SESSION = "stremio-session-key";
const EMAIL = "member@example.com";
const ORIGIN = "http://localhost";

interface Addon {
  transportUrl: string;
  transportName?: string;
  manifest: { id: string; name?: string; catalogs?: { name: string }[] };
  flags?: object;
}

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
    const body = JSON.parse(init?.body as string) as {
      authKey: string;
      addons?: Addon[];
    };
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
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    try {
      return Promise.resolve(respond(input, init));
    } catch (error) {
      return Promise.reject(error as Error);
    }
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
    manifest: (await res.json()) as Addon["manifest"],
    flags: {},
  };
}

/** Links the Stremio account through the code page, as a member would. */
async function seedStremioLink() {
  const stremio = fakeStremio([]);
  stremio.approved = true;
  await postJson(`/${accountId}/stremio/link/AB12`, {});
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
    const start = await postJson(`/${accountId}/stremio/link`, {});
    expect(await start.json()).toEqual({
      code: "AB12",
      link: "https://link.stremio.com/AB12",
    });

    const waiting = await postJson(`/${accountId}/stremio/link/AB12`, {});
    expect(await waiting.json()).toEqual({ stremio: null });
    expect(db.getTable("stremio_connections")).toHaveLength(0);

    stremio.approved = true;
    const linked = await postJson(`/${accountId}/stremio/link/AB12`, {});
    expect(await linked.json()).toEqual({ stremio: { email: EMAIL } });

    const [row] = db.getTable("stremio_connections");
    expect(row.auth_key).not.toContain(SESSION);
    expect(decryptSecret(row.auth_key as string)).toBe(SESSION);

    const config = await getConfig(accountId);
    const body = await config.json();
    expect(body.stremio).toEqual({ email: EMAIL });
    expect(JSON.stringify(body)).not.toContain(SESSION);
  });

  it("is refused through a Legacy alias", async () => {
    fakeStremio([]);
    const res = await postJson(`/${OWNER}/stremio/link`, {});
    expect(res.status).toBe(400);
    const config = await getConfig(OWNER);
    expect((await config.json()).stremio).toBeNull();
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
    expect((await (await getConfig(accountId)).json()).stremio).toBeNull();
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
