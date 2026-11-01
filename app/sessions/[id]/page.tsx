"use client";
import { EvrenRouteToggles } from "@/app/components/EvrenRouteToggles";
import { EvrenModelSelect } from "@/app/components/EvrenModelSelect";
import { EvrenTurnMetrics } from "@/app/components/EvrenTurnMetrics";

import Link from "next/link";
import { Pencil, RefreshCw, Save, X, Trash2, Check, Plus, Eye, EyeOff, Eraser, GitCommitHorizontal } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SummaryEditor } from "@/app/components/SummaryEditor";
import { DEFAULT_EVAL_LLM_MODEL } from "@/lib/eval-llm-defaults";
import { computeTokenCostParts } from "@/lib/token-cost";
import {
  BEHAVIOR_REVIEW_DIMENSIONS,
  emptyVersionBehaviorReview,
  parseVersionBehaviorReview,
  type BehaviorReviewByVersion,
  type BehaviorReviewConfidence,
  type BehaviorReviewDimensionKey,
  type BehaviorReviewRating,
  type VersionBehaviorReview,
} from "@/lib/behavior-review";
import {
  normalizeVersionEntry,
  RUN_METADATA_ENVIRONMENT_OPTIONS,
  validateRunMetadata,
} from "@/lib/db.types";
import type { AnyVersionEntry, RunMetadata, RouteTrace, VersionEntry } from "@/lib/db.types";
import { fingerprintEvalResultsComparisons } from "@/lib/session-review-summary-basis";
import {
  SESSION_REVIEW_FAILURE_TAXONOMY,
  emptySessionReviewSummaryV0,
  parseSessionReviewSummaryV0,
  type SessionReviewFailureThemeKey,
  type SessionReviewSummaryV0,
  type SessionOverallFinding,
  type SessionRecommendation,
  type SessionTrustSeverity,
} from "@/lib/session-review-summary";

type Session = {
  test_session_id: string;
  user_id: string;
  title: string | null;
  total_cost_usd: number | null;
  total_eval_time_seconds?: number | null;
  summary: string | null;
  session_review_summary?: unknown;
  session_review_summary_basis_fingerprint?: string | null;
  mode?: "single" | "comparison";
  manually_edited: boolean;
  run_metadata?: RunMetadata | null;
  created_at?: string | null;
  users?: { full_name: string | null; email: string } | null;
};

type SessionModels = {
  evaluator_model: string | null;
  summarizer_model: string | null;
};

type SnapshotListItem = {
  snapshot_id: string;
  created_at: string;
  kind: string;
  message: string | null;
};

function formatSessionDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatSnapshotRelativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function snapshotKindPresentation(kind: string): { label: string; badgeClass: string } {
  if (kind === "before_add_version") {
    return {
      label: "Before add version",
      badgeClass: "bg-amber-100 text-amber-900 ring-1 ring-amber-200/80",
    };
  }
  if (kind === "before_delete_version") {
    return {
      label: "Before delete version",
      badgeClass: "bg-rose-100 text-rose-900 ring-1 ring-rose-200/80",
    };
  }
  if (kind === "before_rerun_comparison") {
    return {
      label: "Before rerun comparison",
      badgeClass: "bg-violet-100 text-violet-900 ring-1 ring-violet-200/80",
    };
  }
  if (kind === "current") {
    return {
      label: "Working copy",
      badgeClass: "bg-slate-100 text-slate-800 ring-1 ring-slate-200/80",
    };
  }
  return {
    label: kind.replaceAll("_", " "),
    badgeClass: "bg-stone-100 text-stone-800 ring-1 ring-stone-200/80",
  };
}

function formatEvalTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatUsd(value: number | null | undefined, decimals: number = 6): string {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return `$${n.toFixed(decimals)} USD`;
}

/** Primary Save buttons on session detail — match Clear control size (px-2.5 py-1.5 text-xs). */
const SESSION_SAVE_BTN_BASE =
  "inline-flex shrink-0 items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-50";
const SESSION_SAVE_BTN_IDLE = "bg-stone-900 hover:bg-stone-800";
const SESSION_SAVE_BTN_WORKING = "bg-stone-700";
const SESSION_SAVE_BTN_SAVED = "bg-emerald-600 hover:bg-emerald-600";

function sessionSaveButtonClass(opts: { working?: boolean; saved?: boolean }): string {
  const variant = opts.working ? SESSION_SAVE_BTN_WORKING : opts.saved ? SESSION_SAVE_BTN_SAVED : SESSION_SAVE_BTN_IDLE;
  return `${SESSION_SAVE_BTN_BASE} ${variant}`;
}

function playCompletionSound() {
  try {
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const playTone = (freq: number, startTime: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.15, startTime);
      gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    playTone(523.25, 0, 0.15);
    playTone(659.25, 0.2, 0.2);
  } catch {
    /* ignore */
  }
}

function notifyVersionAdded() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  try {
    if (Notification.permission === "granted") {
      new Notification("Add version complete", {
        body: "New Evren versions were added for this session.",
        icon: "/favicon.ico",
      });
    }
  } catch {
    /* ignore */
  }
}

/** If the stored summary is raw JSON from the summarizer, extract the summary field and normalize newlines for display. */
function summaryForDisplay(raw: string | null | undefined): string {
  if (raw == null) return "";
  const str = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (!str.trim()) return "";
  let trimmed = str.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { summary?: string; title?: string };
      const content = typeof parsed.summary === "string" ? parsed.summary : undefined;
      if (content) trimmed = content.replace(/\\n/g, "\n");
    } catch {
      // Fallback: match "summary":"...", including long strings ([\s\S] allows newlines in the regex source)
      const m = trimmed.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) trimmed = m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n");
    }
  } else {
    trimmed = trimmed.replace(/\\n/g, "\n");
  }
  // Remove "# Evren Model Validation Report" and the Date/Model Version/Reviewer line so output starts at ## 1.
  trimmed = trimmed.replace(/^#\s*Evren Model Validation Report\s*\n?/i, "");
  trimmed = trimmed.replace(/\n\nDate: [^\n]*\nModel Version: [^\n]*\nReviewer: [^\n]*/gi, "\n\n");
  trimmed = trimmed.replace(/\nDate: [^\n]*\nModel Version: [^\n]*\nReviewer: [^\n]*/gi, "\n");
  trimmed = trimmed.replace(/\nDate: [^\n]+Model Version: [^\n]+Reviewer: [^\n]+/gi, ""); // single-line metadata
  return trimmed.trim();
}

type ComparisonData = {
  tiers: string[][];
  overall_reason: string;
  overall_hard_failures: Record<string, string[]>;
  token_usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
} | null;

type EvalResult = {
  eval_result_id: string;
  test_session_id: string;
  test_case_id: string;
  success: boolean;
  score: number;
  reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  manually_edited: boolean;
  evren_responses?: AnyVersionEntry[] | null;
  test_cases?: { input_message: string; expected_state: string; expected_behavior: string; title?: string | null; type?: "single_turn" | "multi_turn"; turns?: string[] | null } | null;
  comparison?: ComparisonData;
  behavior_review?: BehaviorReviewByVersion | null;
};

type SessionSnapshotPayload = {
  session?: {
    test_session_id?: string;
    title?: string | null;
    mode?: "single" | "comparison";
    summary?: string | null;
    session_review_summary?: unknown;
  };
  eval_results?: Array<{
    eval_result_id: string;
    test_case_id: string | null;
    test_case_title: string | null;
    comparison: ComparisonData | null;
    behavior_review: unknown;
    reason: string | null;
    success: boolean;
    score: number;
    manually_edited?: boolean;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
    cost_usd?: number | null;
    evren_responses?: AnyVersionEntry[] | null;
    test_cases?: EvalResult["test_cases"] | Record<string, unknown> | null;
  }>;
};

function shortSnapshotId(snapshotId: string): string {
  return snapshotId.replace(/-/g, "").slice(0, 7);
}

function normalizeSnapshotTestCases(raw: unknown): EvalResult["test_cases"] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return {
    input_message: String(o.input_message ?? ""),
    expected_state: String(o.expected_state ?? ""),
    expected_behavior: String(o.expected_behavior ?? ""),
    title: o.title != null && String(o.title).trim() ? String(o.title) : null,
    type: o.type === "multi_turn" ? "multi_turn" : "single_turn",
    turns: Array.isArray(o.turns) ? o.turns.map((x) => String(x)) : null,
  };
}

/** Replay checkpoint rows as full EvalResult[] (merge with live rows for ids / session id). */
function checkpointRowsToEvalResults(
  payload: SessionSnapshotPayload,
  live: EvalResult[],
  testSessionId: string
): EvalResult[] {
  const rows = payload.eval_results;
  if (!rows?.length) return live;
  const liveById = new Map(live.map((r) => [r.eval_result_id, r]));
  return rows.map((snap) => {
    const liveRow = liveById.get(snap.eval_result_id);
    const evrenArr =
      Array.isArray(snap.evren_responses) && snap.evren_responses.length > 0 ? snap.evren_responses : null;
    const testCases = normalizeSnapshotTestCases(snap.test_cases);
    const comparison = snap.comparison ?? undefined;
    const behaviorReview = snap.behavior_review as BehaviorReviewByVersion | null | undefined;

    const base: EvalResult =
      liveRow ??
      ({
        eval_result_id: snap.eval_result_id,
        test_session_id: testSessionId,
        test_case_id: snap.test_case_id ?? "",
        success: snap.success,
        score: snap.score,
        reason: snap.reason,
        prompt_tokens: snap.prompt_tokens ?? null,
        completion_tokens: snap.completion_tokens ?? null,
        total_tokens: snap.total_tokens ?? null,
        cost_usd: snap.cost_usd ?? null,
        manually_edited: snap.manually_edited ?? false,
        evren_responses: evrenArr,
        test_cases: testCases,
        comparison: comparison ?? null,
        behavior_review: behaviorReview ?? null,
      } as EvalResult);

    const mergedEvren = evrenArr && evrenArr.length > 0 ? evrenArr : base.evren_responses ?? null;
    const mergedTc = testCases ?? base.test_cases ?? null;
    return {
      ...base,
      test_case_id: snap.test_case_id ?? base.test_case_id,
      evren_responses: mergedEvren,
      test_cases: mergedTc,
      comparison: comparison ?? base.comparison,
      behavior_review: behaviorReview ?? base.behavior_review ?? null,
      reason: snap.reason ?? base.reason,
      success: snap.success,
      score: snap.score,
      manually_edited: snap.manually_edited ?? base.manually_edited,
      prompt_tokens: snap.prompt_tokens ?? base.prompt_tokens,
      completion_tokens: snap.completion_tokens ?? base.completion_tokens,
      total_tokens: snap.total_tokens ?? base.total_tokens,
      cost_usd: snap.cost_usd ?? base.cost_usd,
    };
  });
}

type AddVersionProgress = {
  stage: string;
  index?: number;
  total?: number;
  test_case_id?: string;
  message?: string;
};

function matchResultSearch(r: EvalResult, q: string): boolean {
  if (!q.trim()) return true;
  const lower = q.trim().toLowerCase();
  const id = (r.test_case_id ?? "").toLowerCase();
  const title = (r.test_cases?.title ?? "").toLowerCase();
  const typeStr = r.test_cases?.type === "multi_turn" ? "multi turn multi-turn" : "single turn single-turn";
  const turnsStr = (r.test_cases?.turns ?? []).join(" ").toLowerCase();
  return id.includes(lower) || title.includes(lower) || typeStr.includes(lower) || turnsStr.includes(lower);
}

function isResultEvaluated(r: EvalResult): boolean {
  if (r.prompt_tokens != null || r.completion_tokens != null || r.total_tokens != null) return true;
  if (typeof r.reason === "string" && r.reason.trim() !== "") return true;
  return false;
}

function getComparisonTokenUsage(r: EvalResult): { prompt: number; completion: number; total: number; costUsd: number } | null {
  const usage = r.comparison?.token_usage;
  if (!usage) return null;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : null;
  const costUsd = typeof usage.cost_usd === "number" ? usage.cost_usd : null;
  if (prompt == null || completion == null || costUsd == null) return null;
  return { prompt, completion, total: total ?? prompt + completion, costUsd };
}

function getVersionEntries(results: EvalResult[]): VersionEntry[] {
  /** Use the row with the most versions — not only `results[0]`, which may have skipped an add (e.g. Evren error) while other rows have the new version. */
  let best: VersionEntry[] = [];
  for (const r of results) {
    const v = r.evren_responses;
    const normalized = Array.isArray(v) ? v.map(normalizeVersionEntry) : [];
    if (normalized.length > best.length) best = normalized;
  }
  return best;
}

/** Merge duplicate ids by version_name (first occurrence wins as canonical id). */
function canonicalIdFromVersionPairs(pairs: Array<{ version_id: string; version_name: string }>): (vid: string) => string {
  const idToName = new Map<string, string>();
  const nameToCanonicalId = new Map<string, string>();
  for (const v of pairs) {
    if (!idToName.has(v.version_id)) idToName.set(v.version_id, v.version_name);
    if (!nameToCanonicalId.has(v.version_name)) nameToCanonicalId.set(v.version_name, v.version_id);
  }
  return (vid: string) => {
    const name = idToName.get(vid) ?? vid;
    return nameToCanonicalId.get(name) ?? vid;
  };
}

/** Same canonicalization as the version comparison table (merge duplicate ids by version name). */
function buildCanonicalVersionIdMap(results: EvalResult[]): { canonicalId: (vid: string) => string } {
  const pairs: { version_id: string; version_name: string }[] = [];
  for (const r of results) {
    for (const v of r.evren_responses ?? []) {
      pairs.push({ version_id: v.version_id, version_name: v.version_name });
    }
  }
  return { canonicalId: canonicalIdFromVersionPairs(pairs) };
}

/** Per eval_result row: canonicalize ids using only that row's versions (tiers / behavior_review keys vs evren_responses). */
function buildCanonicalVersionIdMapForRow(r: EvalResult): (vid: string) => string {
  const pairs = (r.evren_responses ?? []) as Array<{ version_id: string; version_name: string }>;
  return canonicalIdFromVersionPairs(pairs);
}

function versionBehaviorReviewIsPass(review: VersionBehaviorReview | undefined): boolean | null {
  if (!review) return null;
  for (const d of BEHAVIOR_REVIEW_DIMENSIONS) {
    const v = review[d.key];
    if (v === "fail") return false;
  }
  for (const d of BEHAVIOR_REVIEW_DIMENSIONS) {
    const v = review[d.key];
    if (v === "pass" || v === "na") return true;
  }
  return null;
}

function topTierHasAnyOverallHardFailure(
  topCanonicalIds: string[],
  overallHardFailures: Record<string, string[]> | null | undefined,
  sessionCanonicalId: (id: string) => string
): boolean {
  if (!overallHardFailures || topCanonicalIds.length === 0) return false;
  for (const tid of topCanonicalIds) {
    for (const [k, list] of Object.entries(overallHardFailures)) {
      if (sessionCanonicalId(k) !== tid) continue;
      if (Array.isArray(list) && list.length > 0) return true;
    }
  }
  return false;
}

/**
 * Comparison mode: pass/fail for the session champion on one eval row.
 * Uses per-case comparison tiers when present; otherwise behavior review or (single version) completed Evren runs.
 */
function championPassForComparisonRow(
  r: EvalResult,
  championCanonical: string,
  canonicalId: (id: string) => string,
  versionCount: number
): boolean | null {
  const champEntry = (r.evren_responses ?? []).find((v) => canonicalId(v.version_id) === championCanonical);
  if (!champEntry) return null;

  const tiers = r.comparison?.tiers;
  const top = Array.isArray(tiers?.[0]) ? tiers![0].map((x) => canonicalId(String(x))) : [];
  if (top.length > 0) {
    if (!top.includes(championCanonical)) return false;
    const hf = r.comparison?.overall_hard_failures;
    if (topTierHasAnyOverallHardFailure(top, hf, canonicalId)) return false;
    return true;
  }

  const nv = normalizeVersionEntry(champEntry);
  const brRaw =
    r.behavior_review?.[nv.version_id] ??
    (Object.entries(r.behavior_review ?? {}).find(([k]) => canonicalId(k) === championCanonical)?.[1] as
      | VersionBehaviorReview
      | undefined);
  const brPass = versionBehaviorReviewIsPass(brRaw);
  if (brPass !== null) return brPass;

  if (versionCount <= 1) {
    const runs = nv.runs ?? [];
    return runs.length > 0 ? true : null;
  }

  return false;
}

