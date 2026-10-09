export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1";
  };
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
          moved_at: string | null;
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
          moved_at?: string | null;
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
          moved_at?: string | null;
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
        ];
      };
      lists: {
        Row: {
          account_id: string;
          catalog_settings: Json;
          catalog_title: string;
          created_at: string;
          display_mode: string;
          id: string;
          merged_sources: Json;
          position: number;
          provider: string;
          sort_option: string;
          source_label: string | null;
          source_ref: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          catalog_settings?: Json;
          catalog_title: string;
          created_at?: string;
          display_mode?: string;
          id?: string;
          merged_sources?: Json;
          position?: number;
          provider: string;
          sort_option?: string;
          source_label?: string | null;
          source_ref: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          catalog_settings?: Json;
          catalog_title?: string;
          created_at?: string;
          display_mode?: string;
          id?: string;
          merged_sources?: Json;
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
          account_id: string;
          code_verifier: string;
          created_at: string;
          expires_at: string;
          provider: string;
          state: string;
        };
        Insert: {
          account_id: string;
          code_verifier: string;
          created_at?: string;
          expires_at: string;
          provider: string;
          state: string;
        };
        Update: {
          account_id?: string;
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
      source_list_entries: {
        Row: {
          account_id: string;
          detected_at: string | null;
          entry_key: string;
          imdb_id: string | null;
          provider: string;
          removed_at: string | null;
          source_ref: string;
        };
        Insert: {
          account_id: string;
          detected_at?: string | null;
          entry_key: string;
          imdb_id?: string | null;
          provider: string;
          removed_at?: string | null;
          source_ref: string;
        };
        Update: {
          account_id?: string;
          detected_at?: string | null;
          entry_key?: string;
          imdb_id?: string | null;
          provider?: string;
          removed_at?: string | null;
          source_ref?: string;
        };
        Relationships: [
          {
            foreignKeyName: "source_list_entries_account_id_provider_source_ref_fkey";
            columns: ["account_id", "provider", "source_ref"];
            isOneToOne: false;
            referencedRelation: "source_list_syncs";
            referencedColumns: ["account_id", "provider", "source_ref"];
          },
        ];
      };
      source_list_syncs: {
        Row: {
          account_id: string;
          baseline_at: string;
          connection_user: string | null;
          last_complete_sync_at: string;
          provider: string;
          requires_connection: boolean;
          source_ref: string;
        };
        Insert: {
          account_id: string;
          baseline_at: string;
          connection_user?: string | null;
          last_complete_sync_at: string;
          provider: string;
          requires_connection?: boolean;
          source_ref: string;
        };
        Update: {
          account_id?: string;
          baseline_at?: string;
          connection_user?: string | null;
          last_complete_sync_at?: string;
          provider?: string;
          requires_connection?: boolean;
          source_ref?: string;
        };
        Relationships: [
          {
            foreignKeyName: "source_list_syncs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
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
    };
    Views: {
      [_ in never]: never;
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
      finish_list_prewarm: {
        Args: {
          p_account_id: string;
          p_completed_generation: number;
          p_lease_seconds: number;
          p_lease_token: string;
        };
        Returns: number;
      };
      forget_connection_history: {
        Args: {
          p_account_id: string;
          p_provider: string;
        };
        Returns: number;
      };
      generate_account_id: { Args: never; Returns: string };
      list_new_titles: {
        Args: {
          p_account_id: string;
          p_limit: number;
          p_providers: string[];
          p_source_refs: string[];
        };
        Returns: {
          detected_at: string;
          imdb_id: string;
          provider: string;
          source_ref: string;
        }[];
      };
      record_list_refresh: {
        Args: {
          p_failure_reason: string | null;
          p_list_id: string;
          p_provider: string;
          p_source_ref: string;
          p_title_count: number | null;
        };
        Returns: boolean;
      };
      record_source_list_sync: {
        Args: {
          p_account_id: string;
          p_connection_user?: string | null;
          p_entry_keys: string[];
          p_imdb_ids: (string | null)[];
          p_provider: string;
          p_requires_connection?: boolean;
          p_source_ref: string;
          p_synced_at: string;
        };
        Returns: number | null;
      };
      release_connection_refresh: {
        Args: {
          p_account_id: string;
          p_lease_token: string;
          p_provider: string;
        };
        Returns: boolean;
      };
      replace_account_config: {
        Args: {
          p_account_id: string;
          p_action_providers: string[] | null;
          p_actions_enabled: boolean | null;
          p_lists: Json;
          p_new_titles_catalog?: boolean | null;
          p_rpdb_api_key: string | null;
        };
        Returns: { deleted_ids: string[]; lists: Json }[];
      };
      request_list_prewarm: {
        Args: {
          p_account_id: string;
          p_lease_seconds: number;
          p_lease_token: string;
        };
        Returns: number;
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
