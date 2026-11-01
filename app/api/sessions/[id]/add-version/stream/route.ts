import { isEvrenFlashModel, validRouteControls } from "@/lib/evren-models";
import { createClient } from "@/lib/supabase/server";
import { getMaxConcurrentTestCases, runWithConcurrency } from "@/lib/evren-concurrency";
import { callEvrenApiWithMeta } from "@/lib/evren";
import { mergeBehaviorReviewMap } from "@/lib/behavior-review";
import { draftBehaviorReviewForVersionEntries } from "@/lib/behavior-review-drafter";
import { compareOverall } from "@/lib/comparator";
import { loadComparatorOverallSystemPrompt } from "@/lib/prompts";
import { loadContextPack } from "@/lib/context-pack";
import { appendDistinctCodeSourceSegment } from "@/lib/run-metadata-autofill";
import { persistSessionReviewSummaryForSession } from "@/lib/session-review-summary-refresh";
import { createSessionResultSnapshot } from "@/lib/session-snapshots";
import type { TestCase } from "@/lib/types";
import type { DefaultSettingsRow, EvalResultsRow, RunEntry, TestCasesRow, VersionEntry } from "@/lib/db.types";
import { testCaseFromRow } from "@/lib/test-case-from-row";
import { getAnthropicEvalApiKey } from "@/lib/eval-llm-env";
import { DEFAULT_EVAL_LLM_MODEL, normalizeAnthropicModelName } from "@/lib/eval-llm-defaults";

const FALLBACK_EVREN_URL = process.env.NEXT_PUBLIC_EVREN_API_URL || "http://localhost:8000";
const DEFAULT_MAX_INFLIGHT_COMPARISONS = 3;

function getMaxConcurrentComparisons(): number {
  const raw = process.env.MAX_INFLIGHT_COMPARISONS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_INFLIGHT_COMPARISONS;
}

