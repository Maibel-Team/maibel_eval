import type { EvrenMetrics } from "./types";
/**
 * Supabase DB types for Maibel Eval.
 *
 * Table names: Supabase/PostgREST usually exposes tables in lowercase.
 * If you created tables with double quotes ("USERS"), use .from('USERS') in code.
 * Column "manually edited" in SQL is here as manually_edited; if your DB has a space, use a view or alias.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface UsersRow {
  user_id: string;
  email: string;
  full_name: string | null;
  is_owner: boolean;
}

/**
 * Structured run provenance stored on test_sessions (TASK-022 / Phase 6).
 * All fields optional — auto-populated at run creation, editable by reviewer.
 */
/** TASK-022 environment labels (run metadata UI + autofill). */
export const RUN_METADATA_ENVIRONMENT_OPTIONS = ["local", "staging", "main", "auto-eval"] as const;

export interface RunMetadata {
  environment?: string | null;
  code_source?: string | null;
  deploy_url?: string | null;
  test_category?: string | null;
  evaluator_model?: string | null;
  summarizer_model?: string | null;
  comparator_model?: string | null;
  run_mode?: string | null;
  sample_size?: string | null;
  repeated_runs_evidence?: string | null;
}

export const RUN_METADATA_KEYS: (keyof RunMetadata)[] = [
  "environment",
  "code_source",
  "deploy_url",
  "test_category",
  "evaluator_model",
  "summarizer_model",
  "comparator_model",
  "run_mode",
  "sample_size",
  "repeated_runs_evidence",
];

export function validateRunMetadata(raw: unknown): RunMetadata {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: RunMetadata = {};
  const str = (k: string): string | null => {
    const v = obj[k];
    if (typeof v === "string") return v.trim().slice(0, 1000) || null;
    return null;
  };
  out.environment = str("environment");
  out.code_source = str("code_source");
  out.deploy_url = str("deploy_url");
  out.test_category = str("test_category");
  out.evaluator_model = str("evaluator_model");
  out.summarizer_model = str("summarizer_model");
  out.comparator_model = str("comparator_model");
  out.run_mode = str("run_mode");
  out.sample_size = str("sample_size");
  out.repeated_runs_evidence = str("repeated_runs_evidence");
  return out;
}

export interface TestSessionsRow {
  session_id: string;
  test_session_id: string;
  user_id: string;
  title: string | null;
  total_cost_usd: number | null;
  total_eval_time_seconds: number | null;
  summary: string | null;
  /** Session-level human interpretation layer (TASK-021). Structured; sits above per-dimension review. */
  session_review_summary: Json;
  /** Pointer to the latest "mutable" snapshot (edits refresh this payload). */
  latest_snapshot_id?: string | null;
  /** Hash of eval_results comparison payloads when session_review_summary was last written (AI or manual). */
  session_review_summary_basis_fingerprint: string | null;
  /** Versioned organization context pack bundle id (see context/md-files/CONTEXT_PACK_MANIFEST.md). */
  context_bundle_id?: string | null;
  mode: "single" | "comparison";
  manually_edited: boolean;
  /** auto: show None or Automated from eval data; manual: user can edit run counts for new versions. */
  repeated_runs_mode: "auto" | "manual";
  /** Structured run provenance (TASK-022). */
  run_metadata?: RunMetadata | Json;
}

/** Eval-only routing observability from /evren-eval route_trace. */
export interface RouteTrace {
  primary_agent?: string | null;
  agents_considered?: string[];
  intent?: string[];
  active_gates?: string[];
  response_path?: string | null;
  /** Legacy fields; may exist in runs stored before MAI-195 shape change. */
  selected_route?: string[];
  candidate_routes?: string[];
  confidence?: number | null;
}

/** One turn of Evren output within a version. */
export interface VersionTurn {
  response: string[];
  detected_flags: string;
  metrics?: EvrenMetrics | null;
  route_trace?: RouteTrace | null;
}

export type VersionEvidenceSource = "none" | "automated";

export interface RunEntry {
  run_id: string;
  run_index: number;
  turns: VersionTurn[];
  request_duration_seconds?: number;
  code_source?: string | null;
  eval_user_id?: string | null;
}

/** One version stored in eval_results.evren_responses. */
export interface VersionEntry {
  eval_config?: import("./types").EvrenEvalConfig;
  version_id: string;
  version_name: string;
  run_count_requested: number;
  evidence_source: VersionEvidenceSource;
  comparison_basis_run_index: 1;
  runs: RunEntry[];
}

/** Legacy shape kept for backward compatibility with older rows. */
export interface LegacyVersionEntry {
  version_id: string;
  version_name: string;
  turns: VersionTurn[];
}

export type AnyVersionEntry = VersionEntry | LegacyVersionEntry;

