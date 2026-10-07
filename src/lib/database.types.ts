/**
 * TypeScript types for the `public` schema.
 *
 * WHY THIS FILE EXISTS
 *
 * Every Supabase client in this application was previously constructed without a
 * `Database` type parameter. That makes supabase-js resolve the client to
 * `SupabaseClient<any, "public", any>`, so **every** `.select()` result is
 * `any` — and a `.select()` naming a column that does not exist type-checks
 * perfectly.
 *
 * That is not hypothetical. This is the exact mechanism behind the single worst
 * bug in the project's history:
 *
 *   follows and log_likes were keyed (follower_id, following_id) with no `id`
 *   column, while the application addressed them by `id`.
 *     .from('follows').select('id')      -> PGRST204, column not found
 *
 * The code destructured only `{ data }` and discarded the error, so the result
 * was `null`, the toggle always took the INSERT branch, and **unfollow and
 * un-like were impossible**. Every follower count on every profile rendered as
 * 0. It passed `tsc`, `eslint`, `next build` and every route check.
 *
 * It was then reintroduced by a later "fix", because the same untyped read was
 * still there. It took two audit passes to catch.
 *
 * With these types wired in, that class of bug is a compile error.
 *
 * HOW TO REGENERATE
 *
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 *
 * The types below are derived from `001_init.sql`, `002_fixes_and_features.sql`
 * and `003_verify_and_harden.sql`, i.e. the post-migration target schema. They
 * intentionally describe the schema the application EXPECTS rather than one
 * particular deployment, so regenerating against a database that has not yet
 * run 002/003 should produce the same file.
 */

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
      profiles: {
        Row: {
          avatar_url: string | null;
          bio: string | null;
          created_at: string;
          display_name: string | null;
          id: string;
          updated_at: string;
          username: string;
        };
        Insert: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string;
          display_name?: string | null;
          id: string;
          updated_at?: string;
          username: string;
        };
        Update: {
          avatar_url?: string | null;
          bio?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          updated_at?: string;
          username?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['id'];
            isOneToOne: true;
            referencedRelation: 'users';
            referencedColumns: ['id'];
          },
        ];
      };
      games: {
        Row: {
          cover_url: string | null;
          created_at: string;
          id: number;
          name: string;
          release_date: string | null;
          slug: string | null;
          summary: string | null;
        };
        Insert: {
          cover_url?: string | null;
          created_at?: string;
          id: number;
          name: string;
          release_date?: string | null;
          slug?: string | null;
          summary?: string | null;
        };
        Update: {
          cover_url?: string | null;
          created_at?: string;
          id?: number;
          name?: string;
          release_date?: string | null;
          slug?: string | null;
          summary?: string | null;
        };
        Relationships: [];
      };
      game_logs: {
        Row: {
          backlog_position: number | null;
          created_at: string;
          diary_date: string | null;
          game_id: number;
          has_spoilers: boolean;
          id: string;
          is_favorite: boolean;
          playtime_hours: number | null;
          rating: number;
          review: string | null;
          /** Generated column. Insert is not permitted. */
          review_tsv: unknown;
          status: Database['public']['Enums']['log_status'];
          tags: string[] | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          diary_date?: string | null;
          game_id: number;
          has_spoilers?: boolean;
          id?: string;
          is_favorite?: boolean;
          playtime_hours?: number | null;
          /** 0 means "logged but unrated". NOT NULL, default 0. */
          rating?: number;
          review?: string | null;
          /**
           * Explicit queue order within the backlog. Added by 004. Nullable so
           * an unranked item is distinguishable from one ranked first; the
           * index orders `nulls last`.
           */
          backlog_position?: number | null;
          status?: Database['public']['Enums']['log_status'];
          tags?: string[] | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          backlog_position?: number | null;
          created_at?: string;
          diary_date?: string | null;
          game_id?: number;
          has_spoilers?: boolean;
          id?: string;
          is_favorite?: boolean;
          playtime_hours?: number | null;
          rating?: number;
          review?: string | null;
          status?: Database['public']['Enums']['log_status'];
          tags?: string[] | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'game_logs_game_id_fkey';
            columns: ['game_id'];
            isOneToOne: false;
            referencedRelation: 'games';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      follows: {
        Row: {
          created_at: string;
          follower_id: string;
          /**
           * Added by 002. Before it existed this table was keyed
           * (follower_id, following_id) with no surrogate — the root cause of
           * the unfollow bug described at the top of this file.
           */
          id: string;
          following_id: string;
        };
        Insert: {
          created_at?: string;
          follower_id: string;
          id?: string;
          following_id: string;
        };
        Update: {
          created_at?: string;
          follower_id?: string;
          id?: string;
          following_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'follows_follower_id_fkey';
            columns: ['follower_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'follows_following_id_fkey';
            columns: ['following_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      log_likes: {
        Row: {
          created_at: string;
          id: string;
          log_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          log_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          log_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'game_logs_id_fkey';
            columns: ['log_id'];
            isOneToOne: false;
            referencedRelation: 'game_logs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      lists: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          /** 'custom' | 'watchlist'. Added by 002. */
          kind: string;
          is_public: boolean;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          kind?: string;
          is_public?: boolean;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          kind?: string;
          is_public?: boolean;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'lists_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      list_games: {
        Row: {
          added_at: string;
          game_id: number;
          list_id: string;
        };
        Insert: {
          added_at?: string;
          game_id: number;
          list_id: string;
        };
        Update: {
          added_at?: string;
          game_id?: number;
          list_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'list_games_game_id_fkey';
            columns: ['game_id'];
            isOneToOne: false;
            referencedRelation: 'games';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'list_games_list_id_fkey';
            columns: ['list_id'];
            isOneToOne: false;
            referencedRelation: 'lists';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          actor_id: string;
          /** Added by 002 so a comment notification can link somewhere real. */
          comment_id: string | null;
          created_at: string;
          /** Added by 002 so a like notification can link to the game. */
          game_id: number | null;
          id: string;
          log_id: string | null;
          read: boolean;
          type: Database['public']['Enums']['notification_type'];
          user_id: string;
        };
        Insert: {
          actor_id: string;
          comment_id?: string | null;
          created_at?: string;
          game_id?: number | null;
          id?: string;
          log_id?: string | null;
          read?: boolean;
          type: Database['public']['Enums']['notification_type'];
          user_id: string;
        };
        Update: {
          actor_id?: string;
          comment_id?: string | null;
          created_at?: string;
          game_id?: number | null;
          id?: string;
          log_id?: string | null;
          read?: boolean;
          type?: Database['public']['Enums']['notification_type'];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'game_logs_id_fkey';
            columns: ['log_id'];
            isOneToOne: false;
            referencedRelation: 'game_logs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['actor_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      comments: {
        Row: {
          body: string;
          created_at: string;
          id: string;
          /** Added by 002. */
          log_id: string;
          parent_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          id?: string;
          log_id: string;
          parent_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          id?: string;
          log_id?: string;
          parent_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'comments_log_id_fkey';
            columns: ['log_id'];
            isOneToOne: false;
            referencedRelation: 'game_logs';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      /** Added by 004. */
      reports: {
        Row: {
          content_id: string;
          content_type: string;
          created_at: string;
          id: string;
          notes: string | null;
          reason: string;
          reporter_id: string;
          resolved_at: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          content_id: string;
          content_type: string;
          created_at?: string;
          id?: string;
          notes?: string | null;
          reason: string;
          reporter_id: string;
          resolved_at?: string | null;
          status?: string;
          updated_at?: string;
        };
        // No Update entry on purpose: there is no update policy, so a client
        // update would fail with 42501 rather than silently doing nothing.
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['reporter_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      /** Added by 004. */
      play_sessions: {
        Row: {
          created_at: string;
          hours: number;
          id: string;
          log_id: string;
          note: string | null;
          platform: string | null;
          played_on: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          hours: number;
          id?: string;
          log_id: string;
          note?: string | null;
          platform?: string | null;
          played_on?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          hours?: number;
          id?: string;
          log_id?: string;
          note?: string | null;
          platform?: string | null;
          played_on?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'profiles_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'play_sessions_log_id_fkey';
            columns: ['log_id'];
            isOneToOne: false;
            referencedRelation: 'game_logs';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      get_log_likes: {
        Args: { p_log_ids: string[] };
        Returns: {
          log_id: string;
          like_count: number;
          liked_by_me: boolean;
        }[];
      };
      get_game_stats: {
        Args: { p_game_id: number };
        Returns: Json;
      };
      get_top_rated_games: {
        Args: { p_limit?: number; p_min_logs?: number };
        Returns: {
          game_id: number;
          name: string;
          cover_url: string | null;
          avg_rating: number | null;
          log_count: number;
        }[];
      };
      get_trending_games: {
        /**
         * Note the parameter name: `p_days`, NOT `p_window_hours`. Passing the
         * wrong name makes PostgREST fail the whole call with PGRST202.
         */
        Args: { p_limit?: number; p_days?: number; p_min_logs?: number };
        Returns: {
          game_id: number;
          name: string;
          cover_url: string | null;
          log_count: number;
          avg_rating: number | null;
        }[];
      };
      get_user_activity_stats: {
        Args: { p_user_id: string };
        Returns: Json;
      };
      get_user_log_history: {
        Args: { p_user_id: string; p_months?: number };
        Returns: {
          month: string;
          logs: number;
          completed: number;
          hours: number;
        }[];
      };
      get_year_in_review: {
        Args: { p_user_id: string; p_year?: number | null };
        Returns: Json;
      };
      search_logs: {
        Args: {
          p_query: string;
          p_limit?: number;
          p_after_rank?: number | null;
          p_after_game?: number | null;
        };
        Returns: {
          game_id: number;
          name: string;
          cover_url: string | null;
          latest_review: string | null;
          match_count: number;
        }[];
      };
      upsert_game: {
        Args: {
          p_id: number;
          p_name: string;
          p_cover_url: string | null;
          p_release_date: string | null;
          p_summary: string | null;
        };
        Returns: undefined;
      };
      redact_spoilers: {
        Args: { p_logs: Json };
        Returns: Json;
      };
      get_suggested_users: {
        Args: { p_exclude: string | null; p_limit?: number };
        Returns: {
          id: string;
          username: string;
          display_name: string | null;
          bio: string | null;
          log_count: number;
        }[];
      };
      /** Added by 004. */
      get_user_activity_heatmap: {
        Args: { p_user_id: string; p_days?: number };
        Returns: {
          day: string;
          logs: number;
          minutes: number;
        }[];
      };
      /** Added by 004. */
      get_game_sessions_summary: {
        Args: { p_log_id: string };
        Returns: {
          session_count: number;
          total_hours: number;
          last_played: string | null;
        }[];
      };
    };
    Enums: {
      log_status: 'backlog' | 'playing' | 'completed' | 'abandoned';
      notification_type: 'like' | 'follow' | 'comment' | 'mention';
    };
    CompositeTypes: Record<never, never>;
  };
};

/** Convenience alias for a row of a table in the `public` schema. */
export type TableRow<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];