import { isEvrenFlashModel } from "@/lib/evren-models";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getMaxConcurrentTestCases, runWithConcurrency } from "@/lib/evren-concurrency";
import { callEvrenApiWithMeta } from "@/lib/evren";
import { loadContextPack } from "@/lib/context-pack";
import { appendDistinctCodeSourceSegment } from "@/lib/run-metadata-autofill";
import { persistSessionReviewSummaryForSession } from "@/lib/session-review-summary-refresh";
import { createSessionResultSnapshot } from "@/lib/session-snapshots";
import { rerunComparisonsForSession } from "@/lib/rerun-session-comparisons";
import type { TestCase } from "@/lib/types";
import type { DefaultSettingsRow, EvalResultsRow, RunEntry, TestCasesRow, VersionEntry } from "@/lib/db.types";
import { testCaseFromRow } from "@/lib/test-case-from-row";
import { getAnthropicEvalApiKey } from "@/lib/eval-llm-env";
import { DEFAULT_EVAL_LLM_MODEL, normalizeAnthropicModelName } from "@/lib/eval-llm-defaults";

const FALLBACK_EVREN_URL = process.env.NEXT_PUBLIC_EVREN_API_URL || "http://localhost:8000";

type EvalResultLite = Pick<
  EvalResultsRow,
  "eval_result_id" | "test_case_uuid" | "evren_responses" | "comparison" | "reason"
>;

