import type { EvrenMetrics } from "@/lib/types";

export function EvrenTurnMetrics({ metrics }: { metrics?: EvrenMetrics | null }) {
  if (!metrics) return null;
  return <details className="mt-2 text-xs text-stone-600">
    <summary className="cursor-pointer">{metrics.flash_model} · {metrics.duration_seconds.toFixed(2)}s · {metrics.total_tokens.toLocaleString()} tokens{!metrics.usage_complete ? " (partial)" : ""} · {metrics.estimated_cost_usd == null ? "cost unavailable" : `~$${metrics.estimated_cost_usd.toFixed(5)}`}</summary>
    <p className="mt-1">Input: {metrics.prompt_tokens.toLocaleString()} · Visible output: {metrics.completion_tokens.toLocaleString()} · Thinking: {metrics.reasoning_tokens.toLocaleString()} · Model calls: {metrics.call_count}</p>
    <p>Response time includes Evren processing. Summed model-call time: {metrics.llm_call_seconds.toFixed(2)}s (calls may overlap).</p>
    <p>Estimated generation cost, excluding embeddings and evaluation. Rates dated {metrics.pricing_date}; Flash 3.8 introductory rates end December 31, 2026.</p>
    <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify(metrics.calls, null, 2)}</pre>
  </details>;
}
