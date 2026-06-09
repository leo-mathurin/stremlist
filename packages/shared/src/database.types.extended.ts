import type { MergeDeep } from "type-fest";
import type { StremioMeta, WatchlistData } from "./stremio.types";
import type { Database as PostgresSchema } from "./database.types";

export type { Json } from "./database.types";

export type Database = MergeDeep<
  PostgresSchema,
  {
    public: {
      Tables: {
        watchlist_cache: {
          Row: {
            cached_data: WatchlistData;
          };
          Insert: {
            cached_data: WatchlistData;
          };
          Update: {
            cached_data?: WatchlistData;
          };
        };
        // Normalised per-item cache. Not yet in the generated database.types.ts
        // (the migration is applied by the deploy pipeline, not via a local
        // gen:types run), so the full table is declared here. After the
        // migration ships, generate:types will add the table and the
        // `data: StremioMeta` override below keeps applying.
        watchlist_cache_items: {
          Row: {
            watchlist_id: string;
            item_id: string;
            type: string;
            position: number;
            data: StremioMeta;
            cached_at: string;
          };
          Insert: {
            watchlist_id: string;
            item_id: string;
            type: string;
            position: number;
            data: StremioMeta;
            cached_at?: string;
          };
          Update: {
            watchlist_id?: string;
            item_id?: string;
            type?: string;
            position?: number;
            data?: StremioMeta;
            cached_at?: string;
          };
          Relationships: [
            {
              foreignKeyName: "watchlist_cache_items_watchlist_id_fkey";
              columns: ["watchlist_id"];
              isOneToOne: false;
              referencedRelation: "user_watchlists";
              referencedColumns: ["id"];
            },
          ];
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
