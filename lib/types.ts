/** Input test case (from sheet) for one evaluation. */
export interface TestCase {
  test_case_id: string;
  title?: string;
  /** 'single_turn' = one user message; 'multi_turn' = sequence of user inputs. */
  type?: "single_turn" | "multi_turn";
  /** For single_turn: the user message. For multi_turn: first input (display/summary). */
  input_message: string;
  img_url?: string;
  /** For multi_turn only: array of user inputs in order, e.g. ["input 1", "input 2"]. */
  turns?: string[];
  expected_state: string;
  expected_behavior: string;
  forbidden?: string;
  notes?: string;
  is_enabled?: boolean;
  /**
   * Merged into the Evren eval POST JSON alongside messages (never use key "messages").
   * Typical keys: temporal_context ({ timezone, local_time, time_of_day, ... }), memory_context (string).
   */
  eval_context?: Record<string, unknown>;
  /** Category name from sheet (used on upload to resolve to category_id). */
  category?: string;
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

export interface EvrenEvalConfig {
  flash_model: string;
  disable_p0: boolean;
  disable_p1: boolean;
}

export interface EvrenMetrics {
  disable_p0?: boolean;
  disable_p1?: boolean;
  route_controls_version?: number;
  flash_model: string;
  scope: string;
  duration_seconds: number;
  llm_call_seconds: number;
  call_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens: number;
  billable_output_tokens: number;
  usage_complete: boolean;
  estimated_cost_usd: number | null;
  pricing_date: string;
  calls: Array<Record<string, unknown>>;
}

/** Evren model output for one test case. */
export interface EvrenOutput {
  /** Single string or array of strings (one per bubble). */
  evren_response: string | string[];
  detected_states: string;
  metrics?: EvrenMetrics | null;
  route_trace?: RouteTrace | null;
}

/** Payload sent to the evaluator: one test case + Evren's output(s). */
export interface EvaluateInput {
  test_case: TestCase;
  /** Single-turn: one output. Omit when evren_outputs is provided. */
  evren_output?: EvrenOutput;
  /** Multi-turn: full conversation, one output per turn. Use this to evaluate whole conversation. */
  evren_outputs?: EvrenOutput[];
}

/** Token usage and cost for one evaluation call. */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

/** Evaluation result from Gemini (must match evaluator prompt JSON). */
export interface EvaluationResult {
  test_case_id: string;
  success: boolean;
  score: number;
  flags_detected: string;
  reason: string;
  /** Set when token usage is tracked (e.g. from Gemini usageMetadata). */
  token_usage?: TokenUsage;
}

/** Result of one pairwise comparison between two versions. */
export interface PairwiseResult {
  a_id: string;
  b_id: string;
  /** Which label won from the LLM perspective (before un-shuffling). */
  raw_winner: "A" | "B" | "tie";
  /** Actual version_id that won, or null for tie. */
  winner_id: string | null;
  hard_failures: { A: string[]; B: string[] };
  reason: string;
  token_usage?: TokenUsage;
}

/** Stored comparison data for one eval_result (one test case in a session). */
export interface ComparisonData {
  /**
   * Tie tiers ordered from best to worst.
   * Each tier is an array of version_ids (ties share the same tier).
   *
   * Examples:
   * - 2 versions: [[v1], [v2]] or [[v1, v2]] (tie)
   * - 3 versions: [[v2], [v1, v3]]
   */
  tiers: string[][];
  /** Overall comparison reasoning (2-4 sentences). */
  overall_reason: string;
  /** Hard failures keyed by version_id. */
  overall_hard_failures: Record<string, string[]>;
}