/** DB/session_review_summary merged with client-side fallbacks for cases / pass-fail lines. */
function mergeSessionReviewSummaryFromSession(
  session: Session | null,
  results: EvalResult[]
): SessionReviewSummaryV0 {
  const parsed = parseSessionReviewSummaryV0(session?.session_review_summary);
  const passCount = results.filter((r) => r && typeof r.success === "boolean" && r.success).length;
  const totalCount = results.filter((r) => r && typeof r.success === "boolean").length;
  const versionsText = (() => {
    const versions = getVersionEntries(results);
    if (versions.length === 0) return null;
    const names = versions.map((v) => v.version_name).filter(Boolean);
    if (names.length === 0) return null;
    return names.join(", ");
  })();
  const suggestedCasesVersions =
    totalCount > 0
      ? `${totalCount} cases; versions: ${versionsText ?? "—"}`
      : versionsText
        ? `versions: ${versionsText}`
        : null;
  const suggestedPassFail =
    totalCount > 0 ? `${passCount} / ${totalCount} passed` : null;

  const looksLikeUuid = (s: string) =>
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s);

  return {
    ...parsed,
    cases_versions_tested:
      parsed.cases_versions_tested == null ||
      (typeof parsed.cases_versions_tested === "string" && looksLikeUuid(parsed.cases_versions_tested))
        ? suggestedCasesVersions
        : parsed.cases_versions_tested,
    pass_fail_summary: parsed.pass_fail_summary ?? suggestedPassFail,
  };
}

function getTurnCount(versions: VersionEntry[]): number {
  let maxTurns = 0;
  for (const version of versions) {
    for (const run of version.runs) {
      maxTurns = Math.max(maxTurns, run.turns.length);
    }
  }
  return maxTurns;
}

function evalResultsHaveAnyMultiRun(results: EvalResult[]): boolean {
  for (const r of results) {
    const vers = Array.isArray(r.evren_responses) ? r.evren_responses.map(normalizeVersionEntry) : [];
    for (const v of vers) {
      if (v.runs.length > 1) return true;
    }
  }
  return false;
}

function evalResultsHaveAnyMultiTurn(results: EvalResult[]): boolean {
  for (const r of results) {
    if (r.test_cases?.type === "multi_turn") return true;
  }
  return false;
}

/** Shared style for secondary “Edit” actions (header, summary, result rows). */
const editTriggerClassName =
  "inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2 py-1 text-sm font-medium text-stone-600 transition-colors hover:border-stone-400 hover:bg-stone-50 hover:text-stone-900";

