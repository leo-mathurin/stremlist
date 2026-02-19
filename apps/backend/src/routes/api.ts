import { zValidator } from "@hono/zod-validator";
import { SORT_OPTIONS, IMDB_USER_AGENT } from "@stremlist/shared";
import { Hono } from "hono";
import { z } from "zod";
import { resend } from "../lib/resend";
import { supabase } from "../lib/supabase";
import { getImdbWatchlist } from "../services/imdb-scraper";
import {
  getUser,
  getUserSortOption,
  setUserSortOption,
} from "../services/user";
const userIdParam = z.object({ userId: z.string().regex(/^ur\d{4,}$/) });

const sortOptionValues = SORT_OPTIONS.map((o) => o.value) as [
  string,
  ...string[],
];
const configBody = z.object({ sortOption: z.enum(sortOptionValues) });

const api = new Hono()
  .get("/validate/:userId", zValidator("param", userIdParam), async (c) => {
    const { userId } = c.req.valid("param");

    try {
      const res = await fetch(
        `https://www.imdb.com/user/${userId}/watchlist/`,
        {
          method: "HEAD",
          headers: { "User-Agent": IMDB_USER_AGENT },
          redirect: "follow",
        },
      );
      return c.json({ valid: res.ok });
    } catch {
      return c.json({ valid: false, error: "Could not reach IMDb" }, 502);
    }
  })
  .get("/stats", async (c) => {
    const { count, error } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true })
      .eq("is_active", true);

    if (error) {
      console.error("Failed to fetch user count:", error.message);
      return c.json({ activeUsers: 0 });
    }

    return c.json({ activeUsers: count ?? 0 });
  })
  .get("/:userId/config", zValidator("param", userIdParam), async (c) => {
    const { userId } = c.req.valid("param");
    const user = await getUser(userId);
    if (!user) {
      return c.json({ error: "User not found. Install the addon first." }, 404);
    }
    const sortOption = await getUserSortOption(userId);
    return c.json({ sortOption });
  })
  .post(
    "/:userId/config",
    zValidator("param", userIdParam),
    zValidator("json", configBody),
    async (c) => {
      const { userId } = c.req.valid("param");
      const { sortOption } = c.req.valid("json");

      const user = await getUser(userId);
      if (!user) {
        return c.json(
          { error: "User not found. Install the addon first." },
          404,
        );
      }

      await setUserSortOption(userId, sortOption);

      return c.json({ ok: true });
    },
  )

  .post(
    "/newsletter/subscribe",
    zValidator("json", z.object({ email: z.string().email() })),
    async (c) => {
      const { email } = c.req.valid("json");

      if (!process.env.RESEND_API_KEY || !process.env.RESEND_AUDIENCE_ID) {
        return c.json(
          { success: false, error: "Newsletter service is not configured." },
          500,
        );
      }

      try {
        const contact = await resend.contacts.create({
          email,
          unsubscribed: false,
          audienceId: process.env.RESEND_AUDIENCE_ID,
        });

        return c.json({
          success: true,
          message:
            "Successfully subscribed! You'll be notified about new features and updates.",
          contactId: contact.data?.id,
        });
      } catch (err: unknown) {
        console.error(`Newsletter subscription error for ${email}:`, err);

        const message = err instanceof Error ? err.message : "";
        const statusCode =
          typeof err === "object" && err !== null && "statusCode" in err
            ? err.statusCode
            : null;

        if (
          message.includes("already exists") ||
          message.includes("duplicate")
        ) {
          return c.json({
            success: true,
            message:
              "You're already subscribed! You'll be notified about new features and updates.",
          });
        }

        if (statusCode === 422) {
          return c.json(
            { success: false, error: "Invalid email address format." },
            400,
          );
        }

        if (statusCode === 401) {
          console.error("Resend API authentication failed - check API key");
          return c.json(
            {
              success: false,
              error: "Newsletter service authentication failed.",
            },
            500,
          );
        }

        return c.json(
          {
            success: false,
            error: "Failed to subscribe. Please try again later.",
          },
          500,
        );
      }
    },
  )

  .get("/monitor", async (c) => {
    const authHeader = c.req.header("Authorization");
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const heartbeatUrl = process.env.BETTERSTACK_HEARTBEAT_URL;
    if (!heartbeatUrl) {
      return c.json({ error: "BETTERSTACK_HEARTBEAT_URL is not set" }, 500);
    }

    const testUserId = process.env.MONITOR_IMDB_USER_ID;
    if (!testUserId) {
      return c.json({ error: "MONITOR_IMDB_USER_ID is not set" }, 500);
    }

    try {
      const edges = await getImdbWatchlist(testUserId);

      await fetch(heartbeatUrl);

      return c.json({ ok: true, items: edges.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";

      await fetch(`${heartbeatUrl}/fail`, { method: "POST", body: message });

      console.error("IMDb monitor check failed:", message);
      return c.json({ ok: false, error: message }, 502);
    }
  });

export default api;
export type ApiRoutes = typeof api;
