import type { MergeDeep } from "type-fest";
import type { StremioMeta } from "./stremio.types";
import type { Database as PostgresSchema } from "./database.types";

export type { Json } from "./database.types";

export type Database = MergeDeep<
  PostgresSchema,
  {
    public: {
      Tables: {
        watchlist_cache_items: {
          Row: {
            data: StremioMeta;
          };
          Insert: {
            data: StremioMeta;
          };
          Update: {
            data?: StremioMeta;
          };
        };
      };
    };
  }
>;

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];
