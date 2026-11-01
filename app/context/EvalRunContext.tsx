"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

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

function showCompletionNotification() {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  try {
    if (Notification.permission === "granted") {
      new Notification("Evaluation complete", {
        body: "All test cases finished. Session ready to view.",
        icon: "/favicon.ico",
      });
    }
  } catch {
    /* ignore */
  }
}

export type EvalProgress = {
  stage: string;
  index?: number;
  total?: number;
  test_case_id?: string;
  message?: string;
};

export type EvalRunState = {
  sessionId: string | null;
  total: number;
  progress: EvalProgress | null;
  loading: boolean;
  completed: boolean;
  error: string | null;
};

const initialState: EvalRunState = {
  sessionId: null,
  total: 0,
  progress: null,
  loading: false,
  completed: false,
  error: null,
};

type EvalRunContextValue = {
  runState: EvalRunState;
  startRun: (params: {
    evren_model_api_url: string;
    evren_flash_model?: string;
    disable_p0?: boolean;
    disable_p1?: boolean;
    mode: "single" | "comparison";
    run_count: number;
    model_name?: string;
    summarizer_model?: string;
  }) => Promise<void>;
  cancelRun: () => void;
  clearRunState: () => void;
};

const EvalRunContext = createContext<EvalRunContextValue | null>(null);

export function EvalRunProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [runState, setRunState] = useState<EvalRunState>(initialState);
  const abortControllerRef = useRef<AbortController | null>(null);

  const clearRunState = useCallback(() => {
    setRunState(initialState);
  }, []);

  const cancelRun = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const startRun = useCallback(
    async (params: {
      evren_model_api_url: string;
      evren_flash_model?: string;
      disable_p0?: boolean;
      disable_p1?: boolean;
      mode: "single" | "comparison";
      run_count: number;
      model_name?: string;
      summarizer_model?: string;
    }) => {
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      setRunState({
        ...initialState,
        loading: true,
      });

      try {
        const res = await fetch("/api/evaluate/run/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            evren_model_api_url: params.evren_model_api_url.trim(),
            evren_flash_model: params.evren_flash_model,
            disable_p0: params.disable_p0 ?? false,
            disable_p1: params.disable_p1 ?? false,
            mode: params.mode,
            run_count: params.run_count,
            model_name: params.model_name || undefined,
            summarizer_model: params.summarizer_model || undefined,
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({})) as { error?: string; code?: string; status?: number };
          const msg = data.error ?? `Request failed (${res.status})`;
          const code = data.code ? ` [${data.code}]` : "";
          const status = data.status ?? res.status;
          setRunState((prev) => ({
            ...prev,
            loading: false,
            error: `${msg} (${status})${code}`,
          }));
          return;
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) {
          setRunState((prev) => ({
            ...prev,
            loading: false,
            error: "No response body",
          }));
          return;
        }

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
                test_session_id?: string;
                error?: string;
              };
              if (data.type === "progress" && data.stage != null) {
                const stage = data.stage;
                setRunState((prev) => ({
                  ...prev,
                  sessionId: data.test_session_id ?? prev.sessionId,
                  total: data.total ?? prev.total,
                  progress: {
                    stage,
                    index: data.index,
                    total: data.total,
                    test_case_id: data.test_case_id,
                    message: data.message,
                  },
                }));
              } else if (data.type === "complete" && data.test_session_id) {
                playCompletionSound();
                showCompletionNotification();
                setRunState({
                  ...initialState,
                  loading: false,
                  completed: true,
                  sessionId: data.test_session_id,
                });
                router.push(`/sessions/${data.test_session_id}`);
                return;
              } else if (data.type === "error" && data.error) {
                setRunState((prev) => ({
                  ...prev,
                  loading: false,
                  error: data.error ?? null,
                  progress: null,
                }));
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          setRunState(initialState);
        } else {
          setRunState((prev) => ({
            ...prev,
            loading: false,
            error: e instanceof Error ? e.message : "Something went wrong",
            progress: null,
          }));
        }
      } finally {
        abortControllerRef.current = null;
      }
    },
    [router]
  );

  const value: EvalRunContextValue = {
    runState,
    startRun,
    cancelRun,
    clearRunState,
  };

  return (
    <EvalRunContext.Provider value={value}>{children}</EvalRunContext.Provider>
  );
}

export function useEvalRun() {
  const ctx = useContext(EvalRunContext);
  if (!ctx) throw new Error("useEvalRun must be used within EvalRunProvider");
  return ctx;
}
