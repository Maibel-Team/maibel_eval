"use client";

import { useState, useEffect } from "react";
import { EvrenModelSelect } from "@/app/components/EvrenModelSelect";
import { PageHeader } from "@/app/components/PageHeader";
import { useEvalRun } from "@/app/context/EvalRunContext";
import { DEFAULT_EVAL_LLM_MODEL } from "@/lib/eval-llm-defaults";

/** On Vercel, set NEXT_PUBLIC_EVREN_API_URL to your deployed Evren service URL. */
const FALLBACK_EVREN_URL = process.env.NEXT_PUBLIC_EVREN_API_URL || "http://localhost:8000";
const FALLBACK_EVALUATOR_MODEL = DEFAULT_EVAL_LLM_MODEL;
const FALLBACK_SUMMARIZER_MODEL = DEFAULT_EVAL_LLM_MODEL;

function requestNotificationPermission() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

type SessionMode = "single" | "comparison";

export default function Home() {
  const { runState, startRun, cancelRun, clearRunState } = useEvalRun();
  const [evrenUrl, setEvrenUrl] = useState(FALLBACK_EVREN_URL);
  const mode: SessionMode = "comparison";
  const [evrenFlashModel, setEvrenFlashModel] = useState("gemini-2.5-flash");
  const [runCount, setRunCount] = useState(1);
  const [evaluatorModel, setEvaluatorModel] = useState(FALLBACK_EVALUATOR_MODEL);
  const [summarizerModel, setSummarizerModel] = useState(FALLBACK_SUMMARIZER_MODEL);

  useEffect(() => {
    fetch("/api/default-settings")
      .then((r) => r.json())
      .then((data) => {
        if (data.error) return;
        setEvrenUrl(data.evren_api_url ?? FALLBACK_EVREN_URL);
        setEvaluatorModel(data.evaluator_model ?? FALLBACK_EVALUATOR_MODEL);
        setSummarizerModel(data.summarizer_model ?? FALLBACK_SUMMARIZER_MODEL);
      });
  }, []);

  // When returning to home after a completed run, clear so form shows again
  useEffect(() => {
    if (runState.completed) clearRunState();
  }, [runState.completed, clearRunState]);

  const loading = runState.loading;
  const progress = runState.progress;
  const error = runState.error;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    requestNotificationPermission();
    startRun({
      evren_model_api_url: evrenUrl.trim(),
      evren_flash_model: evrenFlashModel,
      mode,
      run_count: Math.max(1, Math.floor(runCount || 1)),
      model_name: undefined,
      summarizer_model: undefined,
    });
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Run evaluation"
        description="Runs all test cases from the database: Evren → LLM evaluator (Claude Haiku 4.5 by default). Results are saved to a new session."
      />
      <form onSubmit={handleSubmit} className="mt-8 rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-stone-700">Evren API URL *</label>
          <input
            type="url"
            required
            value={evrenUrl}
            onChange={(e) => setEvrenUrl(e.target.value)}
            placeholder="http://localhost:8000"
            className="mt-1.5 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
          />
        </div>
        <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-700">
          Mode: <span className="font-medium text-stone-900">Version Comparison</span> (single mode is disabled)
        </div>
        <EvrenModelSelect value={evrenFlashModel} onChange={setEvrenFlashModel} disabled={loading} />
        <div className="mt-4">
          <label className="block text-sm font-medium text-stone-700">Runs per case</label>
          <input
            type="number"
            min={1}
            step={1}
            value={runCount}
            onChange={(e) => setRunCount(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            className="mt-1.5 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-stone-900 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
          />
        </div>
        {false && mode === "single" && (
          <>
            <div className="mt-4">
              <label className="block text-sm font-medium text-stone-700">Evaluator model</label>
              <input
                type="text"
                value={evaluatorModel}
                onChange={(e) => setEvaluatorModel(e.target.value)}
                placeholder={DEFAULT_EVAL_LLM_MODEL}
                className="mt-1.5 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
            </div>
            <div className="mt-4">
              <label className="block text-sm font-medium text-stone-700">Summarizer model</label>
              <input
                type="text"
                value={summarizerModel}
                onChange={(e) => setSummarizerModel(e.target.value)}
                placeholder={DEFAULT_EVAL_LLM_MODEL}
                className="mt-1.5 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5 text-stone-900 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-1 focus:ring-stone-400"
              />
            </div>
          </>
        )}
        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            {error}
          </div>
        )}
        {loading && progress && (
          <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700">
            <div className="font-medium text-stone-800">
              {progress.message ?? progress.stage}
            </div>
            <div className="mt-1 text-stone-600">
              {progress.total != null && progress.index != null && (
                <span>Test case {progress.stage === "done" ? progress.index : (progress.index + 1)} of {progress.total}</span>
              )}
              {progress.test_case_id && (
                <span className={progress.total != null ? " ml-1" : ""}>— {progress.test_case_id}</span>
              )}
            </div>
          </div>
        )}
        <div className="mt-6 flex gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-stone-800 disabled:opacity-50"
          >
            {loading ? "Running…" : "Run evaluation"}
          </button>
          {loading && (
            <button
              type="button"
              onClick={cancelRun}
              className="rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-sm font-medium text-stone-700 shadow-sm hover:bg-stone-50"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
