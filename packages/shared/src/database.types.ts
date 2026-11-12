export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      accounts: {
        Row: {
          action_providers: string[];
          actions_enabled: boolean;
          created_at: string;
          id: string;
          is_active: boolean;
          last_cache_served_at: string | null;
          last_fetched_at: string;
          legacy_imdb_user_id: string | null;
          new_titles_catalog: boolean;
          prewarm_lease_token: string | null;
          prewarm_locked_until: string;
          prewarm_request_generation: number;
          rpdb_api_key: string | null;
        };
        Insert: {
          action_providers?: string[];
          actions_enabled?: boolean;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_cache_served_at?: string | null;
          last_fetched_at?: string;
          legacy_imdb_user_id?: string | null;
          new_titles_catalog?: boolean;
          prewarm_lease_token?: string | null;
          prewarm_locked_until?: string;
          prewarm_request_generation?: number;
          rpdb_api_key?: string | null;
        };
        Update: {
          action_providers?: string[];
          actions_enabled?: boolean;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          last_cache_served_at?: string | null;
          last_fetched_at?: string;
          legacy_imdb_user_id?: string | null;
          new_titles_catalog?: boolean;
          prewarm_lease_token?: string | null;
          prewarm_locked_until?: string;
          prewarm_request_generation?: number;
          rpdb_api_key?: string | null;
        };
        Relationships: [];
      };
      connections: {
        Row: {
          access_token: string;
          account_id: string;
          authorization_version: string;
          created_at: string;
          expires_at: string | null;
          needs_renewal_since: string | null;
          provider: string;
          provider_username: string | null;
          redirect_uri: string;
          refresh_lease_token: string | null;
          refresh_locked_until: string;
          refresh_token: string | null;
          scope: string | null;
          updated_at: string;
        };
        Insert: {
          access_token: string;
          account_id: string;
          authorization_version?: string;
          created_at?: string;
          expires_at?: string | null;
          needs_renewal_since?: string | null;
          provider: string;
          provider_username?: string | null;
          redirect_uri: string;
          refresh_lease_token?: string | null;
          refresh_locked_until?: string;
          refresh_token?: string | null;
          scope?: string | null;
          updated_at?: string;
        };
        Update: {
          access_token?: string;
          account_id?: string;
          authorization_version?: string;
          created_at?: string;
          expires_at?: string | null;
          needs_renewal_since?: string | null;
          provider?: string;
          provider_username?: string | null;
          redirect_uri?: string;
          refresh_lease_token?: string | null;
          refresh_locked_until?: string;
          refresh_token?: string | null;
          scope?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "connections_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      letterboxd_gate: {
        Row: {
          floor_slowdowns: number;
          floor_slowdowns_since: string | null;
          halt_reason: string | null;
          halted_at: string | null;
          id: string;
          next_probe_at: string | null;
          paused_until: string;
          probe_until: string | null;
          rate: number;
          rate_changed_at: string;
          refilled_at: string;
          slow_alerted: boolean;
          slow_since: string | null;
          tokens: number;
          window_failures: number;
          window_requests: number;
          window_started_at: string;
          letterboxd_gate_store: undefined | null;
        };
        Insert: {
          floor_slowdowns?: number;
          floor_slowdowns_since?: string | null;
          halt_reason?: string | null;
          halted_at?: string | null;
          id: string;
          next_probe_at?: string | null;
          paused_until?: string;
          probe_until?: string | null;
          rate: number;
          rate_changed_at: string;
          refilled_at: string;
          slow_alerted?: boolean;
          slow_since?: string | null;
          tokens: number;
          window_failures?: number;
          window_requests?: number;
          window_started_at: string;
        };
        Update: {
          floor_slowdowns?: number;
          floor_slowdowns_since?: string | null;
          halt_reason?: string | null;
          halted_at?: string | null;
          id?: string;
          next_probe_at?: string | null;
          paused_until?: string;
          probe_until?: string | null;
          rate?: number;
          rate_changed_at?: string;
          refilled_at?: string;
          slow_alerted?: boolean;
          slow_since?: string | null;
          tokens?: number;
          window_failures?: number;
          window_requests?: number;
          window_started_at?: string;
        };
        Relationships: [];
      };
      letterboxd_request_minutes: {
        Row: {
          duration_buckets: number[];
          duration_ms_max: number;
          duration_ms_total: number;
          minute: string;
          outcome: string;
          rate_max: number | null;
          rate_min: number | null;
          requests: number;
          wait_ms_total: number;
        };
        Insert: {
          duration_buckets: number[];
          duration_ms_max: number;
          duration_ms_total: number;
          minute: string;
          outcome: string;
          rate_max?: number | null;
          rate_min?: number | null;
          requests: number;
          wait_ms_total: number;
        };
        Update: {
          duration_buckets?: number[];
          duration_ms_max?: number;
          duration_ms_total?: number;
          minute?: string;
          outcome?: string;
          rate_max?: number | null;
          rate_min?: number | null;
          requests?: number;
          wait_ms_total?: number;
        };
        Relationships: [];
      };
      letterboxd_requests: {
        Row: {
          at: string;
          body_excerpt: string | null;
          bytes: number | null;
          cf_cache_status: string | null;
          cf_mitigated: string | null;
          cf_ray: string | null;
          duration_ms: number;
          error: string | null;
          id: number;
          outcome: string;
          page_kind: string;
          priority: string;
          probe: boolean;
          rate: number | null;
          region: string | null;
          retry_after: string | null;
          server: string | null;
          status: number | null;
          url: string;
          wait_ms: number;
        };
        Insert: {
          at?: string;
          body_excerpt?: string | null;
          bytes?: number | null;
          cf_cache_status?: string | null;
          cf_mitigated?: string | null;
          cf_ray?: string | null;
          duration_ms: number;
          error?: string | null;
          id?: never;
          outcome: string;
          page_kind: string;
          priority: string;
          probe: boolean;
          rate?: number | null;
          region?: string | null;
          retry_after?: string | null;
          server?: string | null;
          status?: number | null;
          url: string;
          wait_ms: number;
        };
        Update: {
          at?: string;
          body_excerpt?: string | null;
          bytes?: number | null;
          cf_cache_status?: string | null;
          cf_mitigated?: string | null;
          cf_ray?: string | null;
          duration_ms?: number;
          error?: string | null;
          id?: never;
          outcome?: string;
          page_kind?: string;
          priority?: string;
          probe?: boolean;
          rate?: number | null;
          region?: string | null;
          retry_after?: string | null;
          server?: string | null;
          status?: number | null;
          url?: string;
          wait_ms?: number;
        };
        Relationships: [];
      };
      letterboxd_waiters: {
        Row: {
          due_at: string;
          expires_at: string;
          gate: string;
          id: string;
          lane: number;
          seq: number;
          waiting: boolean;
        };
        Insert: {
          due_at: string;
          expires_at: string;
          gate: string;
          id?: string;
          lane: number;
          seq?: never;
          waiting: boolean;
        };
        Update: {
          due_at?: string;
          expires_at?: string;
          gate?: string;
          id?: string;
          lane?: number;
          seq?: never;
          waiting?: boolean;
        };
        Relationships: [];
      };
      list_read_queue: {
        Row: {
          list_id: string;
          provider: string;
          ready_at: string;
          source_ref: string;
          updated_at: string;
        };
        Insert: {
          list_id: string;
          provider: string;
          ready_at: string;
          source_ref: string;
          updated_at?: string;
        };
        Update: {
          list_id?: string;
          provider?: string;
          ready_at?: string;
          source_ref?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "list_read_queue_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "lists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "list_read_queue_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "user_watchlists";
            referencedColumns: ["id"];
          },
        ];
      };
      list_sync_status: {
        Row: {
          failing_since: string | null;
          failure_reason: string | null;
          last_attempt_at: string;
          last_success_at: string | null;
          list_id: string;
          provider: string;
          source_ref: string;
          title_count: number | null;
        };
        Insert: {
          failing_since?: string | null;
          failure_reason?: string | null;
          last_attempt_at: string;
          last_success_at?: string | null;
          list_id: string;
          provider: string;
          source_ref: string;
          title_count?: number | null;
        };
        Update: {
          failing_since?: string | null;
          failure_reason?: string | null;
          last_attempt_at?: string;
          last_success_at?: string | null;
          list_id?: string;
          provider?: string;
          source_ref?: string;
          title_count?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "list_sync_status_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "lists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "list_sync_status_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "user_watchlists";
            referencedColumns: ["id"];
          },
        ];
      };
      lists: {
        Row: {
          account_id: string;
          catalog_settings: NonNullable<Json>;
          catalog_title: string;
          created_at: string;
          display_mode: string;
          id: string;
          merged_sources: NonNullable<Json>;
          position: number;
          provider: string;
          sort_option: string;
          source_label: string | null;
          source_ref: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          catalog_settings?: NonNullable<Json>;
          catalog_title: string;
          created_at?: string;
          display_mode?: string;
          id?: string;
          merged_sources?: NonNullable<Json>;
          position?: number;
          provider: string;
          sort_option?: string;
          source_label?: string | null;
          source_ref: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          catalog_settings?: NonNullable<Json>;
          catalog_title?: string;
          created_at?: string;
          display_mode?: string;
          id?: string;
          merged_sources?: NonNullable<Json>;
          position?: number;
          provider?: string;
          sort_option?: string;
          source_label?: string | null;
          source_ref?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lists_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      oauth_states: {
        Row: {
          account_id: string | null;
          browser_key_hash: string;
          code_verifier: string;
          created_at: string;
          expires_at: string;
          provider: string;
          state: string;
        };
        Insert: {
          account_id?: string | null;
          browser_key_hash: string;
          code_verifier: string;
          created_at?: string;
          expires_at: string;
          provider: string;
          state: string;
        };
        Update: {
          account_id?: string | null;
          browser_key_hash?: string;
          code_verifier?: string;
          created_at?: string;
          expires_at?: string;
          provider?: string;
          state?: string;
        };
        Relationships: [
          {
            foreignKeyName: "oauth_states_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      stremio_connections: {
        Row: {
          account_id: string;
          auth_key: string;
          created_at: string;
          email: string | null;
          update_lease_token: string | null;
          update_locked_until: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          auth_key: string;
          created_at?: string;
          email?: string | null;
          update_lease_token?: string | null;
          update_locked_until?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          auth_key?: string;
          created_at?: string;
          email?: string | null;
          update_lease_token?: string | null;
          update_locked_until?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stremio_connections_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      title_id_map: {
        Row: {
          external_id: string;
          imdb_id: string | null;
          namespace: string;
          resolved_at: string;
          retry_after: string | null;
          strategy: string | null;
        };
        Insert: {
          external_id: string;
          imdb_id?: string | null;
          namespace: string;
          resolved_at?: string;
          retry_after?: string | null;
          strategy?: string | null;
        };
        Update: {
          external_id?: string;
          imdb_id?: string | null;
          namespace?: string;
          resolved_at?: string;
          retry_after?: string | null;
          strategy?: string | null;
        };
        Relationships: [];
      };
      watch_destinations: {
        Row: {
          account_id: string;
          enabled_at: string;
          last_error: string | null;
          last_error_at: string | null;
          last_success_at: string | null;
          last_title: Json | null;
          provider: string;
        };
        Insert: {
          account_id: string;
          enabled_at?: string;
          last_error?: string | null;
          last_error_at?: string | null;
          last_success_at?: string | null;
          last_title?: Json | null;
          provider: string;
        };
        Update: {
          account_id?: string;
          enabled_at?: string;
          last_error?: string | null;
          last_error_at?: string | null;
          last_success_at?: string | null;
          last_title?: Json | null;
          provider?: string;
        };
        Relationships: [
          {
            foreignKeyName: "watch_destinations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "watch_tracking";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "watch_destinations_account_id_provider_fkey";
            columns: ["account_id", "provider"];
            isOneToOne: true;
            referencedRelation: "connections";
            referencedColumns: ["account_id", "provider"];
          },
        ];
      };
      watch_reads: {
        Row: {
          account_id: string;
          cycle_started_at: string;
          due_at: string;
          expected_end_at: string | null;
          expected_flip_at: string | null;
          failures: number;
          generation: number;
          item_id: string;
          item_type: string;
          last_moved_at: string | null;
          last_time_watched: number | null;
          lease_token: string | null;
          locked_until: string;
          phase: string;
          reads: number;
          start_state: NonNullable<Json>;
          video_id: string;
        };
        Insert: {
          account_id: string;
          cycle_started_at: string;
          due_at: string;
          expected_end_at?: string | null;
          expected_flip_at?: string | null;
          failures?: number;
          generation?: number;
          item_id: string;
          item_type: string;
          last_moved_at?: string | null;
          last_time_watched?: number | null;
          lease_token?: string | null;
          locked_until?: string;
          phase: string;
          reads?: number;
          start_state?: NonNullable<Json>;
          video_id: string;
        };
        Update: {
          account_id?: string;
          cycle_started_at?: string;
          due_at?: string;
          expected_end_at?: string | null;
          expected_flip_at?: string | null;
          failures?: number;
          generation?: number;
          item_id?: string;
          item_type?: string;
          last_moved_at?: string | null;
          last_time_watched?: number | null;
          lease_token?: string | null;
          locked_until?: string;
          phase?: string;
          reads?: number;
          start_state?: NonNullable<Json>;
          video_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "watch_reads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "watch_tracking";
            referencedColumns: ["account_id"];
          },
        ];
      };
      watch_simkl_gate: {
        Row: {
          id: string;
          next_slot_at: string;
          slow_until: string;
        };
        Insert: {
          id: string;
          next_slot_at?: string;
          slow_until?: string;
        };
        Update: {
          id?: string;
          next_slot_at?: string;
          slow_until?: string;
        };
        Relationships: [];
      };
      watch_sweep_cursor: {
        Row: {
          id: string;
          last_slot_at: string;
        };
        Insert: {
          id: string;
          last_slot_at: string;
        };
        Update: {
          id?: string;
          last_slot_at?: string;
        };
        Relationships: [];
      };
      watch_tracking: {
        Row: {
          account_id: string;
          baseline_at: string | null;
          created_at: string;
          stremio_trakt: boolean;
          sweep_slot: number;
        };
        Insert: {
          account_id: string;
          baseline_at?: string | null;
          created_at?: string;
          stremio_trakt?: boolean;
          sweep_slot: number;
        };
        Update: {
          account_id?: string;
          baseline_at?: string | null;
          created_at?: string;
          stremio_trakt?: boolean;
          sweep_slot?: number;
        };
        Relationships: [
          {
            foreignKeyName: "watch_tracking_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      watch_writes: {
        Row: {
          account_id: string;
          attempts: number;
          detected_at: string;
          due_at: string;
          episode: number;
          first_failed_at: string | null;
          id: number;
          imdb_id: string;
          item_type: string;
          last_error: string | null;
          lease_token: string | null;
          locked_until: string;
          provider: string;
          season: number;
          uncertain: boolean;
          watched_at: string;
        };
        Insert: {
          account_id: string;
          attempts?: number;
          detected_at?: string;
          due_at?: string;
          episode?: number;
          first_failed_at?: string | null;
          id?: never;
          imdb_id: string;
          item_type: string;
          last_error?: string | null;
          lease_token?: string | null;
          locked_until?: string;
          provider: string;
          season?: number;
          uncertain?: boolean;
          watched_at: string;
        };
        Update: {
          account_id?: string;
          attempts?: number;
          detected_at?: string;
          due_at?: string;
          episode?: number;
          first_failed_at?: string | null;
          id?: never;
          imdb_id?: string;
          item_type?: string;
          last_error?: string | null;
          lease_token?: string | null;
          locked_until?: string;
          provider?: string;
          season?: number;
          uncertain?: boolean;
          watched_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "watch_writes_account_id_provider_fkey";
            columns: ["account_id", "provider"];
            isOneToOne: false;
            referencedRelation: "watch_destinations";
            referencedColumns: ["account_id", "provider"];
          },
        ];
      };
    };
    Views: {
      letterboxd_recent_failures: {
        Row: {
          at: string | null;
          body_excerpt: string | null;
          cf_cache_status: string | null;
          cf_mitigated: string | null;
          cf_ray: string | null;
          duration_ms: number | null;
          error: string | null;
          outcome: string | null;
          page_kind: string | null;
          priority: string | null;
          probe: boolean | null;
          rate: number | null;
          region: string | null;
          retry_after: string | null;
          status: number | null;
          url: string | null;
          wait_ms: number | null;
        };
        Relationships: [];
      };
      letterboxd_request_rates: {
        Row: {
          avg_duration_ms: number | null;
          avg_wait_ms: number | null;
          blocked: number | null;
          failed: number | null;
          failure_share: number | null;
          failures: number | null;
          max_duration_ms: number | null;
          minute: string | null;
          p50_duration_ms_under: number | null;
          p95_duration_ms_under: number | null;
          rate_limited: number | null;
          rate_max: number | null;
          rate_min: number | null;
          requests: number | null;
        };
        Relationships: [];
      };
      user_watchlists: {
        Row: {
          catalog_settings: Json | null;
          catalog_title: string | null;
          created_at: string | null;
          display_mode: string | null;
          id: string | null;
          imdb_user_id: string | null;
          owner_user_id: string | null;
          position: number | null;
          sort_option: string | null;
          updated_at: string | null;
        };
        Insert: {
          catalog_settings?: Json | null;
          catalog_title?: string | null;
          created_at?: string | null;
          display_mode?: string | null;
          id?: string | null;
          imdb_user_id?: string | null;
          owner_user_id?: string | null;
          position?: number | null;
          sort_option?: string | null;
          updated_at?: string | null;
        };
        Relationships: [];
      };
      users: {
        Row: {
          created_at: string | null;
          imdb_user_id: string | null;
          is_active: boolean | null;
          last_cache_served_at: string | null;
          last_fetched_at: string | null;
          prewarm_lease_token: string | null;
          prewarm_locked_until: string | null;
          prewarm_request_generation: number | null;
          rpdb_api_key: string | null;
        };
        Insert: {
          created_at?: string | null;
          imdb_user_id?: string | null;
          is_active?: boolean | null;
          last_cache_served_at?: string | null;
          last_fetched_at?: string | null;
          prewarm_lease_token?: string | null;
          prewarm_locked_until?: string | null;
          prewarm_request_generation?: number | null;
          rpdb_api_key?: string | null;
        };
        Update: {
          created_at?: string | null;
          imdb_user_id?: string | null;
          is_active?: boolean | null;
          last_cache_served_at?: string | null;
          last_fetched_at?: string | null;
          prewarm_lease_token?: string | null;
          prewarm_locked_until?: string | null;
          prewarm_request_generation?: number | null;
          rpdb_api_key?: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      claim_connection_refresh: {
        Args: {
          p_account_id: string;
          p_lease_seconds: number;
          p_lease_token: string;
          p_provider: string;
        };
        Returns: boolean;
      };
      claim_stremio_update: {
        Args: {
          p_account_id: string;
          p_lease_seconds: number;
          p_lease_token: string;
        };
        Returns: string;
      };
      claim_sweep_slots: {
        Args: { p_now: string };
        Returns: {
          slot: number;
          slot_at: string;
        }[];
      };
      claim_watch_reads: {
        Args: {
          p_lease_seconds: number;
          p_lease_token: string;
          p_limit: number;
        };
        Returns: {
          account_id: string;
          auth_key: string;
          baseline_at: string;
          cycle_started_at: string;
          destinations: string[];
          due_at: string;
          expected_end_at: string;
          expected_flip_at: string;
          failures: number;
          generation: number;
          item_id: string;
          item_type: string;
          last_moved_at: string;
          last_time_watched: number;
          phase: string;
          reads: number;
          start_state: Json;
          stremio_trakt: boolean;
          video_id: string;
        }[];
      };
      claim_watch_writes: {
        Args: {
          p_exclude: boolean;
          p_lease_seconds: number;
          p_lease_token: string;
          p_limit: number;
          p_provider: string;
        };
        Returns: {
          account_id: string;
          attempts: number;
          detected_at: string;
          due_at: string;
          episode: number;
          first_failed_at: string | null;
          id: number;
          imdb_id: string;
          item_type: string;
          last_error: string | null;
          lease_token: string | null;
          locked_until: string;
          provider: string;
          season: number;
          uncertain: boolean;
          watched_at: string;
        }[];
        SetofOptions: {
          from: "*";
          to: "watch_writes";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      create_account_with_config: {
        Args: {
          p_lists: Json;
          p_new_titles_catalog?: boolean;
          p_rpdb_api_key: string;
        };
        Returns: {
          account_id: string;
          lists: Json;
        }[];
      };
      delete_connection: {
        Args: {
          p_account_id: string;
          p_list_ids: string[];
          p_provider: string;
          p_source_refs: string[];
        };
        Returns: undefined;
      };
      finish_list_prewarm: {
        Args: {
          p_account_id: string;
          p_completed_generation: number;
          p_lease_seconds: number;
          p_lease_token: string;
        };
        Returns: number;
      };
      finish_watch_reads: {
        Args: { p_lease_token: string; p_rows: Json };
        Returns: number;
      };
      finish_watch_writes: {
        Args: { p_lease_token: string; p_rows: Json };
        Returns: undefined;
      };
      finish_watchlist_prewarm: {
        Args: {
          p_completed_generation: number;
          p_lease_seconds: number;
          p_lease_token: string;
          p_owner_user_id: string;
        };
        Returns: number;
      };
      generate_account_id: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      letterboxd_gate_lock: {
        Args: { p_gate: string; p_target: number };
        Returns: {
          floor_slowdowns: number;
          floor_slowdowns_since: string | null;
          halt_reason: string | null;
          halted_at: string | null;
          id: string;
          next_probe_at: string | null;
          paused_until: string;
          probe_until: string | null;
          rate: number;
          rate_changed_at: string;
          refilled_at: string;
          slow_alerted: boolean;
          slow_since: string | null;
          tokens: number;
          window_failures: number;
          window_requests: number;
          window_started_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "letterboxd_gate";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      letterboxd_gate_settle: {
        Args: {
          g: Database["public"]["Tables"]["letterboxd_gate"]["Row"];
          p_target: number;
          t: string;
        };
        Returns: {
          floor_slowdowns: number;
          floor_slowdowns_since: string | null;
          halt_reason: string | null;
          halted_at: string | null;
          id: string;
          next_probe_at: string | null;
          paused_until: string;
          probe_until: string | null;
          rate: number;
          rate_changed_at: string;
          refilled_at: string;
          slow_alerted: boolean;
          slow_since: string | null;
          tokens: number;
          window_failures: number;
          window_requests: number;
          window_started_at: string;
        };
        SetofOptions: {
          from: "*";
          to: "letterboxd_gate";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      letterboxd_gate_status: {
        Args: { p_gate?: string; p_target: number };
        Returns: Json;
      };
      letterboxd_gate_store: {
        Args: { g: Database["public"]["Tables"]["letterboxd_gate"]["Row"] };
        Returns: undefined;
      };
      letterboxd_record: {
        Args: { p_keep: boolean; p_request: Json };
        Returns: undefined;
      };
      letterboxd_report: {
        Args: {
          p_gate?: string;
          p_outcome: string;
          p_probe: boolean;
          p_retry_after_ms: number;
          p_target: number;
        };
        Returns: Json;
      };
      letterboxd_take_turn: {
        Args: {
          p_gate?: string;
          p_priority: string;
          p_target: number;
          p_ticket?: string;
        };
        Returns: Json;
      };
      queue_watch_writes: { Args: { p_rows: Json }; Returns: number };
      record_list_refresh: {
        Args: {
          p_failure_reason: string;
          p_list_id: string;
          p_provider: string;
          p_source_ref: string;
          p_title_count: number;
        };
        Returns: boolean;
      };
      release_connection_refresh: {
        Args: {
          p_account_id: string;
          p_lease_token: string;
          p_provider: string;
        };
        Returns: boolean;
      };
      release_stremio_update: {
        Args: { p_account_id: string; p_lease_token: string };
        Returns: boolean;
      };
      release_watch_writes: {
        Args: { p_ids: number[]; p_lease_token: string };
        Returns: undefined;
      };
      replace_account_config: {
        Args: {
          p_account_id: string;
          p_action_providers: string[];
          p_actions_enabled: boolean;
          p_lists: Json;
          p_new_titles_catalog?: boolean;
          p_rpdb_api_key: string;
        };
        Returns: {
          lists: Json;
          previous_lists: Json;
        }[];
      };
      replace_user_config: {
        Args: {
          p_owner_user_id: string;
          p_rpdb_api_key: string;
          p_watchlists: Json;
        };
        Returns: {
          deleted_ids: string[];
          watchlists: Json;
        }[];
      };
      request_list_prewarm: {
        Args: {
          p_account_id: string;
          p_lease_seconds: number;
          p_lease_token: string;
        };
        Returns: number;
      };
      request_watchlist_prewarm: {
        Args: {
          p_lease_seconds: number;
          p_lease_token: string;
          p_owner_user_id: string;
        };
        Returns: number;
      };
      return_simkl_slots: {
        Args: { p_rate: number; p_slow_seconds: number; p_unused: number };
        Returns: undefined;
      };
      save_connection: {
        Args: {
          p_access_token: string;
          p_account_id: string;
          p_expires_at: string;
          p_provider: string;
          p_provider_username: string;
          p_redirect_uri: string;
          p_refresh_token: string;
          p_scope: string;
        };
        Returns: undefined;
      };
      take_simkl_slots: {
        Args: { p_rate: number; p_want: number; p_window_seconds: number };
        Returns: {
          first_slot_at: string;
          granted: number;
          rate: number;
        }[];
      };
      watch_context: {
        Args: { p_account_id: string };
        Returns: {
          auth_key: string;
          baseline_at: string;
        }[];
      };
      watch_destination_list: {
        Args: { p_account_id: string };
        Returns: string[];
      };
      watch_read_soon: {
        Args: { p_account_id: string; p_item_id: string };
        Returns: boolean;
      };
      watch_restart: {
        Args: {
          p_account_id: string;
          p_due_at: string;
          p_expected_end_at?: string;
          p_expected_flip_at?: string;
          p_item_id: string;
          p_item_type: string;
          p_last_time_watched?: number;
          p_phase: string;
          p_start_state: Json;
          p_video_id: string;
        };
        Returns: undefined;
      };
      watch_simkl_backlog: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      watch_sweep_accounts: {
        Args: { p_slots: number[] };
        Returns: {
          account_id: string;
          auth_key: string;
          baseline_at: string;
          destinations: string[];
          stremio_trakt: boolean;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
