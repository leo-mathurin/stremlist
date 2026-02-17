import { execFileSync } from "node:child_process";
import { DEFAULT_SORT_OPTION, SORT_OPTIONS } from "@stremlist/shared";
import { supabase } from "../lib/supabase.js";

const VALID_SORT_OPTIONS = new Set<string>(SORT_OPTIONS.map((option) => option.value));
const IMDB_USER_ID_REGEX = /^ur\d{4,}$/;
const BATCH_SIZE = 500;

type RedisMode = "cli" | "docker";

interface RedisConfig {
  mode: RedisMode;
  cliPath: string;
  redisUrl: string | null;
  redisDb: string;
  dockerContainer: string;
}

function getRedisConfig(): RedisConfig {
  const mode = (process.env.OLD_REDIS_MODE ?? "docker").toLowerCase() as RedisMode;
  return {
    mode: mode === "cli" ? "cli" : "docker",
    cliPath: process.env.REDIS_CLI_PATH ?? "redis-cli",
    redisUrl: process.env.OLD_REDIS_URL ?? null,
    redisDb: process.env.OLD_REDIS_DB ?? "0",
    dockerContainer: process.env.OLD_REDIS_CONTAINER ?? "stremlist-redis",
  };
}

function runRedisCommand(config: RedisConfig, args: string[]): string {
  const baseArgs = config.redisUrl
    ? ["-u", config.redisUrl]
    : ["-n", config.redisDb];

  if (config.mode === "cli") {
    return execFileSync(config.cliPath, [...baseArgs, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  return execFileSync(
    "docker",
    ["exec", config.dockerContainer, config.cliPath, ...baseArgs, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function parseLines(output: string): string[] {
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function sanitizeUserId(userId: string): string | null {
  if (!IMDB_USER_ID_REGEX.test(userId)) return null;
  return userId;
}

function sanitizeSortOption(rawSortOption: string | null): string {
  if (!rawSortOption) return DEFAULT_SORT_OPTION;
  if (VALID_SORT_OPTIONS.has(rawSortOption)) return rawSortOption;
  return DEFAULT_SORT_OPTION;
}

function getUserIdsFromKeys(keys: string[], prefix: string): string[] {
  return keys
    .map((key) => key.slice(prefix.length))
    .map(sanitizeUserId)
    .filter((userId): userId is string => Boolean(userId));
}

async function migrateUsersAndSortOptions(): Promise<void> {
  const config = getRedisConfig();
  const sourceLabel =
    config.mode === "docker"
      ? `docker container "${config.dockerContainer}"`
      : `${config.cliPath}${config.redisUrl ? ` (${config.redisUrl})` : ""}`;

  console.log(`Reading users from Redis via ${sourceLabel}...`);

  const activeUsers = parseLines(runRedisCommand(config, ["SMEMBERS", "active_users"]))
    .map(sanitizeUserId)
    .filter((userId): userId is string => Boolean(userId));

  const watchlistKeys = parseLines(
    runRedisCommand(config, ["--scan", "--pattern", "watchlist_*"]),
  );
  const configKeys = parseLines(
    runRedisCommand(config, ["--scan", "--pattern", "user_config_*"]),
  );
  const activityUsers = parseLines(runRedisCommand(config, ["HKEYS", "user_activity"]))
    .map(sanitizeUserId)
    .filter((userId): userId is string => Boolean(userId));

  const watchlistUsers = getUserIdsFromKeys(watchlistKeys, "watchlist_");
  const configUsers = getUserIdsFromKeys(configKeys, "user_config_");

  const allUsers = new Set<string>([
    ...activeUsers,
    ...watchlistUsers,
    ...configUsers,
    ...activityUsers,
  ]);

  if (allUsers.size === 0) {
    console.log("No users found in Redis. Nothing to migrate.");
    return;
  }

  console.log(
    [
      `Found ${allUsers.size} unique users`,
      `(active: ${activeUsers.length},`,
      `watchlist keys: ${watchlistUsers.length},`,
      `config keys: ${configUsers.length},`,
      `activity: ${activityUsers.length})`,
    ].join(" "),
  );

  const rows = [...allUsers].map((userId) => {
    let sortOption: string | null = null;
    try {
      sortOption = runRedisCommand(config, ["HGET", `user_config_${userId}`, "sortOption"]) || null;
    } catch {
      sortOption = null;
    }

    return {
      imdb_user_id: userId,
      is_active: true,
      last_activity_at: new Date().toISOString(),
      sort_option: sanitizeSortOption(sortOption),
    };
  });

  let migrated = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from("users")
      .upsert(batch, { onConflict: "imdb_user_id" });

    if (error) {
      throw new Error(`Supabase upsert failed for batch ${i / BATCH_SIZE + 1}: ${error.message}`);
    }

    migrated += batch.length;
    console.log(`Upserted ${migrated}/${rows.length} users...`);
  }

  const withCustomSort = rows.filter(
    (row) => row.sort_option && row.sort_option !== DEFAULT_SORT_OPTION,
  ).length;

  console.log("Migration complete.");
  console.log(`Total users migrated: ${rows.length}`);
  console.log(`Users with non-default sortOption: ${withCustomSort}`);
}

void migrateUsersAndSortOptions()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Migration failed: ${message}`);
    process.exit(1);
  });