export function normalizeVersionEntry(version: AnyVersionEntry): VersionEntry {
  if ("runs" in version && Array.isArray(version.runs)) {
    return {
      eval_config: version.eval_config,
      version_id: version.version_id,
      version_name: version.version_name,
      run_count_requested:
        typeof version.run_count_requested === "number" && version.run_count_requested > 0
          ? Math.floor(version.run_count_requested)
          : version.runs.length || 1,
      evidence_source:
        version.evidence_source === "automated" || version.evidence_source === "none"
          ? version.evidence_source
          : (version.runs.length > 1 ? "automated" : "none"),
      comparison_basis_run_index: 1,
      runs: version.runs.map((run, idx) => ({
        run_id: String(run.run_id ?? crypto.randomUUID()),
        run_index:
          typeof run.run_index === "number" && run.run_index > 0
            ? Math.floor(run.run_index)
            : idx + 1,
        turns: Array.isArray(run.turns) ? run.turns : [],
        request_duration_seconds: run.request_duration_seconds,
        code_source: run.code_source,
        eval_user_id: run.eval_user_id,
      })),
    };
  }

  const turns =
    "turns" in version && Array.isArray(version.turns) ? version.turns : [];
  return {
    version_id: version.version_id,
    version_name: version.version_name,
    run_count_requested: 1,
    evidence_source: "none",
    comparison_basis_run_index: 1,
    runs: [
      {
        run_id: crypto.randomUUID(),
        run_index: 1,
        turns,
      },
    ],
  };
}

export interface EvalResultsRow {
  eval_result_id: string;
  session_id: string;
  test_case_uuid: string;
  /** Array of version objects, each containing its own turns. */
  evren_responses: VersionEntry[];
  success: boolean;
  score: number;
  reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  manually_edited: boolean;
  /** Per version_id: pass | fail | na per dimension (+ optional notes). See lib/behavior-review.ts. */
  behavior_review: Json;
  /** Pairwise comparison data (champion-challenge results). */
  comparison: Json | null;
}

export interface CategoriesRow {
  category_id: string;
  name: string;
  deleted_at: string | null;
}

export interface TestCasesRow {
  id: string;
  test_case_id: string;
  title: string | null;
  category_id: string | null;
  type: "single_turn" | "multi_turn";
  input_message: string;
  img_url: string | null;
  /** Multi-turn: array of user inputs only, e.g. ["input 1", "input 2"]. */
  turns: string[] | null;
  expected_state: string;
  expected_behavior: string;
  forbidden: string | null;
  notes: string | null;
  is_enabled: boolean;
  /** Merged into Evren POST body with messages (never carries messages key). */
  eval_context: Json | null;
}

export interface DefaultSettingsRow {
  default_setting_id: string;
  evren_api_url: string | null;
  evaluator_model: string | null;
  evaluator_prompt: string | null;
  summarizer_model: string | null;
  summarizer_prompt: string | null;
}

export interface SessionResultSnapshotsRow {
  snapshot_id: string;
  session_id: string;
  kind: string;
  message: string | null;
  payload: Json;
  created_at: string;
}

/** Use this type when your DB has quoted table names (e.g. "USERS"). */
export interface Database {
  public: {
    Tables: {
      users: { Row: UsersRow; Insert: Omit<UsersRow, "user_id"> & { user_id?: string }; Update: Partial<UsersRow> };
      test_sessions: {
        Row: TestSessionsRow;
        Insert: Omit<TestSessionsRow, "session_id" | "test_session_id" | "mode" | "repeated_runs_mode"> & {
          session_id?: string;
          test_session_id?: string;
          mode?: TestSessionsRow["mode"];
          repeated_runs_mode?: TestSessionsRow["repeated_runs_mode"];
        };
        Update: Partial<TestSessionsRow>;
      };
      eval_results: {
        Row: EvalResultsRow;
        Insert: Omit<EvalResultsRow, "eval_result_id" | "behavior_review"> & {
          eval_result_id?: string;
          behavior_review?: Json;
        };
        Update: Partial<EvalResultsRow>;
      };
      test_cases: { Row: TestCasesRow; Insert: Omit<TestCasesRow, "id" | "test_case_id"> & { id?: string; test_case_id?: string }; Update: Partial<TestCasesRow> };
      default_settings: { Row: DefaultSettingsRow; Insert: Omit<DefaultSettingsRow, "default_setting_id"> & { default_setting_id?: string }; Update: Partial<DefaultSettingsRow> };
      categories: { Row: CategoriesRow; Insert: Omit<CategoriesRow, "category_id"> & { category_id?: string }; Update: Partial<CategoriesRow> };
      session_result_snapshots: {
        Row: SessionResultSnapshotsRow;
        Insert: Omit<SessionResultSnapshotsRow, "snapshot_id" | "created_at"> & { snapshot_id?: string; created_at?: string };
        Update: Partial<SessionResultSnapshotsRow>;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
