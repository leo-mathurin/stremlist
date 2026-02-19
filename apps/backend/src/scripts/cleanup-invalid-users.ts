import type { Database } from "@stremlist/shared";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import path from "path";
import { getImdbWatchlist } from "../services/imdb-scraper";

console.log("Starting cleanup...");

config({
  path: path.join(import.meta.dirname, "..", "..", ".env"),
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables",
  );
}

const supabase = createClient<Database>(supabaseUrl, supabaseServiceRoleKey);
const IMDB_USER_ID_REGEX = /^ur\d{4,}$/;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 12000;
const BATCH_SIZE = 500;

interface Args {
  apply: boolean;
  delayMs: number;
  timeoutMs: number;
  limit: number | null;
}

interface ValidationResult {
  userId: string;
  valid: boolean;
  reason?: "bad_format" | "imdb_not_found" | "network_error";
}

function parseArgs(argv: string[]): Args {
  const getNumberFlag = (name: string, fallback: number): number => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    const value = Number(argv[index + 1]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };

  const limitIndex = argv.indexOf("--limit");
  const rawLimit = limitIndex === -1 ? null : Number(argv[limitIndex + 1]);
  const limit =
    rawLimit !== null && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : null;

  return {
    apply: argv.includes("--apply"),
    delayMs: getNumberFlag("--delay-ms", DEFAULT_DELAY_MS),
    timeoutMs: getNumberFlag("--timeout-ms", DEFAULT_TIMEOUT_MS),
    limit,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllUserIds(limit: number | null): Promise<string[]> {
  let from = 0;
  const step = 1000;
  const ids: string[] = [];

  for (;;) {
    const to = from + step - 1;
    const { data, error } = await supabase
      .from("users")
      .select("imdb_user_id")
      .order("imdb_user_id", { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(`Failed to fetch users: ${error.message}`);
    }
    if (data.length === 0) break;

    ids.push(...data.map((row) => row.imdb_user_id));

    if (limit && ids.length >= limit) {
      return ids.slice(0, limit);
    }

    if (data.length < step) break;
    from += step;
  }

  return ids;
}

async function validateUserId(
  userId: string,
  timeoutMs: number,
): Promise<ValidationResult> {
  if (!IMDB_USER_ID_REGEX.test(userId)) {
    return { userId, valid: false, reason: "bad_format" };
  }

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs),
  );

  try {
    await Promise.race([getImdbWatchlist(userId), timeoutPromise]);
    return { userId, valid: true };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return { userId, valid: false, reason: "network_error" };
    }
    return { userId, valid: false, reason: "imdb_not_found" };
  }
}

async function deleteUsers(userIds: string[]): Promise<void> {
  for (let i = 0; i < userIds.length; i += BATCH_SIZE) {
    const batch = userIds.slice(i, i + BATCH_SIZE);

    // Delete dependent cache rows first to avoid FK issues when constraints
    // are not configured with ON DELETE CASCADE.
    const { error: cacheError } = await supabase
      .from("watchlist_cache")
      .delete()
      .in("imdb_user_id", batch);
    if (cacheError) {
      throw new Error(
        `Failed deleting watchlist_cache batch: ${cacheError.message}`,
      );
    }

    const { error: userError } = await supabase
      .from("users")
      .delete()
      .in("imdb_user_id", batch);
    if (userError) {
      throw new Error(`Failed deleting users batch: ${userError.message}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ids = await fetchAllUserIds(args.limit);

  if (ids.length === 0) {
    console.log("No users found in users table.");
    return;
  }

  console.log(
    `Checking ${ids.length} users (delay=${args.delayMs}ms, timeout=${args.timeoutMs}ms, apply=${args.apply})`,
  );

  const invalidToDelete: string[] = [];
  let validCount = 0;
  let networkErrorCount = 0;

  for (let i = 0; i < ids.length; i += 1) {
    const userId = ids[i];
    const result = await validateUserId(userId, args.timeoutMs);

    if (result.valid) {
      validCount += 1;
    } else if (result.reason === "network_error") {
      networkErrorCount += 1;
      console.log(`[${i + 1}/${ids.length}] SKIP network error: ${userId}`);
    } else {
      invalidToDelete.push(userId);
      console.log(
        `[${i + 1}/${ids.length}] INVALID ${result.reason}: ${userId}`,
      );
    }

    if (i < ids.length - 1 && args.delayMs > 0) {
      await sleep(args.delayMs);
    }
  }

  console.log("");
  console.log(`Valid users: ${validCount}`);
  console.log(`Invalid users: ${invalidToDelete.length}`);
  console.log(`Skipped (network errors): ${networkErrorCount}`);

  if (invalidToDelete.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  if (!args.apply) {
    console.log("");
    console.log("Dry run only. No rows deleted.");
    console.log("Run again with --apply to delete invalid users.");
    return;
  }

  await deleteUsers(invalidToDelete);
  console.log(`Deleted ${invalidToDelete.length} invalid users.`);
}

void main()
  .then(() => {
    console.log("Cleanup completed successfully");
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Cleanup failed: ${message}`);
    throw new Error(`Cleanup failed: ${message}`);
  });