function validateEvrenUrlForDeploy(evrenModelApiUrl: string): { ok: true } | { ok: false; error: string; code: string } {
  const isVercel = process.env.VERCEL === "1";
  if (!isVercel) return { ok: true };
  try {
    const u = new URL(evrenModelApiUrl);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") {
      return {
        ok: false,
        code: "LOCALHOST_ON_VERCEL",
        error:
          "Evren API URL cannot be localhost on Vercel. Set Evren API URL in Settings to your deployed Evren service (or set NEXT_PUBLIC_EVREN_API_URL in Vercel).",
      };
    }
  } catch {
    // Let downstream Evren call surface invalid URLs.
  }
  return { ok: true };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: {
    version_name?: string;
    run_count?: number;
    evren_flash_model?: string;
    run_comparison?: boolean;
  } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  const runComparison = body.run_comparison ?? false;
  if (body.evren_flash_model !== undefined && !isEvrenFlashModel(body.evren_flash_model)) {
    return Response.json({ error: "Unsupported Evren Flash model" }, { status: 400 });
  }
  const runCount = Number.isFinite(body.run_count) ? Math.max(1, Math.floor(body.run_count as number)) : 1;

  const supabase = await createClient();

  const apiKey = getAnthropicEvalApiKey();
  if (runComparison && !apiKey) {
    return NextResponse.json(
      { error: "Missing ANTHROPIC_API_KEY or CLAUDE_API_KEY (required for comparison)" },
      { status: 500 }
    );
  }

  const { data: session, error: sessionError } = await supabase
    .from("test_sessions")
    .select("session_id, mode, title, summary, run_metadata")
    .eq("test_session_id", id)
    .maybeSingle();
  if (sessionError || !session) {
    return NextResponse.json({ error: sessionError?.message ?? "Session not found" }, { status: 404 });
  }

  const sessionId = (session as { session_id: string }).session_id;
  const sessionMode =
    (session as { mode?: string }).mode === "comparison" ? "comparison" : "single";
  const sessionTitle = (session as { title?: string | null }).title ?? null;
  const sessionSummary = (session as { summary?: string | null }).summary ?? null;

  // Snapshot current session result state before mutating versions (Git-like "commit").
  await createSessionResultSnapshot({
    supabase,
    sessionId,
    kind: "before_add_version",
    message: `Before add version: ${body.version_name?.trim() || "new version"}`,
  });

  const { data: settingsRow } = await supabase
    .from("default_settings")
    .select("evren_api_url, evaluator_model")
    .limit(1)
    .maybeSingle();
  const settings = settingsRow as Pick<DefaultSettingsRow, "evren_api_url" | "evaluator_model"> | null;
  const evrenModelApiUrl = settings?.evren_api_url?.trim() || FALLBACK_EVREN_URL;
  const comparatorModel = normalizeAnthropicModelName(settings?.evaluator_model?.trim()) ?? DEFAULT_EVAL_LLM_MODEL;

  const evrenUrlCheck = validateEvrenUrlForDeploy(evrenModelApiUrl);
  if (!evrenUrlCheck.ok) {
    return NextResponse.json(
      { error: evrenUrlCheck.error, code: evrenUrlCheck.code, status: 400 },
      { status: 400 }
    );
  }

  const { data: evalRows, error: evalError } = await supabase
    .from("eval_results")
    .select("eval_result_id, test_case_uuid, evren_responses, comparison, reason")
    .eq("session_id", sessionId)
    .order("eval_result_id");
  if (evalError) {
    return NextResponse.json({ error: evalError.message }, { status: 500 });
  }

  const rows = (evalRows ?? []) as EvalResultLite[];
  if (rows.length === 0) {
    return NextResponse.json({ error: "No test case rows found in this session." }, { status: 400 });
  }

  const testCaseIds = Array.from(new Set(rows.map((r) => r.test_case_uuid).filter(Boolean)));
  const { data: testCaseRows, error: tcError } = await supabase
    .from("test_cases")
    .select("*")
    .in("id", testCaseIds);
  if (tcError) {
    return NextResponse.json({ error: tcError.message }, { status: 500 });
  }
  const typedTestCaseRows = (testCaseRows ?? []) as TestCasesRow[];
  const testCaseById = new Map(typedTestCaseRows.map((r) => [r.id, r]));

  const existingVersions = Array.isArray(rows[0]?.evren_responses) ? rows[0].evren_responses : [];
  const versionName = body.version_name?.trim() || `Version ${existingVersions.length + 1}`;
  const newVersionId = crypto.randomUUID();

  const maxConcurrentTestCases = getMaxConcurrentTestCases(runCount);
  const sessionRunMeta = { ...(((session as { run_metadata?: Record<string, unknown> }).run_metadata ?? {}) as Record<string, unknown>) };
  (session as { run_metadata?: Record<string, unknown> }).run_metadata = sessionRunMeta;

  await runWithConcurrency(rows, maxConcurrentTestCases, async (row) => {
    const tc = testCaseById.get(row.test_case_uuid);
    if (!tc) return;

    const testCase: TestCase = testCaseFromRow(tc);

    const runPromises = Array.from({ length: runCount }, async () => callEvrenApiWithMeta(evrenModelApiUrl, testCase, body.evren_flash_model));
    const runResults = await Promise.allSettled(runPromises);
    const runs: RunEntry[] = [];

    for (let runIndex = 0; runIndex < runResults.length; runIndex++) {
      const settled = runResults[runIndex];
      if (settled.status !== "fulfilled") {
        console.error(
          "[sessions/add-version] Evren error for",
          tc.test_case_id,
          settled.reason instanceof Error ? settled.reason.message : settled.reason
        );
        continue;
      }
      const runOutputs = settled.value.outputs;
      const seg = settled.value.codeSource?.text?.trim();
      if (seg) {
        const prev =
          typeof sessionRunMeta.code_source === "string" ? sessionRunMeta.code_source.trim() : "";
        const merged = appendDistinctCodeSourceSegment(prev || null, seg);
        if (merged && merged !== prev) {
          sessionRunMeta.code_source = merged;
          try {
            await supabase
              .from("test_sessions")
              .update({ run_metadata: sessionRunMeta as never } as never)
              .eq("session_id", sessionId);
          } catch {
            /* best-effort */
          }
        }
      }
      runs.push({
        run_id: crypto.randomUUID(),
        run_index: runIndex + 1,
        request_duration_seconds: settled.value.requestDurationSeconds,
        code_source: settled.value.codeSource?.text ?? null,
        eval_user_id: settled.value.evalUserId ?? null,
        turns: runOutputs.map((o) => ({
          response: Array.isArray(o.evren_response) ? o.evren_response.map(String) : [String(o.evren_response ?? "")],
          detected_flags: String(o.detected_states ?? ""),
          route_trace: o.route_trace ?? null,
          metrics: o.metrics ?? null,
        })),
      });
    }
    if (runs.length !== runCount) {
      throw new Error(`Evren completed ${runs.length}/${runCount} runs. Check backend errors before comparing models.`);
    }
    const existing = Array.isArray(row.evren_responses) ? (row.evren_responses as VersionEntry[]) : [];
    const newVersion: VersionEntry = {
      version_id: newVersionId,
      version_name: versionName,
      run_count_requested: runCount,
      evidence_source: runCount > 1 ? "automated" : "none",
      comparison_basis_run_index: 1,
      runs,
    };
    const mergedResponses = [...existing, newVersion];

    await supabase
      .from("eval_results")
      .update({ evren_responses: mergedResponses } as never)
      .eq("eval_result_id", row.eval_result_id);
  });

  if (runComparison && apiKey) {
    try {
      await rerunComparisonsForSession({
        supabase,
        sessionId,
        apiKey,
        comparatorModel,
      });
    } catch (e) {
      console.error("[sessions/add-version] rerun comparisons failed:", e);
    }
  }

  const { data: updatedResults, error: resultsError } = await supabase
    .from("eval_results")
    .select("*, test_cases(id, test_case_id, input_message, expected_state, expected_behavior, title, type, turns)")
    .eq("session_id", sessionId)
    .order("eval_result_id");
  if (resultsError) {
    return NextResponse.json({ error: resultsError.message }, { status: 500 });
  }

  const resultsWithTestCaseId = (updatedResults ?? []).map((r: { test_cases?: Record<string, unknown> & { test_case_id?: string } }) => {
    const tc = r.test_cases != null ? { ...r.test_cases } : undefined;
    return { ...r, test_case_id: tc?.test_case_id, test_cases: tc };
  });

  if (apiKey && sessionMode === "comparison") {
    await persistSessionReviewSummaryForSession(supabase, {
      sessionId,
      sessionMode: "comparison",
      sessionTitle,
      sessionSummary,
      apiKey,
      modelName: comparatorModel,
      logPrefix: "[sessions/add-version]",
    });
  }

  return NextResponse.json({ results: resultsWithTestCaseId });
}
