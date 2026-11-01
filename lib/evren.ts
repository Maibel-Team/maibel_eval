import type { TestCase, EvrenOutput, RouteTrace } from "./types";

/** Path for the Evren eval endpoint (POST /evren-eval). */
const EVREN_EVAL_PATH = "/evren-eval";

/** Server-side Evren auth: `EVREN_API_KEY` → `x-api-key`; optional `EVREN_AUTHORIZATION` (e.g. `Bearer <token>`) for Cloud Run / OIDC. */
function applyEvrenAuthHeaders(headers: Record<string, string>): void {
  const key = process.env.EVREN_API_KEY?.trim();
  if (key) headers["x-api-key"] = key;
  const authorization = process.env.EVREN_AUTHORIZATION?.trim();
  if (authorization) headers["Authorization"] = authorization;
}

function evrenBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  url = url.replace(/\/\/localhost([:\/])/g, "//127.0.0.1$1");
  url = url.replace(/\/\/localhost$/, "//127.0.0.1");
  const parsed = new URL(url);
  if (parsed.pathname === EVREN_EVAL_PATH) {
    parsed.pathname = "/";
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** Build the Evren API endpoint URL. Replaces localhost with 127.0.0.1 to avoid IPv6 issues.
 *  If the base URL has no path, appends EVREN_EVAL_PATH. */
function evrenEndpoint(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  url = url.replace(/\/\/localhost([:\/])/g, "//127.0.0.1$1");
  url = url.replace(/\/\/localhost$/, "//127.0.0.1");
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (!path || path === "/") {
    parsed.pathname = EVREN_EVAL_PATH;
    return parsed.toString();
  }
  return url;
}

function formatEvrenCodeSource(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim().slice(0, 1000) || null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const branch = typeof obj.branch === "string" ? obj.branch.trim() : "";
  const commitShort =
    typeof obj.commit_short === "string"
      ? obj.commit_short.trim()
      : typeof obj.git_commit_short === "string"
        ? obj.git_commit_short.trim()
        : "";
  const commitSha =
    typeof obj.commit_sha === "string"
      ? obj.commit_sha.trim()
      : typeof obj.git_commit_sha === "string"
        ? obj.git_commit_sha.trim()
        : "";
  const image = typeof obj.image === "string" ? obj.image.trim() : typeof obj.image_tag === "string" ? obj.image_tag.trim() : "";
  const buildId = typeof obj.build_id === "string" ? obj.build_id.trim() : "";

  const shortSha = commitShort || (commitSha ? commitSha.slice(0, 7) : "");
  const head = branch && shortSha ? `${branch} @ ${shortSha}` : shortSha || branch;
  const extras = [image, buildId].filter(Boolean);
  const full = [head, ...extras].filter(Boolean).join(" · ");
  return full.trim().slice(0, 1000) || null;
}

export type EvrenCodeSource = {
  /** Human-readable code provenance string (e.g. "staging @ abc1234"). */
  text: string;
  /** Raw payload from Evren (object or string). */
  raw: unknown;
};

function parseEvrenCodeSourceFromResponse(data: unknown): EvrenCodeSource | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Record<string, unknown>;
  const raw = obj.code_source ?? obj.codeSource ?? null;
  const text = formatEvrenCodeSource(raw);
  if (!text) return null;
  return { text, raw };
}

/**
 * Fetch Evren's own code provenance from its API (best-effort).
 * Expected response: { code_source: string | { branch, commit_sha/short, image, build_id, ... } }
 * Never throws — returns null when unavailable.
 */
export async function fetchEvrenCodeSource(evrenModelApiUrl: string): Promise<string | null> {
  const base = evrenBaseUrl(evrenModelApiUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  applyEvrenAuthHeaders(headers);

  const overridePath = process.env.EVREN_META_PATH?.trim();
  const candidates = [
    overridePath ? `${base}${overridePath.startsWith("/") ? "" : "/"}${overridePath}` : null,
    `${base}/meta`,
    `${base}/metadata`,
    `${base}/provenance`,
    `${base}/info`,
  ].filter((x): x is string => Boolean(x));

  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) continue;
      const data = (await res.json().catch(() => null)) as any;
      const direct = formatEvrenCodeSource(data?.code_source ?? data?.codeSource ?? null);
      if (direct) return direct;
      // Some implementations may inline fields at top-level.
      const topLevel = formatEvrenCodeSource(data);
      if (topLevel) return topLevel;
    } catch {
      /* ignore and try next candidate */
    }
  }
  return null;
}

/**
 * Call Evren eval API (POST /evren-eval) and return outputs plus optional code source metadata.
 * Request body: always `{ messages: string[] }`, plus any keys from `testCase.eval_context`
 * (e.g. `temporal_context`, `memory_context`) merged in. `recent_texts` is auto-filled from
 * `messages` unless already set in eval_context. Never put `messages` inside eval_context.
 * Response shape is backwards-compatible: { evren_responses, code_source? }.
 */