function prettyDetectedFlags(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "—";
  try {
    const parsed = JSON.parse(raw) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function prettyRouteTrace(value: RouteTrace | null | undefined): string {
  if (!value) return "—";
  const hasNewShape =
    "primary_agent" in value || "agents_considered" in value || "response_path" in value;
  if (!hasNewShape) {
    return JSON.stringify(value, null, 2);
  }
  const fmt = (v: unknown): string => {
    if (v == null) return "null";
    if (Array.isArray(v)) return v.length ? v.join(", ") : "[]";
    return String(v);
  };
  return [
    `- primary_agent = ${fmt(value.primary_agent ?? null)}`,
    `- agents_considered = ${fmt(value.agents_considered ?? [])}`,
    `- intent = ${fmt(value.intent ?? [])}`,
    `- active_gates = ${fmt(value.active_gates ?? [])}`,
    `- response_path = ${fmt(value.response_path ?? null)}`,
  ].join("\n");
}

function turnHasRouteTrace(routeTrace: RouteTrace | null | undefined): boolean {
  if (!routeTrace) return false;
  return (
    (routeTrace.primary_agent != null && routeTrace.primary_agent !== "") ||
    (routeTrace.agents_considered?.length ?? 0) > 0 ||
    (routeTrace.active_gates?.length ?? 0) > 0 ||
    (routeTrace.intent?.length ?? 0) > 0 ||
    (routeTrace.response_path != null && routeTrace.response_path !== "") ||
    (routeTrace.selected_route?.length ?? 0) > 0 ||
    (routeTrace.candidate_routes?.length ?? 0) > 0 ||
    routeTrace.confidence != null
  );
}

function getBehaviorReviewDraft(
  r: EvalResult,
  versionId: string,
  draftByResult: Record<string, Record<string, VersionBehaviorReview>>
): VersionBehaviorReview {
  const chunk = draftByResult[r.eval_result_id];
  if (chunk?.[versionId]) return chunk[versionId];
  const br = r.behavior_review;
  if (br && typeof br === "object" && !Array.isArray(br)) {
    const brObj = br as Record<string, unknown>;
    const direct = parseVersionBehaviorReview(brObj[versionId]);
    if (direct) return direct;
    const rowCanon = buildCanonicalVersionIdMapForRow(r);
    const target = rowCanon(versionId);
    const altKey = Object.keys(brObj).find((k) => rowCanon(k) === target);
    if (altKey) {
      const parsed = parseVersionBehaviorReview(brObj[altKey]);
      if (parsed) return parsed;
    }
  }
  return emptyVersionBehaviorReview();
}

export default function SessionDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [session, setSession] = useState<Session | null>(null);
  const [models, setModels] = useState<SessionModels>({ evaluator_model: null, summarizer_model: null });
  const [results, setResults] = useState<EvalResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aiEditingComparisonId, setAiEditingComparisonId] = useState<string | null>(null);
  const [aiComparisonFeedback, setAiComparisonFeedback] = useState("");
  const [applyingAiComparison, setApplyingAiComparison] = useState(false);
  const [editingReasonId, setEditingReasonId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState("");
  const [editScore, setEditScore] = useState<number>(0);
  const [editSuccess, setEditSuccess] = useState<boolean>(true);
  const [savingReason, setSavingReason] = useState(false);
  const [behaviorReviewDraft, setBehaviorReviewDraft] = useState<
    Record<string, Record<string, VersionBehaviorReview>>
  >({});
  const [savingBehaviorReviewId, setSavingBehaviorReviewId] = useState<string | null>(null);
  const [savedBehaviorReviewId, setSavedBehaviorReviewId] = useState<string | null>(null);
  const behaviorReviewSavedTimeoutRef = useRef<number | null>(null);
  const [summary, setSummary] = useState("");
  const [editingSummary, setEditingSummary] = useState(false);
  const [savingSummary, setSavingSummary] = useState(false);
  const [sessionReviewSummary, setSessionReviewSummary] = useState<SessionReviewSummaryV0>(
    emptySessionReviewSummaryV0()
  );
  const [savingSessionReviewSummary, setSavingSessionReviewSummary] = useState(false);
  const [savedSessionReviewSummary, setSavedSessionReviewSummary] = useState(false);
  const [resummarizingSessionReviewSummary, setResummarizingSessionReviewSummary] = useState(false);
  const sessionReviewSavedTimeoutRef = useRef<number | null>(null);
  const [refiningWording, setRefiningWording] = useState(false);
  const [resummarizing, setResummarizing] = useState(false);
  const [rerunningComparison, setRerunningComparison] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingVersion, setAddingVersion] = useState(false);
  const [addVersionProgress, setAddVersionProgress] = useState<AddVersionProgress | null>(null);
  const [addVersionCounts, setAddVersionCounts] = useState<{
    versionAddedDone: number;
    versionAddedTotal: number;
    comparisonDone: number;
    comparisonTotal: number;
    comparisonEnabled: boolean;
  }>({
    versionAddedDone: 0,
    versionAddedTotal: 0,
    comparisonDone: 0,
    comparisonTotal: 0,
    comparisonEnabled: false,
  });
  const [showAddVersionModal, setShowAddVersionModal] = useState(false);
  const [draftVersions, setDraftVersions] = useState<{ version_id: string; version_name: string }[]>([]);
  const [newVersionLabel, setNewVersionLabel] = useState("Version 2");
  const [runComparison, setRunComparison] = useState(true);
  const [evrenFlashModel, setEvrenFlashModel] = useState("gemini-2.5-flash");
  const [disableP0, setDisableP0] = useState(false);
  const [disableP1, setDisableP1] = useState(false);
  const [addVersionRunCount, setAddVersionRunCount] = useState(1);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [deletingVersionId, setDeletingVersionId] = useState<string | null>(null);
  const [savingNames, setSavingNames] = useState(false);
  const [editingHeader, setEditingHeader] = useState(false);
  const [editSessionId, setEditSessionId] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [savingHeader, setSavingHeader] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [runMetadataDraft, setRunMetadataDraft] = useState<RunMetadata>({});
  const [savingRunMetadata, setSavingRunMetadata] = useState(false);
  const [savedRunMetadata, setSavedRunMetadata] = useState(false);
  const [expandedResultId, setExpandedResultId] = useState<string | null>(null);
  const [expandedFlagsKeys, setExpandedFlagsKeys] = useState<Set<string>>(new Set());
  const [expandedRouteTraceKeys, setExpandedRouteTraceKeys] = useState<Set<string>>(new Set());
  const [expandedRunsKeys, setExpandedRunsKeys] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [passFailFilter, setPassFailFilter] = useState<"" | "pass" | "fail">("");
  const [typeFilter, setTypeFilter] = useState<"" | "single_turn" | "multi_turn">("");
  const [sortBy, setSortBy] = useState<"id" | "score">("id");
  const [showComparatorMetrics, setShowComparatorMetrics] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotListItem[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  const [activeSnapshotId, setActiveSnapshotId] = useState<string | null>(null);
  const [activeSnapshotMeta, setActiveSnapshotMeta] = useState<SnapshotListItem | null>(null);
  const [activeSnapshotPayload, setActiveSnapshotPayload] = useState<SessionSnapshotPayload | null>(null);
  const [editingSnapshotMessage, setEditingSnapshotMessage] = useState(false);
  const [snapshotMessageDraft, setSnapshotMessageDraft] = useState("");
  const [savingSnapshotMessage, setSavingSnapshotMessage] = useState(false);
  const [deletingSnapshot, setDeletingSnapshot] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const router = useRouter();

  const isViewingCheckpoint = Boolean(activeSnapshotId && activeSnapshotPayload);
  const effectiveResults = useMemo(() => {
    if (!isViewingCheckpoint || !activeSnapshotPayload) return results;
    return checkpointRowsToEvalResults(activeSnapshotPayload, results, session?.test_session_id ?? "");
  }, [isViewingCheckpoint, activeSnapshotPayload, results, session?.test_session_id]);

  const displaySessionReviewSummary = useMemo(() => {
    if (!isViewingCheckpoint || !activeSnapshotPayload?.session || !session) return sessionReviewSummary;
    return mergeSessionReviewSummaryFromSession(
      {
        ...session,
        session_review_summary: activeSnapshotPayload.session.session_review_summary,
      } as Session,
      effectiveResults
    );
  }, [isViewingCheckpoint, activeSnapshotPayload, session, sessionReviewSummary, effectiveResults]);

  const versionEntries = useMemo(() => getVersionEntries(effectiveResults), [effectiveResults]);
  const versionCount = versionEntries.length;
  const sessionCanonicalId = useMemo(() => buildCanonicalVersionIdMap(effectiveResults).canonicalId, [effectiveResults]);
  const comparisonStats = useMemo(() => {
    const statsMap = new Map<string, { version_id: string; version_name: string; wins: number; ties: number; losses: number }>();
    const idToName = new Map<string, string>();
    const nameToCanonicalId = new Map<string, string>();

    for (const r of effectiveResults) {
      for (const v of (r.evren_responses ?? [])) {
        if (!idToName.has(v.version_id)) idToName.set(v.version_id, v.version_name);
        if (!nameToCanonicalId.has(v.version_name)) nameToCanonicalId.set(v.version_name, v.version_id);
      }
    }

    const canonicalId = (vid: string): string => {
      const name = idToName.get(vid) ?? vid;
      return nameToCanonicalId.get(name) ?? vid;
    };

    for (const r of effectiveResults) {
      const versions = r.evren_responses ?? [];
      const tiers = r.comparison?.tiers;

      for (const v of versions) {
        const cid = canonicalId(v.version_id);
        if (!statsMap.has(cid)) {
          statsMap.set(cid, { version_id: cid, version_name: v.version_name, wins: 0, ties: 0, losses: 0 });
        }
      }

      if (!tiers || tiers.length === 0) continue;
      const topTier = Array.isArray(tiers[0]) ? tiers[0].map(String) : [];
      if (topTier.length === 0) continue;
      const isTie = topTier.length > 1;
      const topCanonical = new Set(topTier.map((t) => canonicalId(t)));

      for (const v of versions) {
        const cid = canonicalId(v.version_id);
        const entry = statsMap.get(cid)!;
        const inTop = topCanonical.has(cid);
        if (isTie && inTop) {
          entry.ties++;
        } else if (!isTie && inTop) {
          entry.wins++;
        } else {
          entry.losses++;
        }
      }
    }

    return Array.from(statsMap.values())
      .map((s) => ({ ...s, score: s.wins * 3 + s.ties * 1 }))
      .sort((a, b) => b.score - a.score);
  }, [effectiveResults]);

  const filteredResults = useMemo(() => {
    const filtered = effectiveResults.filter((r) => {
      if (!matchResultSearch(r, searchQuery)) return false;
      const evaluated = isResultEvaluated(r);
      if (passFailFilter === "pass" && (!evaluated || !r.success)) return false;
      if (passFailFilter === "fail" && (!evaluated || r.success)) return false;
      if (typeFilter && r.test_cases?.type !== typeFilter) return false;
      return true;
    });
    const sorted = [...filtered];
    if (sortBy === "id") {
      sorted.sort((a, b) => (a.test_case_id ?? "").localeCompare(b.test_case_id ?? "", undefined, { numeric: true }));
    } else {
      sorted.sort((a, b) => {
        const aEvaluated = isResultEvaluated(a);
        const bEvaluated = isResultEvaluated(b);
        if (aEvaluated && !bEvaluated) return -1;
        if (!aEvaluated && bEvaluated) return 1;
        return b.score - a.score;
      });
    }
    return sorted;
  }, [effectiveResults, searchQuery, passFailFilter, typeFilter, sortBy]);

  const currentComparisonBasisFingerprint = useMemo(
    () =>
      fingerprintEvalResultsComparisons(
        results.map((r) => ({ eval_result_id: r.eval_result_id, comparison: r.comparison ?? null }))
      ),
    [results]
  );

  const sessionReviewSummaryStale = useMemo(() => {
    if (isViewingCheckpoint) return false;
    const stored = session?.session_review_summary_basis_fingerprint ?? null;
    if (session?.mode !== "comparison" || stored == null) return false;
    return stored !== currentComparisonBasisFingerprint;
  }, [isViewingCheckpoint, session?.mode, session?.session_review_summary_basis_fingerprint, currentComparisonBasisFingerprint]);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/sessions/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        const nextSession = data.session as Session | null;
        const nextModels = (data.models ?? null) as SessionModels | null;
        const nextResults = (Array.isArray(data.results) ? data.results : []) as EvalResult[];
        setSession(nextSession);
        if (nextModels && typeof nextModels === "object") setModels(nextModels);
        setResults(nextResults);
        setSummary(summaryForDisplay(nextSession?.summary ?? ""));
        setRunMetadataDraft(validateRunMetadata((nextSession as Record<string, unknown> | null)?.run_metadata));
        setSessionReviewSummary(mergeSessionReviewSummaryFromSession(nextSession, nextResults));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  const loadSnapshotsList = useCallback(async () => {
    if (!id) return;
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/snapshots`);
      const data = (await res.json().catch(() => ({}))) as { error?: string; snapshots?: SnapshotListItem[] };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      setSnapshots(Array.isArray(data.snapshots) ? data.snapshots : []);
    } catch (e) {
      setSnapshotsError(e instanceof Error ? e.message : "Failed to load snapshots");
    } finally {
      setSnapshotsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadSnapshotsList();
  }, [loadSnapshotsList]);

  useEffect(() => {
    if (!isViewingCheckpoint) return;
    setEditingReasonId(null);
    setAiEditingComparisonId(null);
    setEditingVersionId(null);
  }, [isViewingCheckpoint]);

  useEffect(() => {
    setHistoryMenuOpen(false);
  }, [id]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyMenuOpen]);

  async function openSnapshot(meta: SnapshotListItem) {
    setHistoryMenuOpen(false);
    setActiveSnapshotId(meta.snapshot_id);
    setActiveSnapshotMeta(meta);
    setActiveSnapshotPayload(null);
    setSnapshotsError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/snapshots/${meta.snapshot_id}`);
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        snapshot?: { payload?: unknown; message?: string | null };
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      const snap = data.snapshot;
      const payload = (snap?.payload ?? null) as SessionSnapshotPayload | null;
      setActiveSnapshotPayload(payload);
      if (snap != null && snap.message !== undefined && (typeof snap.message === "string" || snap.message === null)) {
        setActiveSnapshotMeta((prev) =>
          prev?.snapshot_id === meta.snapshot_id ? { ...prev, message: snap.message as string | null } : prev
        );
      }
    } catch (e) {
      setSnapshotsError(e instanceof Error ? e.message : "Failed to open snapshot");
      setActiveSnapshotId(null);
      setActiveSnapshotMeta(null);
      setActiveSnapshotPayload(null);
    }
  }

  function closeSnapshot() {
    setEditingSnapshotMessage(false);
    setSnapshotMessageDraft("");
    setActiveSnapshotId(null);
    setActiveSnapshotMeta(null);
    setActiveSnapshotPayload(null);
  }

  function beginRenameSnapshotMessage() {
    if (!activeSnapshotMeta) return;
    setEditingSnapshotMessage(true);
    setSnapshotMessageDraft(activeSnapshotMeta.message ?? "");
    setSnapshotsError(null);
  }

  function cancelRenameSnapshotMessage() {
    setEditingSnapshotMessage(false);
    setSnapshotMessageDraft("");
  }

  async function saveSnapshotMessage() {
    if (!id || !activeSnapshotMeta) return;
    setSavingSnapshotMessage(true);
    setSnapshotsError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/snapshots/${activeSnapshotMeta.snapshot_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: snapshotMessageDraft }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        snapshot?: { message?: string | null };
      };
      if (!res.ok || data.error) throw new Error(data.error ?? "Rename failed");
      const msg =
        typeof data.snapshot?.message === "string" || data.snapshot?.message === null ? data.snapshot.message : undefined;
      if (msg !== undefined) {
        setActiveSnapshotMeta((prev) => (prev ? { ...prev, message: msg } : null));
      }
      setEditingSnapshotMessage(false);
      setSnapshotMessageDraft("");
      await loadSnapshotsList();
    } catch (e) {
      setSnapshotsError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setSavingSnapshotMessage(false);
    }
  }

  async function deleteActiveSnapshot() {
    if (!id || !activeSnapshotMeta) return;
    const hint =
      activeSnapshotMeta.message ??
      snapshotKindPresentation(activeSnapshotMeta.kind).label;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete this snapshot (${shortSnapshotId(activeSnapshotMeta.snapshot_id)} · ${hint})? This cannot be undone.`
      )
    ) {
      return;
    }
    setDeletingSnapshot(true);
    setSnapshotsError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/snapshots/${activeSnapshotMeta.snapshot_id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Delete failed");
      closeSnapshot();
      await loadSnapshotsList();
    } catch (e) {
      setSnapshotsError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingSnapshot(false);
    }
  }

  async function saveSessionReviewSummary() {
    if (!id) return;
    setSavedSessionReviewSummary(false);
    if (sessionReviewSavedTimeoutRef.current != null) {
      window.clearTimeout(sessionReviewSavedTimeoutRef.current);
      sessionReviewSavedTimeoutRef.current = null;
    }
    setSavingSessionReviewSummary(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/review-summary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_review_summary: sessionReviewSummary }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; session?: Session };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (data.session) setSession(data.session);
      setSavedSessionReviewSummary(true);
      sessionReviewSavedTimeoutRef.current = window.setTimeout(() => {
        setSavedSessionReviewSummary(false);
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save session review summary");
    } finally {
      setSavingSessionReviewSummary(false);
    }
  }

  async function resummarizeSessionReviewSummary() {
    if (!id) return;
    setResummarizingSessionReviewSummary(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/resummarize-review-summary`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; session?: Session };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (!data.session) throw new Error("No session returned.");
      const nextSession = data.session;
      setSession(nextSession);
      setSessionReviewSummary(mergeSessionReviewSummaryFromSession(nextSession, results));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to resummarize session review summary");
    } finally {
      setResummarizingSessionReviewSummary(false);
    }
  }

  function getVersionLabel(versionId: string): string {
    const cid = sessionCanonicalId(versionId);
    const entry =
      versionEntries.find((v) => v.version_id === versionId) ??
      versionEntries.find((v) => sessionCanonicalId(v.version_id) === cid);
    const name = entry?.version_name?.trim();
    return name || "Unknown";
  }

  function saveResultEdits(r: EvalResult) {
    if (editingReasonId !== r.eval_result_id) return;
    const scoreToSave = Number.isFinite(editScore) ? editScore : r.score;
    setSavingReason(true);
    fetch(`/api/eval-results/${r.eval_result_id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: editReason, score: scoreToSave, success: editSuccess }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setResults((prev) =>
          prev.map((x) =>
            x.eval_result_id === r.eval_result_id
              ? { ...x, reason: editReason, score: scoreToSave, success: editSuccess, manually_edited: true }
              : x
          )
        );
        setEditingReasonId(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setSavingReason(false));
  }

  async function saveBehaviorReview(r: EvalResult) {
    const reviewVersions = (Array.isArray(r.evren_responses) ? r.evren_responses : [])
      .slice(0, 3)
      .map((v) => normalizeVersionEntry(v as AnyVersionEntry));
    if (reviewVersions.length === 0) return;
    const payload: BehaviorReviewByVersion = {};
    for (const ver of reviewVersions) {
      payload[ver.version_id] = getBehaviorReviewDraft(r, ver.version_id, behaviorReviewDraft);
    }
    setSavedBehaviorReviewId((prev) => (prev === r.eval_result_id ? null : prev));
    if (behaviorReviewSavedTimeoutRef.current != null) {
      window.clearTimeout(behaviorReviewSavedTimeoutRef.current);
      behaviorReviewSavedTimeoutRef.current = null;
    }
    setSavingBehaviorReviewId(r.eval_result_id);
    setError(null);
    try {
      const res = await fetch(`/api/eval-results/${r.eval_result_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ behavior_review: payload }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        behavior_review?: BehaviorReviewByVersion;
        manually_edited?: boolean;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      setResults((prev) =>
        prev.map((x) =>
          x.eval_result_id === r.eval_result_id
            ? {
                ...x,
                behavior_review: data.behavior_review ?? x.behavior_review,
                manually_edited: data.manually_edited ?? true,
              }
            : x
        )
      );
      setBehaviorReviewDraft((prev) => {
        const next = { ...prev };
        delete next[r.eval_result_id];
        return next;
      });
      setSavedBehaviorReviewId(r.eval_result_id);
      behaviorReviewSavedTimeoutRef.current = window.setTimeout(() => {
        setSavedBehaviorReviewId((cur) => (cur === r.eval_result_id ? null : cur));
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save behavior review");
    } finally {
      setSavingBehaviorReviewId(null);
    }
  }

  function clearBehaviorReview(r: EvalResult) {
    const reviewVersions = (Array.isArray(r.evren_responses) ? r.evren_responses : [])
      .slice(0, 3)
      .map((v) => normalizeVersionEntry(v as AnyVersionEntry));
    if (reviewVersions.length === 0) return;
    const cleared: Record<string, VersionBehaviorReview> = {};
    for (const ver of reviewVersions) {
      cleared[ver.version_id] = emptyVersionBehaviorReview();
    }
    setBehaviorReviewDraft((prev) => ({
      ...prev,
      [r.eval_result_id]: cleared,
    }));
  }

  async function applyAiComparisonEdits(r: EvalResult) {
    if (aiEditingComparisonId !== r.eval_result_id) return;
    const feedback = aiComparisonFeedback.trim();
    if (!feedback) {
      setError("Please enter feedback for the AI edit.");
      return;
    }

    const versions = (r.evren_responses ?? []).slice(0, 3).map((v) => ({
      version_id: v.version_id,
      version_name: v.version_name,
    }));

    setApplyingAiComparison(true);
    setError(null);
    try {
      const res = await fetch(`/api/eval-results/${r.eval_result_id}/ai-edit-comparison`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback,
          current_comparison: r.comparison ?? null,
          version_entries: versions,
          test_case_id: r.test_case_id ?? null,
          expected_state: r.test_cases?.expected_state ?? null,
          expected_behavior: r.test_cases?.expected_behavior ?? null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; comparison?: unknown };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      if (!data.comparison) throw new Error("No comparison returned from AI edit.");

      setResults((prev) =>
        prev.map((x) =>
          x.eval_result_id === r.eval_result_id
            ? { ...x, comparison: data.comparison as EvalResult["comparison"], manually_edited: true }
            : x
        )
      );
      setAiEditingComparisonId(null);
      setAiComparisonFeedback("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply AI comparison edits");
    } finally {
      setApplyingAiComparison(false);
    }
  }

  function deleteSession() {
    if (!confirm("Delete this session? This cannot be undone.")) return;
    setDeleting(true);
    fetch(`/api/sessions/${id}`, { method: "DELETE" })
      .then((res) => {
        if (!res.ok) return res.json().then((d) => { throw new Error(d.error ?? "Delete failed"); });
      })
      .then(() => router.push("/sessions"))
      .catch((e) => setError(e.message))
      .finally(() => setDeleting(false));
  }

  function addVersion() {
    const drafts = versionEntries.map((v) => ({ version_id: v.version_id, version_name: v.version_name }));
    setDraftVersions(drafts);
    const existingLower = new Set(drafts.map((d) => d.version_name.toLowerCase()));
    let nextNum = drafts.length + 1;
    while (existingLower.has(`version ${nextNum}`)) nextNum++;
    setNewVersionLabel(`Version ${nextNum}`);
    setAddVersionRunCount(1);
    setEditingVersionId(null);
    setShowAddVersionModal(true);
  }

  async function confirmAddVersion() {
    if (!session) return;
    const cleanedNewVersionLabel = newVersionLabel.trim() || `Version ${draftVersions.length + 1}`;

    // Save any pending renames before adding version
    const renames = draftVersions
      .filter((d) => {
        const original = versionEntries.find((v) => v.version_id === d.version_id);
        return original && original.version_name !== d.version_name;
      })
      .map((d) => ({ version_id: d.version_id, version_name: d.version_name }));
    if (renames.length > 0) {
      try {
        await fetch(`/api/sessions/${id}/versions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ renames }),
        });
      } catch {
        /* proceed anyway */
      }
    }

    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }

    setAddingVersion(true);
    setAddVersionProgress({ stage: "start", message: "Starting add version…" });
    setAddVersionCounts({
      versionAddedDone: 0,
      versionAddedTotal: 0,
      comparisonDone: 0,
      comparisonTotal: 0,
      comparisonEnabled: runComparison,
    });
    setError(null);

    try {
      const effectiveRunCount = Math.max(1, Math.floor(addVersionRunCount || 1));
      const res = await fetch(`/api/sessions/${id}/add-version/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version_name: cleanedNewVersionLabel,
          evren_flash_model: evrenFlashModel,
          disable_p0: disableP0,
          disable_p1: disableP1,
          run_count: effectiveRunCount,
          run_comparison: runComparison,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No response body");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const chunk of lines) {
          const match = chunk.match(/^data:\s*(.+)/m);
          if (!match) continue;
          try {
            const data = JSON.parse(match[1].trim()) as {
              type: string;
              stage?: string;
              message?: string;
              index?: number;
              total?: number;
              test_case_id?: string;
              error?: string;
              results?: EvalResult[];
            };

            if (data.type === "progress" && data.stage) {
              setAddVersionProgress({
                stage: data.stage,
                message: data.message,
                index: data.index,
                total: data.total,
                test_case_id: data.test_case_id,
              });

              setAddVersionCounts((prev) => {
                const stage = String(data.stage ?? "");
                const total = typeof data.total === "number" ? data.total : undefined;
                const index = typeof data.index === "number" ? data.index : undefined;

                if (stage === "start") {
                  return {
                    versionAddedDone: 0,
                    versionAddedTotal: total ?? prev.versionAddedTotal,
                    comparisonDone: 0,
                    comparisonTotal: total ?? prev.comparisonTotal,
                    comparisonEnabled: prev.comparisonEnabled,
                  };
                }

                if (stage === "done") {
                  return {
                    ...prev,
                    versionAddedDone: Math.max(prev.versionAddedDone, index ?? prev.versionAddedDone),
                    versionAddedTotal: total ?? prev.versionAddedTotal,
                  };
                }

                if (stage === "compared" || stage === "compare_error" || stage === "comparing_skip") {
                  return {
                    ...prev,
                    comparisonDone: Math.max(prev.comparisonDone, index ?? prev.comparisonDone),
                    comparisonTotal: total ?? prev.comparisonTotal,
                  };
                }

                if (stage === "comparing") {
                  return {
                    ...prev,
                    comparisonTotal: total ?? prev.comparisonTotal,
                  };
                }

                return prev;
              });
            } else if (data.type === "complete") {
              const nextResults = Array.isArray(data.results) ? data.results : [];
              setResults(nextResults);
              void fetch(`/api/sessions/${id}`)
                .then((r) => r.json())
                .then((payload) => {
                  if (payload.error) return;
                  const nextSession = payload.session as Session | null;
                  setSession(nextSession);
                  setRunMetadataDraft(validateRunMetadata((nextSession as Record<string, unknown> | null)?.run_metadata));
                  setSessionReviewSummary(mergeSessionReviewSummaryFromSession(nextSession, nextResults));
                })
                .catch(() => {
                  /* keep prior form state */
                });
              void loadSnapshotsList();
              playCompletionSound();
              notifyVersionAdded();
              setAddVersionProgress(null);
              setShowAddVersionModal(false);
              return;
            } else if (data.type === "error" && data.error) {
              throw new Error(data.error);
            }
          } catch (err) {
            if (err instanceof Error) throw err;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add version");
    } finally {
      setAddingVersion(false);
      setAddVersionProgress(null);
      setAddVersionCounts((prev) => ({
        ...prev,
        versionAddedDone: 0,
        versionAddedTotal: 0,
        comparisonDone: 0,
        comparisonTotal: 0,
      }));
    }
  }

  async function saveVersionNamesOnly() {
    const renames = draftVersions
      .filter((d) => {
        const original = versionEntries.find((v) => v.version_id === d.version_id);
        return original && original.version_name !== d.version_name;
      })
      .map((d) => ({ version_id: d.version_id, version_name: d.version_name.trim() || d.version_name }));

    if (renames.length === 0) {
      setShowAddVersionModal(false);
      return;
    }

    setSavingNames(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/versions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ renames }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; results?: EvalResult[] };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      if (Array.isArray(data.results)) setResults(data.results);
      setShowAddVersionModal(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save version names");
    } finally {
      setSavingNames(false);
    }
  }

  async function deleteVersionAt(versionId: string) {
    const version = draftVersions.find((d) => d.version_id === versionId);
    if (!version) return;
    if (draftVersions.length <= 1) {
      setError("At least one version must remain.");
      return;
    }
    if (!confirm(`Delete "${version.version_name}"?`)) return;

    setDeletingVersionId(versionId);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/versions`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version_id: versionId }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; results?: EvalResult[] };
      if (!res.ok || data.error) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const nextResults = Array.isArray(data.results) ? data.results : [];
      setResults(nextResults);
      void loadSnapshotsList();
      setDraftVersions((prev) => prev.filter((d) => d.version_id !== versionId));
      if (editingVersionId === versionId) setEditingVersionId(null);
      const nextEntries = getVersionEntries(nextResults);
      const existingLower = new Set(nextEntries.map((v) => v.version_name.toLowerCase()));
      let nextNum = nextEntries.length + 1;
      while (existingLower.has(`version ${nextNum}`)) nextNum++;
      setNewVersionLabel(`Version ${nextNum}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete version");
    } finally {
      setDeletingVersionId(null);
    }
  }

  function saveSummary() {
    setSavingSummary(true);
    fetch(`/api/sessions/${id}/summary`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setSession((s) => (s ? { ...s, summary, manually_edited: true } : null));
        setEditingSummary(false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setSavingSummary(false));
  }

  async function saveRunMetadata() {
    if (!session) return;
    setSavingRunMetadata(true);
    setSavedRunMetadata(false);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_metadata: runMetadataDraft }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `Request failed (${res.status})`);
      setSession((s) => (s ? { ...s, run_metadata: runMetadataDraft } : null));
      setSavedRunMetadata(true);
      setTimeout(() => setSavedRunMetadata(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save run metadata");
    } finally {
      setSavingRunMetadata(false);
    }
  }

  function saveHeader() {
    const sessionIdTrimmed = editSessionId.trim();
    if (!sessionIdTrimmed) {
      setHeaderError("Session ID cannot be empty");
      return;
    }
    setSavingHeader(true);
    setHeaderError(null);
    fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test_session_id: sessionIdTrimmed, title: editTitle.trim() || null }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setSession((s) =>
          s
            ? { ...s, test_session_id: data.session?.test_session_id ?? sessionIdTrimmed, title: (data.session?.title ?? editTitle.trim()) || null }
            : null
        );
        setEditingHeader(false);
        if (data.redirect_id && data.redirect_id !== id) {
          router.push(`/sessions/${data.redirect_id}`);
        }
      })
      .catch((e) => setHeaderError(e.message))
      .finally(() => setSavingHeader(false));
  }

  function refineWording() {
    setRefiningWording(true);
    setError(null);
    fetch("/api/refine-wording", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        if (typeof data.refined === "string") setSummary(data.refined);
      })
      .catch((e) => setError(e.message))
      .finally(() => setRefiningWording(false));
  }

  async function rerunAllComparisons() {
    if (!id || session?.mode !== "comparison") return;
    setRerunningComparison(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/rerun-comparison`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        compared?: number;
        skipped?: number;
        failures?: { test_case_id?: string; message: string }[];
      };
      if (!res.ok || data.error) throw new Error(data.error ?? "Rerun comparison failed");
      const r2 = await fetch(`/api/sessions/${id}`);
      const d2 = (await r2.json().catch(() => ({}))) as {
        error?: string;
        session?: Session | null;
        models?: SessionModels | null;
        results?: EvalResult[];
      };
      if (!r2.ok || d2.error) throw new Error(d2.error ?? "Failed to reload session");
      const nextSession = d2.session as Session | null;
      const nextModels = (d2.models ?? null) as SessionModels | null;
      const nextResults = (Array.isArray(d2.results) ? d2.results : []) as EvalResult[];
      setSession(nextSession);
      if (nextModels && typeof nextModels === "object") setModels(nextModels);
      setResults(nextResults);
      setSummary(summaryForDisplay(nextSession?.summary ?? ""));
      setRunMetadataDraft(validateRunMetadata((nextSession as Record<string, unknown> | null)?.run_metadata));
      setSessionReviewSummary(mergeSessionReviewSummaryFromSession(nextSession, nextResults));
      if (data.failures?.length) {
        console.warn(
          "[rerun comparison] partial failures:",
          data.failures.map((f) => `${f.test_case_id ?? "?"}: ${f.message}`).join("; ")
        );
      }
      void loadSnapshotsList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rerun comparison failed");
    } finally {
      setRerunningComparison(false);
    }
  }

  function resummarize() {
    setResummarizing(true);
    setError(null);
    fetch(`/api/sessions/${id}/resummarize`, { method: "POST" })
      .then((res) => res.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        const newSummary = typeof data.summary === "string" ? data.summary : "";
        setSummary(summaryForDisplay(newSummary));
        setSession((s) =>
          s
            ? {
                ...s,
                summary: newSummary,
                title: typeof data.title === "string" ? data.title : s.title,
                manually_edited: false,
              }
            : null
        );
        setEditingSummary(true);
      })
      .catch((e) => setError(e.message))
      .finally(() => setResummarizing(false));
  }

  const evaluatedResults = effectiveResults.filter(isResultEvaluated);
  const hasEvaluationResults = evaluatedResults.length > 0;

  const passedTestCasesDisplay = useMemo(() => {
    if (session?.mode === "comparison") {
      const { canonicalId } = buildCanonicalVersionIdMap(effectiveResults);
      const championId =
        comparisonStats.length > 0 ? comparisonStats[0].version_id : versionEntries[0]?.version_id ?? null;
      if (!championId) return { text: "—" as const, title: undefined as string | undefined };
      const canonicalChampion = canonicalId(championId);
      const championName = comparisonStats[0]?.version_name ?? versionEntries[0]?.version_name ?? null;
      const total = effectiveResults.length;
      let passed = 0;
      for (const r of effectiveResults) {
        const v = championPassForComparisonRow(r, canonicalChampion, canonicalId, versionCount);
        if (v === true) passed++;
      }
      if (total === 0) return { text: "—" as const, title: undefined as string | undefined };
      const title = championName
        ? `Best version: ${championName}. Pass = that version is in the top comparison tier with no hard failures in that tier (same idea as the green row badge). Denominator is all ${total} test case(s) in this session. Rows without that version or without comparison data count as not passed.`
        : undefined;
      return { text: `${passed} / ${total}` as const, title };
    }
    const evaluated = effectiveResults.filter(isResultEvaluated);
    if (evaluated.length === 0) return { text: "—" as const, title: undefined as string | undefined };
    return {
      text: `${evaluated.filter((r) => r.success).length} / ${evaluated.length}` as const,
      title: undefined as string | undefined,
    };
  }, [session?.mode, effectiveResults, comparisonStats, versionEntries, versionCount]);

  const evaluatorModelName = models.evaluator_model ?? DEFAULT_EVAL_LLM_MODEL;
  const evaluatorTokensSummary = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    let any = false;
    for (const r of evaluatedResults) {
      if (typeof r.prompt_tokens === "number") {
        prompt += r.prompt_tokens;
        any = true;
      }
      if (typeof r.completion_tokens === "number") {
        completion += r.completion_tokens;
        any = true;
      }
      if (typeof r.total_tokens === "number") {
        total += r.total_tokens;
        any = true;
      }
    }
    return { any, prompt, completion, total };
  }, [evaluatedResults]);
  const evalCostSummary = useMemo(() => {
    if (!evaluatorTokensSummary.any) return null;
    return computeTokenCostParts(evaluatorTokensSummary.prompt, evaluatorTokensSummary.completion, evaluatorModelName);
  }, [evaluatorTokensSummary, evaluatorModelName]);

  const comparisonTokensSummary = useMemo(() => {
    let prompt = 0;
    let completion = 0;
    let total = 0;
    let any = false;
    let costUsd = 0;
    for (const r of effectiveResults) {
      const u = getComparisonTokenUsage(r);
      if (!u) continue;
      any = true;
      prompt += u.prompt;
      completion += u.completion;
      total += u.total;
      costUsd += u.costUsd;
    }
    return { any, prompt, completion, total, costUsd };
  }, [effectiveResults]);
  const comparisonCostSummary = useMemo(() => {
    if (!comparisonTokensSummary.any) return null;
    return computeTokenCostParts(comparisonTokensSummary.prompt, comparisonTokensSummary.completion, evaluatorModelName);
  }, [comparisonTokensSummary, evaluatorModelName]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("maibel_eval_show_comparator_metrics");
      if (raw === "1") setShowComparatorMetrics(true);
      if (raw === "0") setShowComparatorMetrics(false);
    } catch {
      /* ignore */
    }
  }, []);

  function toggleComparatorMetrics() {
    setShowComparatorMetrics((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("maibel_eval_show_comparator_metrics", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const anyMultiRunInSession = evalResultsHaveAnyMultiRun(effectiveResults);
  const anyMultiTurnInSession = evalResultsHaveAnyMultiTurn(effectiveResults);

  const autoRunMode =
    `${anyMultiRunInSession ? "repeated-run" : "single-run"}, ${anyMultiTurnInSession ? "multi-turn" : "single-turn"}`;

  const autoComparisonModel = session?.mode === "comparison" ? evaluatorModelName : null;
  const autoEvaluatorModel = evaluatorModelName;
  const autoSummarizerModel = models.summarizer_model ?? null;
  const autoComparatorModel = autoComparisonModel;

  const runMetadataEnvRaw = String(runMetadataDraft.environment ?? "").trim();
  const runMetadataEnvKnown = RUN_METADATA_ENVIRONMENT_OPTIONS as readonly string[];
  const runMetadataEnvIsKnown = runMetadataEnvKnown.includes(runMetadataEnvRaw);
  const runMetadataEnvSelectValue = runMetadataEnvIsKnown ? runMetadataEnvRaw : runMetadataEnvRaw || "local";
  const runMetadataEnvShowLegacy = Boolean(runMetadataEnvRaw && !runMetadataEnvIsKnown);

  // Keep non-editable fields in run_metadata aligned to session truth.
  useEffect(() => {
    setRunMetadataDraft((prev) => ({
      ...prev,
      run_mode: autoRunMode,
      comparator_model: autoComparatorModel ?? null,
      evaluator_model: autoEvaluatorModel ?? null,
      summarizer_model: autoSummarizerModel ?? null,
    }));
  }, [autoRunMode, autoComparatorModel, autoEvaluatorModel, autoSummarizerModel]);

  if (loading) return <div className="mx-auto max-w-5xl px-4 py-8 text-stone-500">Loading…</div>;
  if (error || !session) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <p className="text-red-600">{error ?? "Not found"}</p>
        <Link href="/sessions" className="mt-2 inline-block text-sm text-stone-500 hover:underline">← Sessions</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/sessions" className="text-sm text-stone-500 hover:text-stone-700">← Sessions</Link>
        <div className="flex flex-wrap items-center gap-2.5">
          {session.mode !== "single" && (
            <div className="relative flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={toggleComparatorMetrics}
                disabled={addingVersion || deleting || isViewingCheckpoint}
                className="inline-flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                title={showComparatorMetrics ? "Hide details" : "Show details"}
                aria-pressed={showComparatorMetrics}
              >
                {showComparatorMetrics ? (
                  <EyeOff className="h-4 w-4 text-stone-600" aria-hidden />
                ) : (
                  <Eye className="h-4 w-4 text-stone-600" aria-hidden />
                )}
                <span className="text-stone-600">{showComparatorMetrics ? "Hide details" : "Show details"}</span>
                <span className="sr-only">{showComparatorMetrics ? "Hide details" : "Show details"}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setHistoryMenuOpen((prev) => {
                    if (!prev) void loadSnapshotsList();
                    return !prev;
                  });
                }}
                aria-expanded={historyMenuOpen}
                aria-haspopup="dialog"
                aria-controls="session-history-popover"
                id="session-history-trigger"
                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                  historyMenuOpen
                    ? "border-amber-400 bg-amber-100 text-amber-950"
                    : "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                }`}
                title="Browse checkpoints (saved before add/delete version)"
              >
                <GitCommitHorizontal className="h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                History
              </button>
              <button
                type="button"
                onClick={addVersion}
                disabled={addingVersion || deleting || isViewingCheckpoint}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                title="Manage versions"
              >
                <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {addingVersion ? "Working…" : "Manage versions"}
              </button>

              {historyMenuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close history"
                    className="fixed inset-0 z-40 cursor-default bg-transparent"
                    onClick={() => setHistoryMenuOpen(false)}
                  />
                  <div
                    id="session-history-popover"
                    role="dialog"
                    aria-labelledby="session-history-popover-title"
                    className="absolute right-0 z-50 mt-1 w-[min(calc(100vw-2rem),22rem)] overflow-hidden rounded-lg border border-stone-200 bg-white shadow-lg ring-1 ring-black/5"
                  >
                    <div className="flex items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-3 py-2">
                      <h2 id="session-history-popover-title" className="text-xs font-semibold uppercase tracking-wide text-stone-600">
                        History
                      </h2>
                      <button
                        type="button"
                        onClick={() => void loadSnapshotsList()}
                        disabled={snapshotsLoading}
                        className="inline-flex items-center gap-1 rounded border border-stone-200 bg-white px-2 py-1 text-[11px] font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
                      >
                        <RefreshCw className={snapshotsLoading ? "h-3 w-3 animate-spin" : "h-3 w-3"} aria-hidden />
                        Refresh
                      </button>
                    </div>
                    {snapshotsError && (
                      <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-xs text-red-800">{snapshotsError}</div>
                    )}
                    <div className="max-h-64 overflow-y-auto">
                      {snapshotsLoading && snapshots.length === 0 ? (
                        <div className="flex items-center gap-2 px-3 py-5 text-sm text-stone-500">
                          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
                          Loading…
                        </div>
                      ) : snapshots.length === 0 ? (
                        <p className="px-3 py-4 text-sm text-stone-600">
                          No checkpoints yet. Add or delete a version to create one.
                        </p>
                      ) : (
                        <ul className="divide-y divide-stone-100">
                          {snapshots.map((s) => {
                            const isSel = s.snapshot_id === activeSnapshotId;
                            const abs = new Date(s.created_at);
                            const timeStr = Number.isNaN(abs.getTime()) ? s.created_at : abs.toLocaleString();
                            return (
                              <li key={s.snapshot_id}>
                                <button
                                  type="button"
                                  onClick={() => void openSnapshot(s)}
                                  className={
                                    isSel
                                      ? "flex w-full items-start gap-3 bg-sky-50/90 px-3 py-2.5 text-left ring-1 ring-inset ring-sky-200/80"
                                      : "flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-stone-50"
                                  }
                                >
                                  <span
                                    className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 ${
                                      isSel ? "border-sky-600 bg-sky-600" : "border-stone-300 bg-white"
                                    }`}
                                    aria-hidden
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                                      <code className="font-mono text-xs text-stone-700">{shortSnapshotId(s.snapshot_id)}</code>
                                      <span className="text-[11px] text-stone-500">
                                        {formatSnapshotRelativeTime(s.created_at) || timeStr}
                                      </span>
                                    </span>
                                    <span className="mt-0.5 block text-left text-sm font-medium text-stone-900">
                                      {s.message ?? snapshotKindPresentation(s.kind).label}
                                    </span>
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={deleteSession}
            disabled={deleting || addingVersion}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            {deleting ? "Deleting…" : "Delete session"}
          </button>
        </div>
      </div>

      <header className="mt-2">
        {!editingHeader ? (
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold text-stone-900">
              {session.test_session_id} · {session.title?.trim() || "Untitled session"}
            </h1>
            <button
              type="button"
              onClick={() => {
                setEditSessionId(session.test_session_id);
                setEditTitle(session.title?.trim() ?? "");
                setHeaderError(null);
                setEditingHeader(true);
              }}
              className={editTriggerClassName}
              title="Edit session ID and title"
            >
              <Pencil className="h-3.5 w-3.5 text-stone-500" strokeWidth={2} aria-hidden />
              Edit
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 gap-y-2">
              <label className="sr-only" htmlFor="edit-session-id">Session ID</label>
              <input
                id="edit-session-id"
                type="text"
                value={editSessionId}
                onChange={(e) => setEditSessionId(e.target.value)}
                placeholder="e.g. ES120"
                className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-lg font-semibold text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
              <span className="text-stone-400 font-medium">·</span>
              <label className="sr-only" htmlFor="edit-session-title">Title</label>
              <input
                id="edit-session-title"
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Session title"
                className="min-w-[200px] flex-1 rounded-lg border border-stone-200 bg-white px-3 py-2 text-lg font-semibold text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
            </div>
            {headerError && (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                {headerError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveHeader}
                disabled={savingHeader}
                className={sessionSaveButtonClass({ working: savingHeader })}
              >
                <Save className="h-3 w-3 shrink-0" aria-hidden />
                {savingHeader ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingHeader(false);
                  setEditSessionId(session.test_session_id);
                  setEditTitle(session.title?.trim() ?? "");
                  setHeaderError(null);
                }}
                className="rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </header>

      {session.mode !== "single" && (
        <>
          {activeSnapshotId && activeSnapshotMeta && (
            <div
              className={`mt-4 flex flex-wrap items-start justify-between gap-3 rounded-md border px-4 py-2.5 text-sm ${
                isViewingCheckpoint
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : "border-stone-200 bg-stone-50 text-stone-700"
              }`}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <GitCommitHorizontal className="h-4 w-4 shrink-0 text-current opacity-70" aria-hidden />
                  <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs font-semibold">
                    {shortSnapshotId(activeSnapshotMeta.snapshot_id)}
                  </code>
                  {editingSnapshotMessage && isViewingCheckpoint ? (
                    <input
                      type="text"
                      value={snapshotMessageDraft}
                      onChange={(e) => setSnapshotMessageDraft(e.target.value)}
                      placeholder={snapshotKindPresentation(activeSnapshotMeta.kind).label}
                      className="min-w-[12rem] max-w-full flex-1 rounded-md border border-amber-400/70 bg-white px-2 py-1 text-sm font-medium text-stone-900 placeholder:text-stone-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
                      aria-label="Snapshot title"
                      disabled={savingSnapshotMessage || deletingSnapshot}
                      autoFocus
                    />
                  ) : (
                    <span className="min-w-0 truncate font-medium">
                      {activeSnapshotMeta.message ?? snapshotKindPresentation(activeSnapshotMeta.kind).label}
                    </span>
                  )}
                </div>
                {!isViewingCheckpoint && (
                  <span className="text-xs opacity-80">Loading checkpoint into the page…</span>
                )}
                {isViewingCheckpoint && (
                  <span className="text-xs text-amber-900/85">
                    Read-only view — same layout as live. Exit to edit or run comparisons again.
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {isViewingCheckpoint && editingSnapshotMessage && (
                  <>
                    <button
                      type="button"
                      onClick={() => void saveSnapshotMessage()}
                      disabled={savingSnapshotMessage || deletingSnapshot}
                      className="inline-flex items-center gap-1 rounded-md border border-amber-600/40 bg-white px-2.5 py-1.5 text-xs font-semibold text-amber-950 hover:bg-amber-100/80 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" aria-hidden />
                      {savingSnapshotMessage ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelRenameSnapshotMessage}
                      disabled={savingSnapshotMessage || deletingSnapshot}
                      className="rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-800 hover:bg-stone-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </>
                )}
                {isViewingCheckpoint && !editingSnapshotMessage && (
                  <>
                    <button
                      type="button"
                      onClick={beginRenameSnapshotMessage}
                      disabled={deletingSnapshot}
                      className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-800 shadow-sm hover:bg-stone-50 disabled:opacity-50"
                      title="Rename snapshot"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteActiveSnapshot()}
                      disabled={deletingSnapshot}
                      className="inline-flex items-center gap-1 rounded-md border border-rose-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-rose-800 hover:bg-rose-50 disabled:opacity-50"
                      title="Delete snapshot from history"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {deletingSnapshot ? "Deleting…" : "Delete"}
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={closeSnapshot}
                  disabled={savingSnapshotMessage}
                  className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-800 shadow-sm hover:bg-stone-50 disabled:opacity-50"
                >
                  Exit
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold tracking-tight text-stone-900">Run metadata</h2>
          <button
            type="button"
            onClick={() => void saveRunMetadata()}
            disabled={savingRunMetadata || isViewingCheckpoint}
            className={sessionSaveButtonClass({ working: savingRunMetadata, saved: savedRunMetadata })}
            title="Save run metadata"
          >
            <Save className="h-3 w-3 shrink-0" aria-hidden />
            {savingRunMetadata ? "Saving…" : savedRunMetadata ? "Saved" : "Save"}
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {session.created_at && (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span><strong className="font-medium text-stone-800">Date:</strong> {formatSessionDate(session.created_at)}</span>
            </div>
          )}
          {session.users && (
            <div className="flex items-center gap-2 text-sm text-stone-700" title={session.users.email}>
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <span><strong className="font-medium text-stone-800">User:</strong> {session.users.full_name?.trim() || session.users.email}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span><strong className="font-medium text-stone-800">Total cost:</strong> {formatUsd(session.total_cost_usd, 6)}</span>
          </div>
          {evaluatorTokensSummary.any && (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
              </svg>
              <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="font-medium text-stone-800">Evaluator tokens:</strong>
                <span className="tabular-nums text-stone-800">in {evaluatorTokensSummary.prompt}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-800">out {evaluatorTokensSummary.completion}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-800">total {evaluatorTokensSummary.total || (evaluatorTokensSummary.prompt + evaluatorTokensSummary.completion)}</span>
              </span>
            </div>
          )}
          {evalCostSummary && (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="font-medium text-stone-800">Evaluator cost:</strong>
                <span className="tabular-nums text-stone-800">{formatUsd(evalCostSummary.total_cost_usd, 6)}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-600">in {formatUsd(evalCostSummary.input_cost_usd, 6)}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-600">out {formatUsd(evalCostSummary.output_cost_usd, 6)}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="text-stone-500">model {evaluatorModelName}</span>
              </span>
            </div>
          )}
          {showComparatorMetrics && session.mode === "comparison" && comparisonTokensSummary.any && (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
              </svg>
              <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="font-medium text-stone-800">Comparator tokens:</strong>
                <span className="tabular-nums text-stone-800">in {comparisonTokensSummary.prompt}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-800">out {comparisonTokensSummary.completion}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-800">total {comparisonTokensSummary.total || (comparisonTokensSummary.prompt + comparisonTokensSummary.completion)}</span>
              </span>
            </div>
          )}
          {showComparatorMetrics && session.mode === "comparison" && comparisonCostSummary && (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="font-medium text-stone-800">Comparator cost:</strong>
                <span className="tabular-nums text-stone-800">{formatUsd(comparisonTokensSummary.costUsd, 6)}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-600">in {formatUsd(comparisonCostSummary.input_cost_usd, 6)}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="tabular-nums text-stone-600">out {formatUsd(comparisonCostSummary.output_cost_usd, 6)}</span>
                <span className="text-stone-300" aria-hidden>·</span>
                <span className="text-stone-500">model {evaluatorModelName}</span>
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span title={passedTestCasesDisplay.title}>
              <strong className="font-medium text-stone-800">
                {session.mode === "comparison" ? "Passed test cases (best ver):" : "Passed test cases:"}
              </strong>{" "}
              {passedTestCasesDisplay.text}
            </span>
          </div>
          {session.mode === "comparison" ? null : (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
              <span>
                <strong className="font-medium text-stone-800">Score:</strong>{" "}
                {hasEvaluationResults ? (evaluatedResults.reduce((s, r) => s + r.score, 0) / evaluatedResults.length).toFixed(2) : "—"}
              </span>
            </div>
          )}
          {(session.total_eval_time_seconds != null && session.total_eval_time_seconds >= 0) && (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span><strong className="font-medium text-stone-800">Time taken:</strong> {formatEvalTime(session.total_eval_time_seconds)}</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Code source:</strong>
            <input
              type="text"
              value={(runMetadataDraft.code_source as string) ?? ""}
              onChange={(e) => setRunMetadataDraft((prev) => ({ ...prev, code_source: e.target.value }))}
              placeholder="git commit, branch, deploy URL"
              className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0 text-sm text-stone-900 placeholder:text-stone-400 hover:border-stone-200 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Test category:</strong>
            <input
              type="text"
              value={(runMetadataDraft.test_category as string) ?? ""}
              onChange={(e) => setRunMetadataDraft((prev) => ({ ...prev, test_category: e.target.value }))}
              placeholder="e.g. P0_Safety, P1_Distress"
              className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0 text-sm text-stone-900 placeholder:text-stone-400 hover:border-stone-200 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Environment:</strong>
            <select
              value={runMetadataEnvSelectValue}
              onChange={(e) =>
                setRunMetadataDraft((prev) => ({ ...prev, environment: e.target.value }))
              }
              className="max-w-[12rem] cursor-pointer rounded-sm border border-stone-300 bg-white py-0 pl-1 pr-6 text-sm font-normal text-stone-900 hover:bg-stone-50 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-stone-400"
              aria-label="Environment"
            >
              {runMetadataEnvShowLegacy ? (
                <option value={runMetadataEnvRaw}>
                  {runMetadataEnvRaw} (legacy)
                </option>
              ) : null}
              {RUN_METADATA_ENVIRONMENT_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Deploy URL:</strong>
            <input
              type="text"
              value={(runMetadataDraft.deploy_url as string) ?? ""}
              onChange={(e) => setRunMetadataDraft((prev) => ({ ...prev, deploy_url: e.target.value }))}
              placeholder="N/A for local"
              className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0 text-sm text-stone-900 placeholder:text-stone-400 hover:border-stone-200 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
            />
          </div>
          {session.mode === "comparison" ? (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12M8 12h8m-8 5h12M4 7h.01M4 12h.01M4 17h.01" />
              </svg>
              <strong className="shrink-0 font-medium text-stone-800">Comparison model:</strong>
              <span className="min-w-0 flex-1 truncate px-1 py-0 text-sm text-stone-900">
                {autoComparisonModel ?? "—"}
              </span>
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">
              {session.mode === "comparison" ? "Dimension review model:" : "Evaluator model:"}
            </strong>
            <span className="min-w-0 flex-1 truncate px-1 py-0 text-sm text-stone-900">
              {autoEvaluatorModel ?? "—"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">
              {session.mode === "comparison" ? "Session summary model:" : "Summarizer model:"}
            </strong>
            <span className="min-w-0 flex-1 truncate px-1 py-0 text-sm text-stone-900">
              {autoSummarizerModel ?? "—"}
            </span>
          </div>
          {session.mode === "comparison" ? null : (
            <div className="flex items-center gap-2 text-sm text-stone-700">
              <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12M8 12h8m-8 5h12M4 7h.01M4 12h.01M4 17h.01" />
              </svg>
              <strong className="shrink-0 font-medium text-stone-800">Comparator model:</strong>
              <span className="min-w-0 flex-1 truncate px-1 py-0 text-sm text-stone-900">
                {autoComparatorModel ?? "—"}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Run mode:</strong>
            <span className="min-w-0 flex-1 truncate px-1 py-0 text-sm text-stone-900">
              {autoRunMode || "—"}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Sample size (runs per case):</strong>
            <input
              type="text"
              value={(runMetadataDraft.sample_size as string) ?? ""}
              onChange={(e) => setRunMetadataDraft((prev) => ({ ...prev, sample_size: e.target.value }))}
              placeholder="e.g. 1 or 3"
              className="min-w-0 flex-1 rounded-sm border border-transparent bg-transparent px-1 py-0 text-sm text-stone-900 placeholder:text-stone-400 hover:border-stone-200 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
            />
          </div>
          <div className="flex items-center gap-2 text-sm text-stone-700">
            <svg className="h-4 w-4 shrink-0 text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            <strong className="shrink-0 font-medium text-stone-800">Repeated-run evidence:</strong>
            <select
              value={
                (String(runMetadataDraft.repeated_runs_evidence ?? "").trim().toLowerCase() === "manual"
                  ? "manual"
                  : anyMultiRunInSession
                    ? "automated"
                    : "none")
              }
              onChange={(e) => {
                const v = e.target.value;
                setRunMetadataDraft((prev) => ({ ...prev, repeated_runs_evidence: v }));
              }}
              className="max-w-[12rem] cursor-pointer rounded-sm border border-stone-300 bg-white py-0 pl-0 pr-6 text-sm font-normal text-stone-900 hover:bg-stone-50 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-stone-400"
              aria-label="Repeated-run evidence"
              title="Automated: at least one version has multiple runs. Manual: you compared runs yourself. None: single run per version."
            >
              <option value="automated" disabled={!anyMultiRunInSession}>
                Automated
              </option>
              <option value="manual">Manual</option>
              <option value="none" disabled={anyMultiRunInSession}>
                None
              </option>
            </select>
          </div>
        </dl>
      </div>

      {session.mode === "comparison" ? (
        showComparatorMetrics ? (
          <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
            <h2 className="text-xl font-semibold tracking-tight text-stone-900">Version comparison table</h2>

            {comparisonStats.length > 0 ? (
              <>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-stone-200 text-left text-xs font-medium uppercase tracking-wide text-stone-400">
                        <th className="pb-2 pr-4">#</th>
                        <th className="pb-2 pr-4">Version</th>
                        <th className="pb-2 pr-4 text-right">Wins</th>
                        <th className="pb-2 pr-4 text-right">Ties</th>
                        <th className="pb-2 pr-4 text-right">Losses</th>
                        <th className="pb-2 text-right">Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonStats.map((v, i) => {
                        const rank =
                          i === 0
                            ? 1
                            : (v.score === comparisonStats[i - 1].score
                                ? comparisonStats.findIndex((s) => s.score === v.score) + 1
                                : i + 1);
                        const isTop = rank === 1;
                        return (
                          <tr
                            key={v.version_id}
                            className={isTop ? "bg-emerald-50/60" : i % 2 === 1 ? "bg-stone-50/40" : ""}
                          >
                            <td className="py-2 pr-4 font-medium text-stone-500">{rank}</td>
                            <td className="py-2 pr-4 font-medium text-stone-900">
                              {isTop && (
                                <span className="mr-1.5" aria-label="Champion">
                                  ★
                                </span>
                              )}
                              {v.version_name}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums text-emerald-700">{v.wins}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-stone-500">{v.ties}</td>
                            <td className="py-2 pr-4 text-right tabular-nums text-red-600">{v.losses}</td>
                            <td className="py-2 text-right tabular-nums font-semibold text-stone-900">{v.score}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-xs text-stone-400">Scoring: Win = 3 pts, Tie = 1 pt, Loss = 0 pts</p>
              </>
            ) : (
              <p className="mt-3 text-sm text-stone-400 italic">
                No comparison data yet. Add a version to start comparing.
              </p>
            )}
          </div>
        ) : null
      ) : (
        <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-stone-900">Session summary</h2>
            {!editingSummary && (
              <button
                type="button"
                onClick={() => {
                  setSummary(summaryForDisplay(session?.summary ?? ""));
                  setEditingSummary(true);
                }}
                className={editTriggerClassName}
                title="Edit summary"
              >
                <Pencil className="h-3.5 w-3.5 text-stone-500" strokeWidth={2} aria-hidden />
                Edit
              </button>
            )}
          </div>
          {editingSummary ? (
            <>
              <div className="mt-1.5">
                <SummaryEditor
                  value={summary}
                  onChange={setSummary}
                  placeholder="Optional summary or analysis of this run."
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={saveSummary}
                  disabled={savingSummary}
                  className={sessionSaveButtonClass({ working: savingSummary })}
                >
                  <Save className="h-3 w-3 shrink-0" aria-hidden />
                  {savingSummary ? "Saving…" : "Save summary"}
                </button>
                <button
                  type="button"
                  onClick={resummarize}
                  disabled={resummarizing}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-100 hover:border-emerald-400 disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                  {resummarizing ? "Resummarizing…" : "Resummarize"}
                </button>
                <button
                  type="button"
                  onClick={refineWording}
                  disabled={refiningWording}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-700 hover:bg-violet-100 hover:border-violet-400 disabled:opacity-50"
                >
                  <Pencil className="h-4 w-4 shrink-0" aria-hidden />
                  {refiningWording ? "Refining…" : "Refine wording"}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditingSummary(false); setSummary(summaryForDisplay(session?.summary ?? "")); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
                >
                  <X className="h-4 w-4 shrink-0" aria-hidden />
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <div className="mt-3 min-h-[4rem] text-sm text-stone-700 prose prose-stone prose-sm max-w-none
              [&_h1]:text-base [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:text-stone-900 [&_h1]:mt-0 [&_h1]:mb-1 [&_h1]:pb-2 [&_h1]:border-b [&_h1]:border-stone-200
              [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-stone-900 [&_h2]:mt-5 [&_h2]:mb-1.5 [&_h2]:first:mt-0
              [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-stone-800 [&_h3]:mt-3 [&_h3]:mb-1
              [&_p]:mt-1 [&_p]:text-sm [&_p]:leading-relaxed
              [&_ul]:mt-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-0.5 [&_ul]:text-sm
              [&_ol]:mt-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:space-y-0.5 [&_ol]:text-sm
              [&_strong]:font-semibold [&_strong]:text-stone-800 [&_strong]:text-sm
              [&_code]:font-mono [&_code]:text-sm [&_code]:bg-stone-100 [&_code]:px-1 [&_code]:rounded [&_code]:text-stone-800
              [&_hr]:my-4 [&_hr]:border-stone-200">
              {summary.trim() ? (
                <ReactMarkdown>{summary}</ReactMarkdown>
              ) : (
                <p className="text-stone-400 italic">No summary for this session.</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-6 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-stone-900">Session review summary</h2>
            {sessionReviewSummaryStale && (
              <span
                className="inline-flex items-center rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20"
                title="Version comparison data changed. Use AI resummarize to regenerate, or Save to confirm your manual update matches the latest comparisons."
              >
                Outdated (comparisons changed)
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { void resummarizeSessionReviewSummary(); }}
              disabled={resummarizingSessionReviewSummary || isViewingCheckpoint}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 hover:border-emerald-400 disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {resummarizingSessionReviewSummary ? "Resummarizing…" : "AI resummarize"}
            </button>
            <button
              type="button"
              onClick={() => { void saveSessionReviewSummary(); }}
              disabled={savingSessionReviewSummary || isViewingCheckpoint}
              className={sessionSaveButtonClass({
                working: savingSessionReviewSummary,
                saved: savedSessionReviewSummary,
              })}
            >
              <Save className="h-3 w-3 shrink-0" aria-hidden />
              {savingSessionReviewSummary ? "Saving…" : savedSessionReviewSummary ? "Saved" : "Save"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Goal</label>
              <textarea
                rows={2}
                readOnly={isViewingCheckpoint}
                value={displaySessionReviewSummary.goal ?? ""}
                onChange={(e) => setSessionReviewSummary((p) => ({ ...p, goal: e.target.value.trim() ? e.target.value : null }))}
                placeholder="What was this session trying to validate?"
                className={`mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm leading-relaxed focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 ${
                  isViewingCheckpoint ? "cursor-default bg-stone-50 text-stone-800" : "bg-white text-stone-900"
                }`}
              />
            </div>

            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Cases / versions tested</label>
              <input
                type="text"
                readOnly={isViewingCheckpoint}
                value={displaySessionReviewSummary.cases_versions_tested ?? ""}
                onChange={(e) => setSessionReviewSummary((p) => ({ ...p, cases_versions_tested: e.target.value.trim() ? e.target.value : null }))}
                placeholder="e.g. 24 cases; versions: v1, v2"
                className={`mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 ${
                  isViewingCheckpoint ? "cursor-default bg-stone-50 text-stone-800" : "bg-white text-stone-900"
                }`}
              />
            </div>

            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Pass/fail summary</label>
              <input
                type="text"
                readOnly={isViewingCheckpoint}
                value={displaySessionReviewSummary.pass_fail_summary ?? ""}
                onChange={(e) => setSessionReviewSummary((p) => ({ ...p, pass_fail_summary: e.target.value.trim() ? e.target.value : null }))}
                placeholder="e.g. 18 / 24 passed"
                className={`mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 ${
                  isViewingCheckpoint ? "cursor-default bg-stone-50 text-stone-800" : "bg-white text-stone-900"
                }`}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Overall finding</label>
                <select
                  disabled={isViewingCheckpoint}
                  value={displaySessionReviewSummary.overall_finding ?? ""}
                  onChange={(e) => {
                    const v = e.target.value as SessionOverallFinding | "";
                    setSessionReviewSummary((p) => ({ ...p, overall_finding: v === "deterministic" || v === "likely_variable" || v === "unclear" ? v : null }));
                  }}
                  className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:cursor-not-allowed disabled:bg-stone-50"
                >
                  <option value="">—</option>
                  <option value="deterministic">Deterministic</option>
                  <option value="likely_variable">Likely variable</option>
                  <option value="unclear">Unclear</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Trust severity</label>
                <select
                  disabled={isViewingCheckpoint}
                  value={displaySessionReviewSummary.trust_severity ?? ""}
                  onChange={(e) => {
                    const v = e.target.value as SessionTrustSeverity | "";
                    setSessionReviewSummary((p) => ({ ...p, trust_severity: v === "high" || v === "medium" || v === "low" ? v : null }));
                  }}
                  className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:cursor-not-allowed disabled:bg-stone-50"
                >
                  <option value="">—</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Recommendation</label>
                <select
                  disabled={isViewingCheckpoint}
                  value={displaySessionReviewSummary.recommendation ?? ""}
                  onChange={(e) => {
                    const v = e.target.value as SessionRecommendation | "";
                    setSessionReviewSummary((p) => ({ ...p, recommendation: v === "ship" || v === "hold" || v === "investigate" ? v : null }));
                  }}
                  className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 disabled:cursor-not-allowed disabled:bg-stone-50"
                >
                  <option value="">—</option>
                  <option value="ship">Ship</option>
                  <option value="hold">Hold</option>
                  <option value="investigate">Investigate</option>
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-stone-400">What still needs confirmation</label>
              <textarea
                rows={4}
                readOnly={isViewingCheckpoint}
                value={displaySessionReviewSummary.needs_confirmation ?? ""}
                onChange={(e) => setSessionReviewSummary((p) => ({ ...p, needs_confirmation: e.target.value.trim() ? e.target.value : null }))}
                placeholder="What would you rerun / double-check to be confident?"
                className={`mt-1 block w-full rounded-lg border border-stone-200 px-3 py-2 text-sm leading-relaxed focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 ${
                  isViewingCheckpoint ? "cursor-default bg-stone-50 text-stone-800" : "bg-white text-stone-900"
                }`}
              />
            </div>
          </div>

          <div className="space-y-3 lg:col-span-1">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-stone-400">Top failure themes</label>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SESSION_REVIEW_FAILURE_TAXONOMY.map((t) => {
                  const checked = displaySessionReviewSummary.top_failure_themes.includes(t.key);
                  return (
                    <label
                      key={t.key}
                      className="flex items-start gap-2 rounded-lg border border-stone-200 bg-stone-50/40 px-3 py-2 text-sm text-stone-800"
                    >
                      <input
                        type="checkbox"
                        disabled={isViewingCheckpoint}
                        checked={checked}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setSessionReviewSummary((p) => {
                            const cur = new Set<SessionReviewFailureThemeKey>(p.top_failure_themes);
                            if (next) cur.add(t.key);
                            else cur.delete(t.key);
                            return { ...p, top_failure_themes: Array.from(cur) };
                          });
                        }}
                        className="mt-0.5 h-4 w-4 rounded border-stone-300 text-stone-900 focus:ring-stone-400"
                      />
                      <span className="leading-snug">{t.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {error}
        </div>
      )}

      {showAddVersionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="add-version-dialog-title">
          <div className="fixed inset-0 bg-stone-900/50" aria-hidden onClick={() => { if (!addingVersion) setShowAddVersionModal(false); }} />
          <div className="relative z-10 w-full max-w-lg rounded-xl border border-stone-200 bg-white p-6 shadow-xl">
            <h2 id="add-version-dialog-title" className="text-lg font-semibold text-stone-900">Manage versions</h2>
            <p className="mt-2 text-sm text-stone-600">
              Rename existing versions and set a name for the new version before rerunning Evren.
            </p>

            <div className="mt-4 space-y-3">
              {draftVersions.map((draft, idx) => (
                <div key={draft.version_id}>
                  <label className="block text-xs font-medium uppercase tracking-wide text-stone-400">
                    Existing version {idx + 1}
                  </label>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="text"
                      value={draft.version_name}
                      disabled={editingVersionId !== draft.version_id}
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraftVersions((prev) => prev.map((d) => d.version_id === draft.version_id ? { ...d, version_name: value } : d));
                      }}
                      className={`block w-full rounded-lg border px-3 py-2 text-sm focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400 ${
                        editingVersionId === draft.version_id
                          ? "border-stone-200 bg-white text-stone-900"
                          : "border-stone-200 bg-stone-50 text-stone-600"
                      }`}
                    />
                    <button
                      type="button"
                      disabled={addingVersion || deletingVersionId != null || isViewingCheckpoint}
                      onClick={() => {
                        if (editingVersionId === draft.version_id) {
                          const trimmed = draft.version_name.trim();
                          setDraftVersions((prev) =>
                            prev.map((d) => d.version_id === draft.version_id ? { ...d, version_name: trimmed || `Version ${idx + 1}` } : d)
                          );
                          setEditingVersionId(null);
                        } else {
                          setEditingVersionId(draft.version_id);
                        }
                      }}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                      title={editingVersionId === draft.version_id ? "Save version name" : "Edit version name"}
                    >
                      {editingVersionId === draft.version_id ? (
                        <Check className="h-4 w-4" aria-hidden />
                      ) : (
                        <Pencil className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={addingVersion || deletingVersionId != null || draftVersions.length <= 1 || isViewingCheckpoint}
                      onClick={() => deleteVersionAt(draft.version_id)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50"
                      title="Delete version"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                </div>
              ))}
              {versionCount < 3 && (
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide text-stone-400">New version name</label>
                  <input
                    type="text"
                    value={newVersionLabel}
                    onChange={(e) => setNewVersionLabel(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-stone-400">Runs for new version</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={addVersionRunCount}
                  onChange={(e) => setAddVersionRunCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                  className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                />
              </div>
              <EvrenModelSelect value={evrenFlashModel} onChange={setEvrenFlashModel} disabled={addingVersion} />
              <EvrenRouteToggles disableP0={disableP0} disableP1={disableP1} onP0Change={setDisableP0} onP1Change={setDisableP1} disabled={addingVersion} />
              <div className="flex items-center justify-between pt-1">
                <div>
                  <p className="text-sm font-medium text-stone-700">Run comparison</p>
                  <p className="text-xs text-stone-500">Compare new version against current champion</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={runComparison}
                  onClick={() => setRunComparison((prev) => !prev)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
                    runComparison ? "bg-emerald-500" : "bg-stone-300"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition ${
                      runComparison ? "translate-x-5" : "translate-x-0.5"
                    }`}
                    aria-hidden
                  />
                </button>
              </div>
            </div>

            {addingVersion && addVersionProgress && (
              <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
                <div className="font-medium text-stone-800">
                  {(() => {
                    const stage = String(addVersionProgress.stage ?? "");
                    const isComparingStage =
                      stage === "comparing" ||
                      stage === "compared" ||
                      stage === "comparing_skip" ||
                      stage === "compare_error";
                    if (isComparingStage) return "Comparing versions";
                    return "Adding version";
                  })()}
                </div>
                <div className="mt-1 text-stone-600">
                  {addVersionCounts.versionAddedTotal > 0 && (
                    <span>
                      Version added {Math.min(addVersionCounts.versionAddedDone, addVersionCounts.versionAddedTotal)} of{" "}
                      {addVersionCounts.versionAddedTotal}
                    </span>
                  )}
                  {addVersionCounts.comparisonEnabled && addVersionCounts.comparisonTotal > 0 && (
                    <span className={addVersionCounts.versionAddedTotal > 0 ? " ml-2" : ""}>
                      / Comparison done {Math.min(addVersionCounts.comparisonDone, addVersionCounts.comparisonTotal)} of{" "}
                      {addVersionCounts.comparisonTotal}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowAddVersionModal(false)}
                disabled={addingVersion || isViewingCheckpoint}
                className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                <X className="h-4 w-4 shrink-0" aria-hidden />
                Cancel
              </button>
              <button
                type="button"
                onClick={saveVersionNamesOnly}
                disabled={addingVersion || savingNames || isViewingCheckpoint}
                className={sessionSaveButtonClass({ working: savingNames })}
              >
                <Save className="h-3 w-3 shrink-0" aria-hidden />
                {savingNames ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={confirmAddVersion}
                disabled={addingVersion || versionCount >= 3 || isViewingCheckpoint}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden />
                {addingVersion ? "Adding…" : "Add version"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mt-8">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="relative flex-1 min-w-[180px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" aria-hidden>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by test case ID or title…"
              className="block w-full rounded-lg border border-stone-200 bg-stone-50/50 py-2 pl-9 pr-3 text-sm text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
            />
          </div>
          <select
            value={passFailFilter}
            onChange={(e) => setPassFailFilter((e.target.value || "") as "" | "pass" | "fail")}
            className="rounded-lg border border-stone-200 bg-stone-50/50 px-3 py-2 text-sm text-stone-700 focus:border-stone-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
          >
            <option value="">All</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter((e.target.value || "") as "" | "single_turn" | "multi_turn")}
            className="rounded-lg border border-stone-200 bg-stone-50/50 px-3 py-2 text-sm text-stone-700 focus:border-stone-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
            title="Filter by test case type"
          >
            <option value="">All types</option>
            <option value="single_turn">Single turn</option>
            <option value="multi_turn">Multi turn</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy((e.target.value || "id") as "id" | "score")}
            className="rounded-lg border border-stone-200 bg-stone-50/50 px-3 py-2 text-sm text-stone-700 focus:border-stone-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-stone-400"
            title="Sort results"
          >
            <option value="id">Sort by ID</option>
            <option value="score">Sort by score</option>
          </select>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-stone-900">Results ({filteredResults.length})</h2>
          {session?.mode === "comparison" && (
            <button
              type="button"
              onClick={() => void rerunAllComparisons()}
              disabled={loading || rerunningComparison || isViewingCheckpoint || !id}
              title="For each row with 2–3 Evren versions: run the comparator model again (tiers + reasons + hard failures), then refresh AI dimension reviews for those versions—the same logic as after Add version with comparison on."
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 shadow-sm hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 shrink-0 ${rerunningComparison ? "animate-spin" : ""}`} aria-hidden />
              {rerunningComparison ? "Rerunning…" : "Rerun comparison"}
            </button>
          )}
        </div>
      </div>
      <ul className="mt-3 space-y-3">
        {filteredResults.length === 0 ? (
          <li className="rounded-xl border border-stone-200 bg-white py-8 text-center text-sm text-stone-500">
            No results match your search or filter.
          </li>
        ) : (
        filteredResults.map((r) => {
          const isExpanded = expandedResultId === r.eval_result_id;
          const isEvaluated = isResultEvaluated(r);
          const usage = isEvaluated && typeof r.prompt_tokens === "number" && typeof r.completion_tokens === "number"
            ? computeTokenCostParts(r.prompt_tokens, r.completion_tokens, evaluatorModelName)
            : null;
          const compUsageRaw = getComparisonTokenUsage(r);
          const compUsage = compUsageRaw
            ? computeTokenCostParts(compUsageRaw.prompt, compUsageRaw.completion, evaluatorModelName)
            : null;
          return (
          <li key={r.eval_result_id} className="rounded-xl border border-stone-200 bg-white shadow-sm">
            <div
              role="button"
              tabIndex={0}
              onClick={() => setExpandedResultId((prev) => (prev === r.eval_result_id ? null : r.eval_result_id))}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedResultId((prev) => (prev === r.eval_result_id ? null : r.eval_result_id)); } }}
              className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 cursor-pointer hover:bg-stone-50/50 transition"
              aria-expanded={isExpanded}
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className={`shrink-0 text-stone-400 transition-transform ${isExpanded ? "rotate-90" : ""}`} aria-hidden>
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </span>
                <span className="font-mono text-base font-semibold text-stone-900">
                  {r.test_case_id}
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs font-medium ${r.test_cases?.type === "multi_turn" ? "bg-violet-100 text-violet-800" : "bg-stone-100 text-stone-600"}`}>
                    {r.test_cases?.type === "multi_turn" ? "Multi" : "Single"}
                  </span>
                  {r.test_cases?.title?.trim() && (
                    <span className="ml-2 font-sans font-normal text-stone-600">· {r.test_cases.title.trim()}</span>
                  )}
                </span>
                <span className="text-stone-300" aria-hidden>|</span>
                {editingReasonId === r.eval_result_id ? (
                  <>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      value={editScore}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditScore(Number(e.target.value))}
                      className="w-16 rounded-lg border border-stone-200 px-2 py-1.5 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                    />
                    <select
                      value={editSuccess ? "pass" : "fail"}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditSuccess(e.target.value === "pass")}
                      className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                    >
                      <option value="pass">Pass</option>
                      <option value="fail">Fail</option>
                    </select>
                  </>
                ) : (
                  <>
                    {isEvaluated ? (
                      <>
                        <span className="text-sm font-medium text-stone-700">Score: {r.score}</span>
                        <span className={`rounded-md px-2.5 py-0.5 text-xs font-medium ${r.success ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}`}>
                          {r.success ? "Pass" : "Fail"}
                        </span>
                      </>
                    ) : (() => {
                      const tiers = r.comparison?.tiers;
                      if (!tiers || tiers.length === 0 || !Array.isArray(tiers[0]) || tiers[0].length === 0) {
                        return (
                          <span className="rounded-md bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
                            Not evaluated
                          </span>
                        );
                      }
                      
                      const overallHardFailuresById = r.comparison?.overall_hard_failures ?? null;
                      const rowCanon = buildCanonicalVersionIdMapForRow(r);

                      const hasHardFailures = (versionId: string): boolean => {
                        const target = rowCanon(versionId);
                        if (!overallHardFailuresById) return false;
                        for (const [k, list] of Object.entries(overallHardFailuresById)) {
                          if (rowCanon(k) !== target) continue;
                          if (Array.isArray(list) && list.length > 0) return true;
                        }
                        return false;
                      };

                      const topIds = new Set<string>((tiers[0] ?? []).map(String));

                      // Sort the IDs so they appear in the same order as the versions (e.g., Version 1 & Version 2)
                      const rowVersionEntries = r.evren_responses ?? [];
                      const topNames = Array.from(topIds)
                        .map((id) => {
                          const cid = rowCanon(id);
                          const idx = rowVersionEntries.findIndex((v) => rowCanon(v.version_id) === cid);
                          const rawName = idx >= 0 ? rowVersionEntries[idx]?.version_name : null;
                          const name =
                            (typeof rawName === "string" && rawName.trim()) ||
                            (idx >= 0 ? `Version ${idx + 1}` : getVersionLabel(id));
                          return { name, idx: idx >= 0 ? idx : 999 };
                        })
                        .sort((a, b) => a.idx - b.idx)
                        .map((item) => item.name);

                      const anyFailedTop = Array.from(topIds).some((id) => hasHardFailures(id));

                      return topNames.length > 0 ? (
                        <span
                          className={`rounded-md px-2.5 py-0.5 text-xs font-medium ${
                            anyFailedTop ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"
                          }`}
                        >
                          {topNames.join(" & ")}
                        </span>
                      ) : (
                        <span className="rounded-md bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
                          Not evaluated
                        </span>
                      );
                    })()}
                  </>
                )}
              </div>
              <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                {editingReasonId === r.eval_result_id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => saveResultEdits(r)}
                      disabled={savingReason}
                      className={sessionSaveButtonClass({ working: savingReason })}
                    >
                      <Save className="h-3 w-3 shrink-0" aria-hidden />
                      {savingReason ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingReasonId(null); setEditReason(""); }}
                      className="rounded-lg border border-stone-200 px-4 py-2 text-sm font-medium text-stone-600 hover:bg-stone-50"
                    >
                      Cancel
                    </button>
                  </>
                ) : isEvaluated ? (
                  <button
                    type="button"
                    disabled={isViewingCheckpoint}
                    onClick={() => {
                      setExpandedResultId(r.eval_result_id);
                      setEditingReasonId(r.eval_result_id);
                      setEditReason(r.reason ?? "");
                      setEditScore(r.score);
                      setEditSuccess(r.success);
                    }}
                    className={editTriggerClassName}
                    title="Edit analysis"
                  >
                    <Pencil className="h-3.5 w-3.5 text-stone-500" strokeWidth={2} aria-hidden />
                    Edit
                  </button>
                ) : null}
              </div>
            </div>
            {isExpanded && (
            <div className="border-t border-stone-100 p-4 space-y-4">
              {(session.mode !== "comparison" || showComparatorMetrics) && isEvaluated && (
                <div className="rounded-lg border border-stone-200 bg-stone-50/40 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Tokens & cost</p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-stone-700">
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">In:</strong> {r.prompt_tokens ?? "—"}</span>
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">Out:</strong> {r.completion_tokens ?? "—"}</span>
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">Total:</strong> {r.total_tokens ?? (typeof r.prompt_tokens === "number" && typeof r.completion_tokens === "number" ? r.prompt_tokens + r.completion_tokens : "—")}</span>
                    <span className="text-stone-300" aria-hidden>|</span>
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">Cost:</strong> {formatUsd(r.cost_usd, 6)}</span>
                    {usage && (
                      <>
                        <span className="tabular-nums text-stone-600">in {formatUsd(usage.input_cost_usd, 6)}</span>
                        <span className="tabular-nums text-stone-600">out {formatUsd(usage.output_cost_usd, 6)}</span>
                        <span className="text-stone-500">model {evaluatorModelName}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
              {(session.mode !== "comparison" || showComparatorMetrics) && !isEvaluated && compUsageRaw && (
                <div className="rounded-lg border border-stone-200 bg-stone-50/40 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Tokens & cost</p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-stone-700">
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">In:</strong> {compUsageRaw.prompt}</span>
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">Out:</strong> {compUsageRaw.completion}</span>
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">Total:</strong> {compUsageRaw.total}</span>
                    <span className="text-stone-300" aria-hidden>|</span>
                    <span className="tabular-nums"><strong className="font-medium text-stone-800">Cost:</strong> {formatUsd(compUsageRaw.costUsd, 6)}</span>
                    {compUsage && (
                      <>
                        <span className="tabular-nums text-stone-600">in {formatUsd(compUsage.input_cost_usd, 6)}</span>
                        <span className="tabular-nums text-stone-600">out {formatUsd(compUsage.output_cost_usd, 6)}</span>
                        <span className="text-stone-500">model {evaluatorModelName}</span>
                      </>
                    )}
                  </div>
                </div>
              )}
              {r.test_cases && (
                <>
                  {/* Conversation: input / evren pairs */}
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Conversation</p>
                    <div className="mt-2 space-y-3">
                      {(() => {
                        const allVersions = Array.isArray(r.evren_responses)
                          ? (r.evren_responses as AnyVersionEntry[]).map(normalizeVersionEntry)
                          : [];
                        const versions = allVersions.slice(0, 3);
                        const turnCount = getTurnCount(versions);
                        const runsExpanded = expandedRunsKeys.has(r.eval_result_id);
                        const totalRunCount = Math.max(0, ...versions.map((v) => v.runs.length));
                        const versionMeta = versions.map((v) => `${v.version_name}: ${v.run_count_requested} run${v.run_count_requested === 1 ? "" : "s"} (${v.evidence_source})${v.eval_config ? ` · ${v.eval_config.flash_model} · P0 ${v.eval_config.disable_p0 ? "disabled" : "enabled"} / P1 ${v.eval_config.disable_p1 ? "disabled" : "enabled"}` : ""}`).join(" · ");
                        if (turnCount === 0 && versions.length === 0) {
                          return (
                            <div className="space-y-2">
                              <div>
                                <p className="text-xs font-medium text-stone-500">input:</p>
                                <p className="mt-0.5 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">
                                  {r.test_cases?.type === "multi_turn" && r.test_cases?.turns?.[0] != null
                                    ? (r.test_cases.turns[0]?.trim() || "—")
                                    : (typeof r.test_cases?.input_message === "string" ? r.test_cases.input_message : "—")}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-stone-500">evren:</p>
                                <p className="mt-0.5 text-sm text-stone-700 leading-relaxed">—</p>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <>
                            {versionMeta && (
                              <p className="text-[11px] text-stone-500">{versionMeta}</p>
                            )}
                            {totalRunCount > 1 && (
                              <div className={versionMeta ? "mt-2" : ""}>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedRunsKeys((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(r.eval_result_id)) next.delete(r.eval_result_id);
                                      else next.add(r.eval_result_id);
                                      return next;
                                    });
                                  }}
                                  className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100"
                                >
                                  <span className={`shrink-0 transition-transform ${runsExpanded ? "rotate-90" : ""}`} aria-hidden>▶</span>
                                  {runsExpanded ? "Collapse runs" : `Show all ${totalRunCount} runs`}
                                </button>
                              </div>
                            )}
                            {Array.from({ length: turnCount }, (_, i) => {
                          const flagsKey = `${r.eval_result_id}-${i}`;
                          const flagsExpanded = expandedFlagsKeys.has(flagsKey);
                          const routeTraceExpanded = expandedRouteTraceKeys.has(flagsKey);
                          const hasFlags = versions.some((v) =>
                            v.runs.some((run) => run.turns[i]?.detected_flags?.trim())
                          );
                          const hasRouteTrace = versions.some((v) =>
                            v.runs.some((run) => turnHasRouteTrace(run.turns[i]?.route_trace))
                          );
                          const singleVersion = versions.length <= 1;
                          const singleRuns = versions[0]?.runs ?? [];
                          const singleRunsCollapsed = singleRuns.filter((run) => run.run_index === 1);
                          const displaySingleRuns = runsExpanded
                            ? singleRuns
                            : (singleRunsCollapsed.length > 0 ? singleRunsCollapsed : singleRuns.slice(0, 1));
                              return (
                            <div key={i} className="space-y-2">
                              <div>
                                <p className="text-xs font-medium text-stone-500">input:</p>
                                <p className="mt-0.5 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">
                                  {r.test_cases?.type === "multi_turn" && Array.isArray(r.test_cases?.turns) && r.test_cases.turns[i] != null
                                    ? (r.test_cases.turns[i]?.trim() || "—")
                                    : (typeof r.test_cases?.input_message === "string" ? r.test_cases.input_message : "—")}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-stone-500">evren:</p>
                                {singleVersion ? (
                                  <div className="mt-1 space-y-3">
                                    {displaySingleRuns.map((run) => {
                                      const turnData = run.turns[i];
                                      const bubbles = turnData?.response ?? [];
                                      return (
                                        <div key={run.run_id} className="rounded-lg border border-stone-200 bg-stone-50/80 px-3 py-2">
                                          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                            Run {run.run_index}
                                          </p>
                                          <EvrenTurnMetrics metrics={turnData?.metrics} />
                                          <div className="mt-1 space-y-2">
                                            {bubbles.length > 0 ? (
                                              bubbles.map((bubble, j) => (
                                                <blockquote
                                                  key={j}
                                                  className="border-l-2 border-stone-300 bg-white/80 pl-3 py-1.5 pr-2 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap rounded-r"
                                                >
                                                  {bubble?.trim() || "—"}
                                                </blockquote>
                                              ))
                                            ) : (
                                              <blockquote className="border-l-2 border-stone-300 bg-white/80 pl-3 py-1.5 pr-2 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap rounded-r">
                                                —
                                              </blockquote>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div className="mt-1 flex gap-2 overflow-x-auto flex-nowrap">
                                    {versions.map((ver) => {
                                      return (
                                        <div
                                          key={ver.version_id}
                                          className="flex-1 min-w-0 rounded-lg border border-stone-200 bg-stone-50/80 px-3 py-2"
                                        >
                                          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                            {ver.version_name}
                                          </p>
                                          <p className="mt-1 text-[11px] text-stone-500">
                                            Runs: {ver.run_count_requested} · Evidence: {ver.evidence_source}
                                          </p>
                                          <div className="mt-2 space-y-3">
                                            {(() => {
                                              const collapsedRuns = ver.runs.filter((run) => run.run_index === 1);
                                              const displayRuns = runsExpanded
                                                ? ver.runs
                                                : (collapsedRuns.length > 0 ? collapsedRuns : ver.runs.slice(0, 1));
                                              return displayRuns.map((run) => {
                                              const turnData = run.turns[i];
                                              const bubbles = turnData?.response ?? [];
                                              return (
                                                <div key={run.run_id}>
                                                  <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                    Run {run.run_index}
                                                  </p>
                                                  <EvrenTurnMetrics metrics={turnData?.metrics} />
                                                  <div className="mt-1 space-y-2">
                                                    {bubbles.length > 0 ? (
                                                      bubbles.map((bubble, bubbleIdx) => (
                                                        <blockquote
                                                          key={bubbleIdx}
                                                          className="border-l-2 border-stone-300 bg-white/80 pl-3 py-1.5 pr-2 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap rounded-r"
                                                        >
                                                          {bubble?.trim() || "—"}
                                                        </blockquote>
                                                      ))
                                                    ) : (
                                                      <blockquote className="border-l-2 border-stone-300 bg-white/80 pl-3 py-1.5 pr-2 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap rounded-r">
                                                        —
                                                      </blockquote>
                                                    )}
                                                  </div>
                                                </div>
                                              );
                                              });
                                            })()}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                                {hasFlags && (
                                  <div className="mt-2">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setExpandedFlagsKeys((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(flagsKey)) next.delete(flagsKey);
                                          else next.add(flagsKey);
                                          return next;
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100"
                                    >
                                      <span className={`shrink-0 transition-transform ${flagsExpanded ? "rotate-90" : ""}`} aria-hidden>▶</span>
                                      Detected flags
                                    </button>
                                    {flagsExpanded && (
                                      <div className="mt-2">
                                        {singleVersion ? (
                                          <div className="space-y-2">
                                            {displaySingleRuns.map((run) => (
                                              <div key={run.run_id} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
                                                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                  Run {run.run_index}
                                                </p>
                                                <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-stone-700 font-mono">
                                                  {prettyDetectedFlags(run.turns[i]?.detected_flags ?? "")}
                                                </pre>
                                              </div>
                                            ))}
                                          </div>
                                        ) : (
                                          <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
                                            {versions.map((ver) => (
                                              <div
                                                key={ver.version_id}
                                                className="flex-1 min-w-[260px] rounded-lg border border-stone-200 bg-white px-3 py-2"
                                              >
                                                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                  {ver.version_name}
                                                </p>
                                                <div className="mt-1 space-y-2">
                                                  {(() => {
                                                    const collapsedRuns = ver.runs.filter((run) => run.run_index === 1);
                                                    const displayRuns = runsExpanded
                                                      ? ver.runs
                                                      : (collapsedRuns.length > 0 ? collapsedRuns : ver.runs.slice(0, 1));
                                                    return displayRuns.map((run) => (
                                                      <div key={run.run_id}>
                                                        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                          Run {run.run_index}
                                                        </p>
                                                        <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-stone-700 font-mono">
                                                          {prettyDetectedFlags(run.turns[i]?.detected_flags ?? "")}
                                                        </pre>
                                                      </div>
                                                    ));
                                                  })()}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {hasRouteTrace && (
                                  <div className="mt-2">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setExpandedRouteTraceKeys((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(flagsKey)) next.delete(flagsKey);
                                          else next.add(flagsKey);
                                          return next;
                                        });
                                      }}
                                      className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-medium text-stone-600 hover:bg-stone-100"
                                    >
                                      <span className={`shrink-0 transition-transform ${routeTraceExpanded ? "rotate-90" : ""}`} aria-hidden>▶</span>
                                      Route trace
                                    </button>
                                    {routeTraceExpanded && (
                                      <div className="mt-2">
                                        {singleVersion ? (
                                          <div className="space-y-2">
                                            {displaySingleRuns.map((run) => (
                                              <div key={run.run_id} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
                                                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                  Run {run.run_index}
                                                </p>
                                                <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-stone-700 font-mono">
                                                  {prettyRouteTrace(run.turns[i]?.route_trace)}
                                                </pre>
                                              </div>
                                            ))}
                                          </div>
                                        ) : (
                                          <div className="mt-1 flex gap-2 overflow-x-auto pb-1">
                                            {versions.map((ver) => (
                                              <div
                                                key={ver.version_id}
                                                className="flex-1 min-w-[260px] rounded-lg border border-stone-200 bg-white px-3 py-2"
                                              >
                                                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                  {ver.version_name}
                                                </p>
                                                <div className="mt-1 space-y-2">
                                                  {(() => {
                                                    const collapsedRuns = ver.runs.filter((run) => run.run_index === 1);
                                                    const displayRuns = runsExpanded
                                                      ? ver.runs
                                                      : (collapsedRuns.length > 0 ? collapsedRuns : ver.runs.slice(0, 1));
                                                    return displayRuns.map((run) => (
                                                      <div key={run.run_id}>
                                                        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                                          Run {run.run_index}
                                                        </p>
                                                        <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-stone-700 font-mono">
                                                          {prettyRouteTrace(run.turns[i]?.route_trace)}
                                                        </pre>
                                                      </div>
                                                    ));
                                                  })()}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                              );
                            })}
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* ---- */}
                  <hr className="border-stone-200" />

                  {/* 3. Expected behaviour */}
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Expected behaviour</p>
                    <p className="mt-1 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">
                      {typeof r.test_cases.expected_behavior === "string" && r.test_cases.expected_behavior.trim() ? r.test_cases.expected_behavior : "—"}
                    </p>
                  </div>
                  {/* 4. Expected flags */}
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Expected flags</p>
                    <p className="mt-1 text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">
                      {typeof r.test_cases.expected_state === "string" && r.test_cases.expected_state.trim() ? r.test_cases.expected_state : "—"}
                    </p>
                  </div>

                  {(() => {
                    const reviewVersions = (Array.isArray(r.evren_responses) ? r.evren_responses : [])
                      .slice(0, 3)
                      .map((v) => normalizeVersionEntry(v as AnyVersionEntry));
                    if (reviewVersions.length === 0) return null;
                    return (
                      <>
                        <hr className="border-stone-200" />
                        <div className={isViewingCheckpoint ? "pointer-events-none select-none opacity-[0.97]" : undefined}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Behavior review</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={isViewingCheckpoint}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  clearBehaviorReview(r);
                                }}
                                className="inline-flex items-center gap-1 rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 disabled:opacity-50"
                              >
                                <Eraser className="h-3 w-3" />
                                Clear
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void saveBehaviorReview(r);
                                }}
                                disabled={
                                  isViewingCheckpoint ||
                                  savingBehaviorReviewId === r.eval_result_id ||
                                  savedBehaviorReviewId === r.eval_result_id
                                }
                                className={sessionSaveButtonClass({
                                  working: savingBehaviorReviewId === r.eval_result_id,
                                  saved: savedBehaviorReviewId === r.eval_result_id,
                                })}
                              >
                                <Save className="h-3 w-3 shrink-0" aria-hidden />
                                {savingBehaviorReviewId === r.eval_result_id
                                  ? "Saving…"
                                  : savedBehaviorReviewId === r.eval_result_id
                                    ? "Saved"
                                    : "Save"}
                              </button>
                            </div>
                          </div>
                          {/* Mobile: keep cards (tables get cramped). */}
                          <div className="mt-3 grid grid-cols-1 gap-3 sm:hidden">
                            {reviewVersions.map((ver) => (
                              <div
                                key={ver.version_id}
                                className="min-w-0 rounded-lg border border-stone-200 bg-stone-50/80 px-3 py-3"
                              >
                                <p className="text-xs font-medium text-stone-700">{ver.version_name}</p>
                                <div className="mt-2 space-y-2">
                                  {BEHAVIOR_REVIEW_DIMENSIONS.map((dim) => {
                                    const draft = getBehaviorReviewDraft(r, ver.version_id, behaviorReviewDraft);
                                    const val = draft[dim.key];
                                    const selectVal = val === "pass" || val === "fail" || val === "na" ? val : "";
                                    const conf = draft.confidence?.[dim.key as BehaviorReviewDimensionKey] as BehaviorReviewConfidence | null | undefined;
                                    const confColor = conf === "high" ? "bg-emerald-400" : conf === "medium" ? "bg-amber-400" : conf === "low" ? "bg-red-400" : null;
                                    return (
                                      <div key={dim.key} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-2">
                                            <span className="text-sm text-stone-700">{dim.label}</span>
                                            <span className="relative inline-flex">
                                              <span
                                                role="img"
                                                aria-label={`${dim.label} help`}
                                                tabIndex={0}
                                                className="peer inline-flex h-4 w-4 items-center justify-center rounded-full border border-stone-300 bg-white text-[11px] font-semibold leading-none text-stone-600 cursor-help select-none focus:outline-none focus:ring-2 focus:ring-stone-300"
                                              >
                                                ?
                                              </span>
                                              <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 w-72 -translate-x-1/2 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs text-stone-700 shadow-lg opacity-0 transition-opacity duration-75 peer-hover:opacity-100 peer-focus:opacity-100">
                                                {dim.hint}
                                              </span>
                                            </span>
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1">
                                          <select
                                            value={selectVal}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                              const raw = e.target.value;
                                              const nextRating: BehaviorReviewRating | null =
                                                raw === "pass" || raw === "fail" || raw === "na" ? raw : null;
                                              setBehaviorReviewDraft((prev) => {
                                                const rid = r.eval_result_id;
                                                const cur = getBehaviorReviewDraft(r, ver.version_id, prev);
                                                const updated: VersionBehaviorReview = { ...cur, [dim.key]: nextRating };
                                                return {
                                                  ...prev,
                                                  [rid]: {
                                                    ...(prev[rid] ?? {}),
                                                    [ver.version_id]: updated,
                                                  },
                                                };
                                              });
                                            }}
                                            className="rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                                          >
                                            <option value="">—</option>
                                            <option value="pass">Pass</option>
                                            <option value="fail">Fail</option>
                                            <option value="na">N/A</option>
                                          </select>
                                          {confColor && (
                                            <span
                                              title={`AI confidence: ${conf}`}
                                              className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${confColor}`}
                                            />
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                                <div className="mt-2">
                                  <label className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                                    Notes (optional)
                                  </label>
                                  <textarea
                                    rows={2}
                                    value={getBehaviorReviewDraft(r, ver.version_id, behaviorReviewDraft).notes ?? ""}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      const text = e.target.value;
                                      setBehaviorReviewDraft((prev) => {
                                        const rid = r.eval_result_id;
                                        const cur = getBehaviorReviewDraft(r, ver.version_id, prev);
                                        const updated: VersionBehaviorReview = { ...cur, notes: text || null };
                                        return {
                                          ...prev,
                                          [rid]: {
                                            ...(prev[rid] ?? {}),
                                            [ver.version_id]: updated,
                                          },
                                        };
                                      });
                                    }}
                                    placeholder="Short context for this version…"
                                    className="mt-1 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 leading-relaxed focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                                  />
                                </div>
                              </div>
                            ))}
                          </div>

                          {/* Desktop: matrix (rows=versions, columns=dimensions). */}
                          <div className="mt-3 hidden sm:block">
                            <div className="rounded-lg border border-stone-200 bg-white">
                              <table className="w-full table-fixed border-separate border-spacing-0">
                                <thead className="bg-stone-50/80">
                                  <tr>
                                    <th
                                      scope="col"
                                      className="sticky left-0 z-10 w-[140px] border-b border-stone-200 bg-stone-50/80 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-stone-500"
                                    >
                                      Version
                                    </th>
                                    {BEHAVIOR_REVIEW_DIMENSIONS.map((dim) => (
                                      <th
                                        key={dim.key}
                                        scope="col"
                                        className="border-b border-stone-200 px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-stone-500"
                                      >
                                        <span className="inline-flex items-center gap-2">
                                          <span className="leading-tight">{dim.label}</span>
                                          <span className="relative inline-flex">
                                            <span
                                              role="img"
                                              aria-label={`${dim.label} help`}
                                              tabIndex={0}
                                              className="peer inline-flex h-4 w-4 items-center justify-center rounded-full border border-stone-300 bg-white text-[11px] font-semibold leading-none text-stone-600 cursor-help select-none focus:outline-none focus:ring-2 focus:ring-stone-300"
                                            >
                                              ?
                                            </span>
                                            <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 w-72 -translate-x-1/2 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-stone-700 shadow-lg opacity-0 transition-opacity duration-75 peer-hover:opacity-100 peer-focus:opacity-100">
                                              {dim.hint}
                                            </span>
                                          </span>
                                        </span>
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-stone-200">
                                  {reviewVersions.map((ver) => (
                                    <tr key={ver.version_id} className="bg-white">
                                      <th
                                        scope="row"
                                        className="sticky left-0 z-10 border-b border-stone-200 bg-white px-3 py-2 text-left text-sm font-medium text-stone-700"
                                      >
                                        {ver.version_name}
                                      </th>
                                      {BEHAVIOR_REVIEW_DIMENSIONS.map((dim) => {
                                        const draft = getBehaviorReviewDraft(r, ver.version_id, behaviorReviewDraft);
                                        const val = draft[dim.key];
                                        const selectVal = val === "pass" || val === "fail" || val === "na" ? val : "";
                                        const conf = draft.confidence?.[dim.key as BehaviorReviewDimensionKey] as BehaviorReviewConfidence | null | undefined;
                                        const confColor = conf === "high" ? "bg-emerald-400" : conf === "medium" ? "bg-amber-400" : conf === "low" ? "bg-red-400" : null;
                                        return (
                                          <td key={dim.key} className="border-b border-stone-200 px-2 py-2 align-top">
                                            <div className="flex items-center gap-1">
                                              <select
                                                value={selectVal}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => {
                                                  const raw = e.target.value;
                                                  const nextRating: BehaviorReviewRating | null =
                                                    raw === "pass" || raw === "fail" || raw === "na" ? raw : null;
                                                  setBehaviorReviewDraft((prev) => {
                                                    const rid = r.eval_result_id;
                                                    const cur = getBehaviorReviewDraft(r, ver.version_id, prev);
                                                    const updated: VersionBehaviorReview = { ...cur, [dim.key]: nextRating };
                                                    return {
                                                      ...prev,
                                                      [rid]: {
                                                        ...(prev[rid] ?? {}),
                                                        [ver.version_id]: updated,
                                                      },
                                                    };
                                                  });
                                                }}
                                                className="w-full min-w-0 rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                                              >
                                                <option value="">—</option>
                                                <option value="pass">Pass</option>
                                                <option value="fail">Fail</option>
                                                <option value="na">N/A</option>
                                              </select>
                                              {confColor && (
                                                <span
                                                  title={`AI confidence: ${conf}`}
                                                  className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${confColor}`}
                                                />
                                              )}
                                            </div>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                              {reviewVersions.map((ver) => (
                                <div key={ver.version_id} className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2">
                                  <p className="text-[11px] font-medium uppercase tracking-wide text-stone-500">
                                    {ver.version_name} notes (optional)
                                  </p>
                                  <textarea
                                    rows={2}
                                    value={getBehaviorReviewDraft(r, ver.version_id, behaviorReviewDraft).notes ?? ""}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      const text = e.target.value;
                                      setBehaviorReviewDraft((prev) => {
                                        const rid = r.eval_result_id;
                                        const cur = getBehaviorReviewDraft(r, ver.version_id, prev);
                                        const updated: VersionBehaviorReview = { ...cur, notes: text || null };
                                        return {
                                          ...prev,
                                          [rid]: {
                                            ...(prev[rid] ?? {}),
                                            [ver.version_id]: updated,
                                          },
                                        };
                                      });
                                    }}
                                    placeholder="Short context for this version…"
                                    className="mt-1 block w-full rounded-md border border-stone-200 bg-white px-2 py-1 text-sm text-stone-900 leading-relaxed focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </>
                    );
                  })()}

                  {isEvaluated && (
                    <>
                      <hr className="border-stone-200" />
                      <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Analysis</p>
                        {editingReasonId === r.eval_result_id ? (
                          <div className="mt-2">
                            <textarea
                              rows={4}
                              value={editReason}
                              onChange={(e) => setEditReason(e.target.value)}
                              className="block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 leading-relaxed focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                            />
                          </div>
                        ) : (
                          <div className="mt-1 space-y-3">
                            {(r.reason ?? "—")
                              .split(/\n\n+/)
                              .map((para, i) => (
                                <p key={i} className="text-sm text-stone-600 leading-relaxed">
                                  {para.trim() || (i === 0 ? "—" : null)}
                                </p>
                              ))}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {r.comparison && Array.isArray(r.comparison.tiers) && r.comparison.tiers.length > 0 && (() => {
                    const tiers = r.comparison!.tiers.map((t) => (Array.isArray(t) ? t.map(String) : [])).filter((t) => t.length > 0);
                    const ranking = tiers.flat().slice(0, 3);
                    if (ranking.length === 0) return null;

                    const overallReasonText = String(r.comparison!.overall_reason ?? "").trim();
                    const overallHardFailures = r.comparison!.overall_hard_failures ?? {};
                    const rowCanon = buildCanonicalVersionIdMapForRow(r);

                    const tierIndexById = new Map<string, number>();
                    for (let i = 0; i < tiers.length; i++) {
                      for (const vid of tiers[i] ?? []) tierIndexById.set(String(vid), i);
                    }

                    const tierIndexFor = (vid: string): number => {
                      const direct = tierIndexById.get(vid);
                      if (direct != null) return direct;
                      const target = rowCanon(vid);
                      for (const [k, i] of tierIndexById) {
                        if (rowCanon(k) === target) return i;
                      }
                      return 0;
                    };

                    const topTier = tiers[0] ?? [];
                    const hasSingleWinner = topTier.length === 1;
                    const winnerId = hasSingleWinner ? topTier[0] : null;

                    const hasOverallFailure = (vid: string): boolean => {
                      const target = rowCanon(vid);
                      for (const [k, list] of Object.entries(overallHardFailures)) {
                        if (rowCanon(k) !== target) continue;
                        if (Array.isArray(list) && list.length > 0) return true;
                      }
                      return false;
                    };

                    return (
                      <>
                        <hr className="border-stone-200" />
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Version comparison</p>
                              <p className="text-[11px] text-stone-500">Comparison basis: all repeated Evren runs per version</p>
                            </div>
                            <div className="flex items-center gap-2">
                              {aiEditingComparisonId === r.eval_result_id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => applyAiComparisonEdits(r)}
                                    disabled={applyingAiComparison}
                                    className="inline-flex items-center gap-1.5 rounded-md bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
                                    title="Apply (Cmd/Ctrl+Enter)"
                                  >
                                    {applyingAiComparison ? "Applying…" : "Apply"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => { setAiEditingComparisonId(null); setAiComparisonFeedback(""); }}
                                    disabled={applyingAiComparison}
                                    className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isViewingCheckpoint}
                                  onClick={() => {
                                    setAiEditingComparisonId(r.eval_result_id);
                                    setAiComparisonFeedback("");
                                  }}
                                  className={editTriggerClassName}
                                  title="AI edit comparison"
                                >
                                  <Pencil className="h-3.5 w-3.5 text-stone-500" strokeWidth={2} aria-hidden />
                                  Edit
                                </button>
                              )}
                            </div>
                          </div>

                          {aiEditingComparisonId === r.eval_result_id && (
                            <div className="mt-2 rounded-md border border-stone-200 bg-white px-3 py-2">
                              <textarea
                                rows={2}
                                value={aiComparisonFeedback}
                                onChange={(e) => setAiComparisonFeedback(e.target.value)}
                                onKeyDown={(e) => {
                                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                    e.preventDefault();
                                    void applyAiComparisonEdits(r);
                                  }
                                }}
                                placeholder='E.g. "2 > 3 = 1, and no hard failures. Update the reason accordingly."'
                                className="block w-full rounded-md border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900 leading-relaxed focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
                                disabled={applyingAiComparison}
                              />
                            </div>
                          )}

                          <div className="mt-2 flex items-center gap-2">
                            {ranking.map((vId: string) => {
                              const tierIdx = tierIndexFor(vId);
                              const rank = tierIdx + 1;
                              const isChampion =
                                rank === 1 &&
                                hasSingleWinner &&
                                winnerId != null &&
                                (winnerId === vId || rowCanon(winnerId) === rowCanon(vId));
                              const isFailed = hasOverallFailure(vId);
                              return (
                                <span
                                  key={vId}
                                  className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium ${
                                    isFailed
                                      ? "bg-red-100 text-red-800 border border-red-200"
                                      : isChampion
                                        ? "bg-amber-100 text-amber-800 border border-amber-200"
                                        : "bg-emerald-50 text-emerald-800 border border-emerald-200"
                                  }`}
                                >
                                  <span className="text-xs font-bold">#{rank}</span>
                                  {getVersionLabel(vId)}
                                  {isChampion && (
                                    <span className={`${isFailed ? "text-red-700" : "text-amber-600"} text-xs`}>★</span>
                                  )}
                                </span>
                              );
                            })}
                          </div>

                          {overallReasonText && (
                            <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50/80 px-3 py-2">
                              <div className="flex items-center gap-2 text-xs text-stone-500">
                                <span className="font-medium text-stone-700">Overall comparison</span>
                                <span className="text-stone-300">→</span>
                                {winnerId == null ? (
                                  <span className="font-semibold text-stone-600">Tie</span>
                                ) : (
                                  <span
                                    className={`font-semibold ${
                                      hasOverallFailure(winnerId) ? "text-red-700" : "text-emerald-700"
                                    }`}
                                  >
                                    {getVersionLabel(winnerId)} wins
                                  </span>
                                )}
                              </div>
                              <p className="mt-1 text-sm text-stone-600 leading-relaxed">{overallReasonText}</p>
                            </div>
                          )}

                          {ranking.some((vid) => hasOverallFailure(vid)) && (
                            <div className="mt-2 rounded-lg border border-red-200 bg-red-50/70 px-3 py-2">
                              <p className="text-xs font-medium uppercase tracking-wide text-red-700">Hard failures</p>
                              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                                {(() => {
                                  const ordered = (r.evren_responses ?? [])
                                    .slice(0, 3)
                                    .map((v) => v.version_id)
                                    .filter((vid: string) => ranking.includes(vid));
                                  const seen = new Set<string>();
                                  const ids = [...ordered, ...ranking].filter((vid) => {
                                    if (seen.has(vid)) return false;
                                    seen.add(vid);
                                    return true;
                                  });
                                  return ids;
                                })().map((vid: string) => {
                                  const failures = overallHardFailures[vid] ?? [];
                                  return (
                                    <div key={vid} className="rounded-lg border border-red-200 bg-white/70 px-3 py-2">
                                      <p className="text-[11px] font-medium uppercase tracking-wide text-red-700">
                                        {getVersionLabel(vid)}
                                      </p>
                                      {failures.length > 0 ? (
                                        <ul className="mt-1.5 space-y-1 text-xs text-red-700">
                                          {failures.map((f: string, fi: number) => (
                                            <li key={fi}>{f}</li>
                                          ))}
                                        </ul>
                                      ) : (
                                        <p className="mt-1.5 text-xs text-stone-500">—</p>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
            )}
          </li>
          );
        })
        )}
      </ul>
    </div>
  );
}
