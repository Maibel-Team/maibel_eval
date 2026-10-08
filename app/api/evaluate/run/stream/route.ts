import { createClient } from "@/lib/supabase/server";
import { getMaxConcurrentTestCases, runWithConcurrency } from "@/lib/evren-concurrency";
import { callEvrenApiWithMeta } from "@/lib/evren";
import { evaluateOne } from "@/lib/evaluator";
import {
  draftBehaviorReview,
  draftBehaviorReviewForVersionEntries,
  versionEntriesToDraftInputs,
} from "@/lib/behavior-review-drafter";
import { draftSessionReviewSummaryForSessionData } from "@/lib/session-review-summary-refresh";
import { toSessionReviewSummaryJson } from "@/lib/session-review-summary";
import { buildRichReport, runSummarizer } from "@/lib/summarizer";
import { loadEvaluatorSystemPrompt, loadSummarizerSystemPrompt } from "@/lib/prompts";
import { loadContextPack } from "@/lib/context-pack";
import type { TestCase, EvrenOutput, EvaluationResult } from "@/lib/types";
import type { Database, DefaultSettingsRow, RunEntry, TestCasesRow, VersionEntry } from "@/lib/db.types";
import { testCaseFromRow } from "@/lib/test-case-from-row";
import { buildAutofillRunMetadata } from "@/lib/run-metadata-autofill";
import { getAnthropicEvalApiKey } from "@/lib/eval-llm-env";
import { DEFAULT_EVAL_LLM_MODEL } from "@/lib/eval-llm-defaults";
import {
  assertEvalResultsPersisted,
  buildSessionRunMetadata,
  insertEvalResultOrFail,
} from "@/lib/eval-result-storage";

export const maxDuration = 300;