export async function callEvrenApiWithMeta(
  evrenModelApiUrl: string,
  testCase: TestCase,
  flashModel?: string,
  routeControls?: { disable_p0: boolean; disable_p1: boolean }
): Promise<{ outputs: EvrenOutput[]; codeSource: EvrenCodeSource | null; requestDurationSeconds?: number; evalUserId?: string | null }> {
  const messages: string[] =
    testCase.type === "multi_turn" && Array.isArray(testCase.turns) && testCase.turns.length > 0
      ? testCase.turns.map((s) => String(s ?? "").trim()).filter(Boolean)
      : [testCase.input_message?.trim() ?? ""].filter(Boolean);

  if (messages.length === 0) {
    return { outputs: [{ evren_response: "", detected_states: "" }], codeSource: null };
  }

  const body: Record<string, unknown> = { messages };

  const extras = testCase.eval_context;
  if (extras && typeof extras === "object" && !Array.isArray(extras)) {
    for (const [key, value] of Object.entries(extras)) {
      if (key === "messages") continue;
      body[key] = value;
    }
  }

  // Helps orchestrator BUG-029 / continuity when the harness only sends user strings.
  if (messages.length > 0 && !("recent_texts" in body)) {
    body.recent_texts = messages
      .map((m, i) => `[user ${i + 1}/${messages.length}] ${m}`)
      .join("\n");
  }

  if (flashModel) body.flash_model = flashModel;
  // Test-case extras must not override the selected run configuration.
  body.disable_p0 = routeControls?.disable_p0 ?? false;
  body.disable_p1 = routeControls?.disable_p1 ?? false;
  const url = evrenEndpoint(evrenModelApiUrl);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  applyEvrenAuthHeaders(headers);

  const hasKey = Boolean(process.env.EVREN_API_KEY?.trim());
  const hasAuthz = Boolean(process.env.EVREN_AUTHORIZATION?.trim());
  console.log("[Evren API] request", {
    url,
    messages,
    messageCount: messages.length,
    evrenAuth: { xApiKey: hasKey ? "set" : "missing", authorization: hasAuthz ? "set" : "missing" },
  });
  const started = performance.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (fetchErr) {
    const cause = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const details =
      fetchErr instanceof Error && "cause" in fetchErr && fetchErr.cause instanceof Error
        ? ` (${fetchErr.cause.message})`
        : "";
    throw new Error(`Evren request to ${url} failed: ${cause}${details}`);
  }

  if (!res.ok) {
    const text = await res.text();
    const base = `Evren API error: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`;
    if (res.status === 403) {
      throw new Error(
        `${base} If this is Google “Forbidden / permission to get URL”, check EVREN_API_KEY (exact name in .env.local), optional EVREN_AUTHORIZATION for Bearer/OIDC, restart \`next dev\` after env changes, and with Evren owners: unauthenticated/authorized invoker vs IAP.`
      );
    }
    throw new Error(base);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const evrenResponses = data.evren_responses as Array<{
    response?: string | string[];
    detected_flags?: string;
    route_trace?: RouteTrace | null;
    metrics?: EvrenOutput["metrics"];
  }> | undefined;
  const codeSource = parseEvrenCodeSourceFromResponse(data);

  console.log("[Evren API] raw response:", JSON.stringify(data, null, 2));

  if (!Array.isArray(evrenResponses)) {
    if (flashModel) throw new Error("Evren returned no conversation. Check the eval backend.");
    return { outputs: [{ evren_response: "", detected_states: "" }], codeSource };
  }

  if (flashModel && evrenResponses.length !== messages.length) {
    throw new Error("Evren returned incomplete turns. Do not score this run.");
  }
  if (flashModel && evrenResponses.some((item) => item.metrics?.flash_model !== flashModel)) {
    throw new Error("Evren backend did not confirm the requested model and metrics. Check the eval deployment before running.");
  }
  if (routeControls && evrenResponses.some((item) =>
    item.metrics?.route_controls_version !== 1 ||
    item.metrics?.disable_p0 !== routeControls.disable_p0 ||
    item.metrics?.disable_p1 !== routeControls.disable_p1
  )) {
    throw new Error("Evren backend did not confirm the requested P0/P1 configuration. Check the eval deployment before running.");
  }
  const outputs = evrenResponses.map((item) => ({
    evren_response: item?.response ?? "",
    detected_states: String(item?.detected_flags ?? ""),
    route_trace: item?.route_trace ?? null,
    metrics: item?.metrics ?? null,
  }));
  return { outputs, codeSource, requestDurationSeconds: (performance.now() - started) / 1000,
    evalUserId: typeof data.eval_user_id === "string" ? data.eval_user_id : null };
}

/**
 * Call Evren eval API (POST /evren-eval).
 * Request: { messages: string[] } — ordered list of user messages.
 * Response: { evren_responses: [{ response, detected_flags }, ...] } — one per message.
 * Single-turn = messages of length 1; multi-turn = multiple messages. One API call for both.
 */
export async function callEvrenApi(
  evrenModelApiUrl: string,
  testCase: TestCase
): Promise<EvrenOutput[]> {
  const { outputs } = await callEvrenApiWithMeta(evrenModelApiUrl, testCase);
  return outputs;
}