function createLimiter(maxInFlight: number) {
  const limit = Number.isFinite(maxInFlight) && maxInFlight > 0 ? Math.floor(maxInFlight) : 1;
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= limit) return;
    const run = queue.shift();
    if (!run) return;
    active++;
    run();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> =>
    await new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
}

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

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  type: string,
  payload: object
) {
  try {
    const data = JSON.stringify({ type, ...payload });
    controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
  } catch {
    /* controller likely closed */
  }
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
    disable_p0?: boolean;
    disable_p1?: boolean;
    run_comparison?: boolean;
  } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  const runComparison = body.run_comparison ?? false;
  if (!validRouteControls(body)) {
    return Response.json({ error: "P0/P1 controls must be booleans" }, { status: 400 });
  }
  const evalConfig = { flash_model: body.evren_flash_model ?? "gemini-2.5-flash", disable_p0: body.disable_p0 ?? false, disable_p1: body.disable_p1 ?? false };
  if (body.evren_flash_model !== undefined && !isEvrenFlashModel(body.evren_flash_model)) {
    return Response.json({ error: "Unsupported Evren Flash model" }, { status: 400 });
  }
  const runCount = Number.isFinite(body.run_count) ? Math.max(1, Math.floor(body.run_count as number)) : 1;

  const supabase = await createClient();

  const apiKey = getAnthropicEvalApiKey();
  if (runComparison && !apiKey) {
    return new Response(
      JSON.stringify({ error: "Missing ANTHROPIC_API_KEY or CLAUDE_API_KEY (required for comparison)" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const { data: session, error: sessionError } = await supabase
    .from("test_sessions")
    .select("session_id, mode, title, summary, run_metadata")
    .eq("test_session_id", id)
    .maybeSingle();
  if (sessionError || !session) {
    return new Response(JSON.stringify({ error: sessionError?.message ?? "Session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
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
    return new Response(JSON.stringify({ error: evrenUrlCheck.error, code: evrenUrlCheck.code, status: 400 }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: evalRows, error: evalError } = await supabase
    .from("eval_results")
    .select("eval_result_id, test_case_uuid, evren_responses, comparison, reason")
    .eq("session_id", sessionId)
    .order("eval_result_id");
  if (evalError) {
    return new Response(JSON.stringify({ error: evalError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rows = (evalRows ?? []) as EvalResultLite[];
  if (rows.length === 0) {
    return new Response(JSON.stringify({ error: "No test case rows found in this session." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const testCaseIds = Array.from(new Set(rows.map((r) => r.test_case_uuid).filter(Boolean)));
  const { data: testCaseRows, error: tcError } = await supabase
    .from("test_cases")
    .select("*")
    .in("id", testCaseIds);
  if (tcError) {
    return new Response(JSON.stringify({ error: tcError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const testCaseById = new Map((testCaseRows ?? []).map((r) => [(r as TestCasesRow).id, r as TestCasesRow]));

  const existingVersions = Array.isArray(rows[0]?.evren_responses) ? rows[0].evren_responses : [];
  if (existingVersions.length >= 3) {
    return new Response(JSON.stringify({ error: "Maximum of 3 versions allowed per session." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const versionName = body.version_name?.trim() || `Version ${existingVersions.length + 1}`;
  const newVersionId = crypto.randomUUID();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const sessionRunMeta = {
          ...(((session as { run_metadata?: Record<string, unknown> }).run_metadata ?? {}) as Record<string, unknown>),
        };
        (session as { run_metadata?: Record<string, unknown> }).run_metadata = sessionRunMeta;
        sendEvent(controller, "progress", {
          stage: "start",
          total: rows.length,
          message: `Adding version for ${rows.length} test case${rows.length === 1 ? "" : "s"}…`,
        });

        const maxConcurrentTestCases = getMaxConcurrentTestCases(runCount);
        let completedCount = 0;

        // If enabled, start comparisons as soon as each test case finishes adding its new version,
        // bounded by a separate concurrency limit. This overlaps "add version" and "compare" work.
        const comparatorPrompt = runComparison ? loadComparatorOverallSystemPrompt() : "";
        const maxConcurrentComparisons = runComparison ? getMaxConcurrentComparisons() : 1;
        const limitComparison = createLimiter(maxConcurrentComparisons);
        const comparisonPromises: Promise<void>[] = [];
        let comparedCount = 0;

        await runWithConcurrency(rows, maxConcurrentTestCases, async (row) => {
          const tc = testCaseById.get(row.test_case_uuid);
          if (!tc) return;

          const testCase: TestCase = testCaseFromRow(tc);

          const runPromises = Array.from({ length: runCount }, async () => callEvrenApiWithMeta(evrenModelApiUrl, testCase, evalConfig.flash_model, evalConfig));
          const runResults = await Promise.allSettled(runPromises);
          const runs: RunEntry[] = [];

          for (let runIndex = 0; runIndex < runResults.length; runIndex++) {
            const settled = runResults[runIndex];
            if (settled.status !== "fulfilled") {
              const msg =
                settled.reason instanceof Error ? settled.reason.message : String(settled.reason ?? "Evren error");
              console.error("[add-version/stream] Evren error for", tc.test_case_id, msg);
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
          if (runs.length > 0) {
            const existing = Array.isArray(row.evren_responses) ? (row.evren_responses as VersionEntry[]) : [];
            const newVersion: VersionEntry = {
              eval_config: evalConfig,
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

            if (runComparison && apiKey) {
              comparisonPromises.push(
                limitComparison(async () => {
                  const versions = mergedResponses;
                  if (versions.length < 2) return;

                  const versionIds = versions.map((v) => v.version_id).slice(0, 3);
                  if (versionIds.length < 2) return;

                  const testCase: TestCase = testCaseFromRow(tc);

                  try {
                    const contextPack = loadContextPack({
                      purpose: "comparator",
                      query: `${testCase.test_case_id}\n${testCase.expected_state}\n${testCase.expected_behavior}\n${testCase.forbidden ?? ""}\n${testCase.notes ?? ""}`,
                    });
                    const compResult = await compareOverall(
                      testCase,
                      versions,
                      versionIds.length === 2
                        ? ([versionIds[0], versionIds[1]] as [string, string])
                        : ([versionIds[0], versionIds[1], versionIds[2]] as [string, string, string]),
                      apiKey,
                      comparatorModel,
                      comparatorPrompt,
                      { text: contextPack.text, bundleId: contextPack.bundleId }
                    );

                    await supabase
                      .from("eval_results")
                      .update({ comparison: compResult } as never)
                      .eq("eval_result_id", row.eval_result_id);

                    const reasonText =
                      (typeof row.reason === "string" && row.reason.trim() ? row.reason : null) ??
                      compResult.overall_reason ??
                      null;
                    try {
                      const draftResult = await draftBehaviorReviewForVersionEntries({
                        testCase,
                        versions,
                        evaluatorReason: reasonText,
                        apiKey,
                        modelName: comparatorModel,
                      });
                      if (Object.keys(draftResult.reviews).length > 0) {
                        const allowed = new Set(versionIds);
                        const merged = mergeBehaviorReviewMap({}, draftResult.reviews, allowed);
                        if (merged) {
                          await supabase
                            .from("eval_results")
                            .update({ behavior_review: merged } as never)
                            .eq("eval_result_id", row.eval_result_id);
                        }
                      }
                    } catch (brErr) {
                      console.error("[add-version/stream] Behavior review draft error for", tc.test_case_id, brErr);
                    }

                    comparedCount++;
                    sendEvent(controller, "progress", {
                      stage: "compared",
                      index: comparedCount,
                      total: rows.length,
                      test_case_id: tc.test_case_id,
                      message: `Compared ${comparedCount} of ${rows.length}`,
                    });
                  } catch (compErr) {
                    comparedCount++;
                    const msg = compErr instanceof Error ? compErr.message : String(compErr);
                    console.error("[add-version/stream] Comparison error for", tc.test_case_id, msg);
                    sendEvent(controller, "progress", {
                      stage: "compare_error",
                      index: comparedCount,
                      total: rows.length,
                      test_case_id: tc.test_case_id,
                      message: `Comparison failed: ${msg.slice(0, 80)}`,
                    });
                  }
                })
              );
            }
          }

          completedCount++;
          sendEvent(controller, "progress", {
            stage: "done",
            index: completedCount,
            total: rows.length,
            test_case_id: tc.test_case_id,
            message: `Completed ${completedCount} of ${rows.length}`,
          });
        });

        if (runComparison && apiKey) {
          sendEvent(controller, "progress", {
            stage: "comparing",
            total: rows.length,
            message: `Running comparisons for ${rows.length} test case${rows.length === 1 ? "" : "s"}…`,
          });
          await Promise.allSettled(comparisonPromises);
        }

        const { data: updatedResults, error: resultsError } = await supabase
          .from("eval_results")
          .select("*, test_cases(id, test_case_id, input_message, expected_state, expected_behavior, title, type, turns)")
          .eq("session_id", sessionId)
          .order("eval_result_id");
        if (resultsError) {
          sendEvent(controller, "error", { error: resultsError.message });
          return;
        }

        const resultsWithTestCaseId = (updatedResults ?? []).map((r: { test_cases?: Record<string, unknown> & { test_case_id?: string } }) => {
          const tc = r.test_cases != null ? { ...r.test_cases } : undefined;
          return { ...r, test_case_id: tc?.test_case_id, test_cases: tc };
        });

        if (apiKey && sessionMode === "comparison") {
          sendEvent(controller, "progress", {
            stage: "session_review_summary",
            total: rows.length,
            message: "Updating session review summary…",
          });
          await persistSessionReviewSummaryForSession(supabase, {
            sessionId,
            sessionMode: "comparison",
            sessionTitle: sessionTitle,
            sessionSummary: sessionSummary,
            apiKey,
            modelName: comparatorModel,
            logPrefix: "[sessions/add-version/stream]",
          });
        }

        sendEvent(controller, "complete", { results: resultsWithTestCaseId });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Add version failed";
        sendEvent(controller, "error", { error: message });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    },
  });
}