function sendEvent(
  controller: ReadableStreamDefaultController<Uint8Array>,
  type: string,
  payload: object
) {
  try {
    const data = JSON.stringify({ type, ...payload });
    controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
  } catch {
    /* Controller may already be closed (e.g. client disconnect). */
  }
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const userId = authUser?.id ?? process.env.DEFAULT_USER_ID;
  if (!userId)
    return new Response(
      JSON.stringify({ error: "Not logged in and no DEFAULT_USER_ID" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );

  const { data: userRow } = await supabase.from("users").select("user_id").eq("user_id", userId).maybeSingle();
  if (!userRow)
    return new Response(
      JSON.stringify({
        error:
          'User not found in database. test_sessions requires a valid user_id. If signed in, visit /api/auth/sync to create your user row; otherwise set DEFAULT_USER_ID to a UUID that exists in the users table.',
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );

  let body: {
    evren_model_api_url: string;
    mode?: "single" | "comparison";
    run_count?: number;
    model_name?: string;
    summarizer_model?: string;
    system_prompt?: string;
  };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const evrenModelApiUrl = body.evren_model_api_url?.trim();
  if (!evrenModelApiUrl) {
    return new Response(
      JSON.stringify({ error: "evren_model_api_url required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const sessionMode: "comparison" = "comparison";
  const runCount = Number.isFinite(body.run_count) ? Math.max(1, Math.floor(body.run_count as number)) : 1;
  const useEvaluator = false;
  const useSummarizer = false;
  const apiKey = getAnthropicEvalApiKey();
  if ((useEvaluator || useSummarizer) && !apiKey) {
    return new Response(
      JSON.stringify({ error: "Missing ANTHROPIC_API_KEY (or CLAUDE_API_KEY) for evaluator/summarizer" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // On Vercel (and similar), localhost is this server—Evren must be a reachable URL.
  const isProduction = process.env.VERCEL === "1";
  if (isProduction) {
    try {
      const u = new URL(evrenModelApiUrl);
      const host = u.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1")
        return new Response(
          JSON.stringify({
            error:
              "Evren API URL cannot be localhost on Vercel. Set Evren API URL in Settings to your deployed Evren service (or set NEXT_PUBLIC_EVREN_API_URL in Vercel).",
            code: "LOCALHOST_ON_VERCEL",
            status: 400,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
    } catch {
      /* invalid URL already; let callEvrenApi surface it */
    }
  }

  const { data: testCasesRows, error: fetchError } = await supabase
    .from("test_cases")
    .select("*")
    .eq("is_enabled", true)
    .order("test_case_id", { ascending: true });
  if (fetchError)
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  if (!testCasesRows?.length)
    return new Response(JSON.stringify({ error: "No enabled test cases in database" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });

  let contextBundleId: string | null = null;
  try {
    contextBundleId = loadContextPack().bundleId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[evaluate/run/stream] context pack load failed:", msg);
    return new Response(JSON.stringify({ error: `Context pack load failed: ${msg}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const modelName = body.model_name ?? DEFAULT_EVAL_LLM_MODEL;
  const summarizerModel = body.summarizer_model ?? modelName;
  const runMetadata = await buildAutofillRunMetadata(supabase, evrenModelApiUrl, testCasesRows, {
    sessionMode,
    runCount,
    evaluatorModel: modelName,
    summarizerModel,
  });
  const sessionInsert = {
    user_id: userId,
    total_cost_usd: 0,
    summary: null,
    mode: sessionMode,
    manually_edited: false,
    context_bundle_id: contextBundleId,
    run_metadata: buildSessionRunMetadata(runMetadata),
  } as Database["public"]["Tables"]["test_sessions"]["Insert"];
  const { data: sessionRow, error: sessionError } = await supabase
    .from("test_sessions")
    .insert(sessionInsert as any)
    .select("session_id, test_session_id")
    .single();
  if (sessionError || !sessionRow)
    return new Response(
      JSON.stringify({
        error: sessionError?.message ?? "Failed to create session",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  const session = sessionRow as { session_id: string; test_session_id: string };
  const sessionId = session.session_id;
  const testSessionId = session.test_session_id;
  const total = testCasesRows.length;

  const { data: defaultSettings } = await supabase
    .from("default_settings")
    .select("evaluator_prompt, summarizer_prompt")
    .limit(1)
    .maybeSingle();
  const settingsRow = defaultSettings as Pick<DefaultSettingsRow, "evaluator_prompt" | "summarizer_prompt"> | null;
  const systemPrompt =
    (settingsRow?.evaluator_prompt?.trim() || null) ?? body.system_prompt ?? loadEvaluatorSystemPrompt();
  const summarizerPrompt =
    (settingsRow?.summarizer_prompt?.trim() || null) ?? loadSummarizerSystemPrompt();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const evalStartMs = Date.now();
      let totalCostUsd = 0;
      let evrenCodeSourceText: string | null = null;
      type RichSlot = { testCase: TestCase; evrenOutput: EvrenOutput; result: EvaluationResult };
      const richSlots: (RichSlot | null)[] = [];
      try {
        sendEvent(controller, "progress", {
          stage: "start",
          total,
          test_session_id: testSessionId,
          message: `Starting run (${total} test case${total === 1 ? "" : "s"})…`,
        });

        const rows = (testCasesRows ?? []) as TestCasesRow[];
        richSlots.length = rows.length;
        richSlots.fill(null);
        const versionId = crypto.randomUUID();
        const maxConcurrentTestCases = getMaxConcurrentTestCases(runCount);
        let completedCount = 0;

        await runWithConcurrency(rows, maxConcurrentTestCases, async (row, index) => {
          const testCase: TestCase = testCaseFromRow(row);

          const runPromises = Array.from({ length: runCount }, async () => callEvrenApiWithMeta(evrenModelApiUrl, testCase));
          const runResults = await Promise.allSettled(runPromises);
          const runs: RunEntry[] = [];

          for (let runIndex = 0; runIndex < runResults.length; runIndex++) {
            const settled = runResults[runIndex];
            if (settled.status !== "fulfilled") {
              const msg =
                settled.reason instanceof Error ? settled.reason.message : String(settled.reason ?? "Evren error");
              console.error("[evaluate/run/stream] Evren error for", testCase.test_case_id, msg);
              continue;
            }
            const runOutputs = settled.value.outputs;
            if (!evrenCodeSourceText && settled.value.codeSource?.text) {
              evrenCodeSourceText = settled.value.codeSource.text;
              try {
                await supabase
                  .from("test_sessions")
                  .update({ run_metadata: buildSessionRunMetadata(runMetadata, evrenCodeSourceText) } as never)
                  .eq("session_id", sessionId);
              } catch {
                /* best-effort */
              }
            }
            runs.push({
              run_id: crypto.randomUUID(),
              run_index: runIndex + 1,
              turns: runOutputs.map((o) => ({
                response: Array.isArray(o.evren_response) ? o.evren_response.map(String) : [String(o.evren_response ?? "")],
                detected_flags: String(o.detected_states ?? ""),
                route_trace: o.route_trace ?? null,
              })),
            });
          }
          if (runs.length === 0) {
            completedCount++;
            sendEvent(controller, "progress", {
              stage: "done",
              index: completedCount,
              total,
              test_case_id: testCase.test_case_id,
              message: `Completed ${completedCount} of ${total}`,
            });
            return;
          }

          const run1Turns = runs[0]?.turns ?? [];
          const run1Outputs = run1Turns.map((t) => ({
            evren_response: t.response,
            detected_states: t.detected_flags,
            route_trace: t.route_trace ?? null,
          }));

          const versionEntry: VersionEntry = {
            version_id: versionId,
            version_name: "Version 1",
            run_count_requested: runCount,
            evidence_source: runCount > 1 ? "automated" : "none",
            comparison_basis_run_index: 1,
            runs,
          };
          const evrenResponsesColumn = [versionEntry];
          const lastOutput = run1Outputs[run1Outputs.length - 1] ?? { evren_response: "", detected_states: "" };
          if (useEvaluator) {
            const evalInput =
              testCase.type === "multi_turn" && run1Outputs.length > 1 ? run1Outputs : lastOutput;
            sendEvent(controller, "progress", {
              stage: "evaluating",
              index,
              total,
              test_case_id: testCase.test_case_id,
              message: "Evaluating…",
            });

            const contextPack = loadContextPack({
              purpose: "evaluator",
              query: `${testCase.test_case_id}\n${testCase.expected_state}\n${testCase.expected_behavior}\n${testCase.forbidden ?? ""}\n${testCase.notes ?? ""}`,
            });

            const result = await evaluateOne(
              testCase,
              evalInput,
              apiKey as string,
              modelName,
              systemPrompt,
              { text: contextPack.text, bundleId: contextPack.bundleId }
            );
            const costUsd = result.token_usage?.cost_usd ?? 0;
            totalCostUsd += costUsd;

            richSlots[index] = { testCase, evrenOutput: lastOutput, result };

            let behaviorReview: Record<string, unknown> = {};
            try {
              const draftResult = await draftBehaviorReview({
                testCase,
                versions: versionEntriesToDraftInputs([versionEntry]),
                evaluatorReason: result.reason,
                apiKey: apiKey as string,
                modelName,
                contextPack: contextPack ? { text: contextPack.text, bundleId: contextPack.bundleId } : undefined,
              });
              if (Object.keys(draftResult.reviews).length > 0) {
                behaviorReview = draftResult.reviews;
              }
              if (draftResult.token_usage) {
                totalCostUsd += draftResult.token_usage.cost_usd;
              }
            } catch (brErr) {
              console.error("[evaluate/run/stream] behavior review draft failed:", brErr instanceof Error ? brErr.message : brErr);
            }

            const evalPayload = {
              session_id: sessionId,
              test_case_uuid: row.id,
              evren_responses: evrenResponsesColumn,
              success: result.success,
              score: result.score,
              reason: result.reason ?? null,
              prompt_tokens: result.token_usage?.prompt_tokens ?? null,
              completion_tokens: result.token_usage?.completion_tokens ?? null,
              total_tokens: result.token_usage?.total_tokens ?? null,
              cost_usd: costUsd || null,
              manually_edited: false,
              behavior_review: behaviorReview,
            } as Database["public"]["Tables"]["eval_results"]["Insert"];
            await insertEvalResultOrFail(supabase, evalPayload, {
              sessionId,
              testCaseUuid: row.id,
              testCaseId: testCase.test_case_id,
              testCaseTitle: testCase.title,
              evalStartMs,
              logPrefix: "[evaluate/run/stream]",
            });
          } else {
            let behaviorReview: Record<string, unknown> = {};
            if (apiKey) {
              try {
                const draftResult = await draftBehaviorReviewForVersionEntries({
                  testCase,
                  versions: [versionEntry],
                  evaluatorReason: null,
                  apiKey: apiKey as string,
                  modelName,
                });
                if (Object.keys(draftResult.reviews).length > 0) {
                  behaviorReview = draftResult.reviews;
                }
                if (draftResult.token_usage) {
                  totalCostUsd += draftResult.token_usage.cost_usd;
                }
              } catch (brErr) {
                console.error(
                  "[evaluate/run/stream] behavior review draft failed (comparison mode):",
                  brErr instanceof Error ? brErr.message : brErr
                );
              }
            }
            const evalPayload = {
              session_id: sessionId,
              test_case_uuid: row.id,
              evren_responses: evrenResponsesColumn,
              // Placeholder row so conversation still appears in session details.
              success: false,
              score: 0,
              reason: null,
              prompt_tokens: null,
              completion_tokens: null,
              total_tokens: null,
              cost_usd: null,
              manually_edited: false,
              behavior_review: behaviorReview,
            } as Database["public"]["Tables"]["eval_results"]["Insert"];
            await insertEvalResultOrFail(supabase, evalPayload, {
              sessionId,
              testCaseUuid: row.id,
              testCaseId: testCase.test_case_id,
              testCaseTitle: testCase.title,
              evalStartMs,
              logPrefix: "[evaluate/run/stream]",
            });
          }

          completedCount++;
          sendEvent(controller, "progress", {
            stage: "done",
            index: completedCount,
            total,
            test_case_id: testCase.test_case_id,
            message: `Completed ${completedCount} of ${total}`,
          });
        });

        await assertEvalResultsPersisted(supabase, sessionId, total, evalStartMs, "[evaluate/run/stream]");

        const richReportInputs = richSlots.filter((s): s is RichSlot => s != null);

        let summary: string | null = null;
        let title: string | null = null;
        if (useSummarizer && richReportInputs.length > 0) {
          sendEvent(controller, "progress", {
            stage: "summarizing",
            total,
            message: "Generating validation report…",
          });
          const richReports = richReportInputs.map(({ testCase, evrenOutput, result }) =>
            buildRichReport(testCase, evrenOutput, result)
          );
          const summarizerResult = await runSummarizer(
            apiKey as string,
            richReports,
            summarizerModel,
            summarizerPrompt
          );
          totalCostUsd += summarizerResult.cost_usd;
          summary = summarizerResult.summary;
          title = summarizerResult.title || null;
        }

        const totalEvalTimeSeconds = (Date.now() - evalStartMs) / 1000;
        const sessionUpdate: Database["public"]["Tables"]["test_sessions"]["Update"] = {
          total_cost_usd: totalCostUsd,
          total_eval_time_seconds: totalEvalTimeSeconds,
          title,
          summary,
        };

        if (apiKey) {
          try {
            sendEvent(controller, "progress", {
              stage: "session_review_summary",
              total,
              message: "Drafting session review summary…",
            });
            const draftSummary = await draftSessionReviewSummaryForSessionData(supabase, {
              sessionId,
              sessionMode: sessionMode,
              sessionTitle: title,
              sessionSummary: summary,
              apiKey,
              modelName,
              logPrefix: "[evaluate/run/stream]",
            });
            if (draftSummary?.summary) {
              sessionUpdate.total_cost_usd =
                (sessionUpdate.total_cost_usd ?? 0) + (draftSummary.token_usage?.cost_usd ?? 0);
              sessionUpdate.session_review_summary = toSessionReviewSummaryJson(draftSummary.summary);
              sessionUpdate.session_review_summary_basis_fingerprint = draftSummary.comparisonBasisFingerprint;
              console.log("[evaluate/run/stream] session review summary drafted successfully");
            } else {
              console.warn("[evaluate/run/stream] session review summary drafter returned null/empty");
            }
          } catch (srErr) {
            console.error(
              "[evaluate/run/stream] session review summary draft failed:",
              srErr instanceof Error ? srErr.message : srErr
            );
          }
        }

        const { error: updateErr } = await supabase
          .from("test_sessions")
          .update(sessionUpdate as unknown as never)
          .eq("session_id", sessionId);
        if (updateErr) {
          console.error("[evaluate/run/stream] session update failed:", updateErr.message);
        }

        sendEvent(controller, "complete", {
          test_session_id: testSessionId,
          total_cost_usd: totalCostUsd,
          title: title ?? undefined,
          summary: summary ?? undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Run failed";
        console.error("[evaluate/run/stream] Error:", message, err);
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
