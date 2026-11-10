import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/db.types";

type EvalResultInsertPayload = Database["public"]["Tables"]["eval_results"]["Insert"];

export function buildSessionRunMetadata(runMetadata: unknown, evrenCodeSourceText?: string | null): Record<string, unknown> {
  const metadata = { ...((runMetadata ?? {}) as Record<string, unknown>) };
  const evalSiteCodeSource = typeof metadata.code_source === "string" ? metadata.code_source.trim() : "";
  if (evalSiteCodeSource) {
    metadata.eval_site_code_source = evalSiteCodeSource;
  }
  delete metadata.code_source;

  const targetEvrenCodeSource = typeof evrenCodeSourceText === "string" ? evrenCodeSourceText.trim() : "";
  if (targetEvrenCodeSource) {
    metadata.target_evren_code_source = targetEvrenCodeSource;
    metadata.code_source = targetEvrenCodeSource;
  }

  return metadata;
}

export async function markSessionStorageFailed(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  message: string,
  evalStartMs: number,
  logPrefix: string
) {
  const { error } = await supabase
    .from("test_sessions")
    .update({
      title: "Run failed: eval result storage",
      summary: message,
      total_eval_time_seconds: (Date.now() - evalStartMs) / 1000,
    } as never)
    .eq("session_id", sessionId);

  if (error) {
    console.error(`${logPrefix} session failure marker update failed:`, error.message);
  }
}

export async function insertEvalResultOrFail(
  supabase: SupabaseClient<Database>,
  payload: EvalResultInsertPayload,
  info: {
    sessionId: string;
    testCaseUuid: string;
    testCaseId: string;
    testCaseTitle?: string | null;
    evalStartMs: number;
    logPrefix: string;
  }
) {
  const { data, error } = await supabase
    .from("eval_results")
    .insert(payload as any)
    .select("eval_result_id")
    .single();

  if (error || !data) {
    const message = error?.message ?? "eval_results insert returned no row";
    console.error(`${info.logPrefix} eval_results insert failed`, {
      session_id: info.sessionId,
      test_case_uuid: info.testCaseUuid,
      test_case_id: info.testCaseId,
      test_case_title: info.testCaseTitle ?? null,
      error: message,
    });
    await markSessionStorageFailed(
      supabase,
      info.sessionId,
      `Eval result storage failed for ${info.testCaseId}: ${message}`,
      info.evalStartMs,
      info.logPrefix
    );
    throw new Error(`Eval result storage failed for ${info.testCaseId}: ${message}`);
  }
}

export async function assertEvalResultsPersisted(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  expectedCount: number,
  evalStartMs: number,
  logPrefix: string
) {
  const { count, error } = await supabase
    .from("eval_results")
    .select("eval_result_id", { count: "exact", head: true })
    .eq("session_id", sessionId);

  if (error) {
    console.error(`${logPrefix} eval_results persistence count failed`, {
      session_id: sessionId,
      expected_count: expectedCount,
      error: error.message,
    });
    await markSessionStorageFailed(
      supabase,
      sessionId,
      `Eval result persistence check failed: ${error.message}`,
      evalStartMs,
      logPrefix
    );
    throw new Error(`Eval result persistence check failed: ${error.message}`);
  }

  const persistedCount = count ?? 0;
  if (expectedCount > 0 && persistedCount < expectedCount) {
    const message = `Eval result persistence invariant failed: expected ${expectedCount}, found ${persistedCount}`;
    console.error(`${logPrefix} ${message}`, { session_id: sessionId });
    await markSessionStorageFailed(supabase, sessionId, message, evalStartMs, logPrefix);
    throw new Error(message);
  }
}
