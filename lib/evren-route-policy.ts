import type { VersionEntry } from "./db.types";
import type { EvrenMetrics } from "./types";

type RouteMetrics = Pick<EvrenMetrics,
  "route_controls_version" | "disable_p0" | "disable_p1" |
  "requested_disable_p0" | "requested_disable_p1" |
  "global_p0_enabled" | "global_p1_enabled"
>;

/** Read recorded effective settings, never infer them from a missing boolean. */
export function readRoutePolicy(metrics?: RouteMetrics | null) {
  if (!metrics || typeof metrics.disable_p0 !== "boolean" || typeof metrics.disable_p1 !== "boolean") return null;
  if (metrics.route_controls_version === 2) {
    if (
      typeof metrics.requested_disable_p0 !== "boolean" ||
      typeof metrics.requested_disable_p1 !== "boolean" ||
      typeof metrics.global_p0_enabled !== "boolean" ||
      typeof metrics.global_p1_enabled !== "boolean" ||
      metrics.disable_p0 !== (!metrics.global_p0_enabled || metrics.requested_disable_p0) ||
      metrics.disable_p1 !== (!metrics.global_p1_enabled || metrics.requested_disable_p1)
    ) return null;
  } else if (metrics.route_controls_version !== 1) {
    return null;
  }
  return { disableP0: metrics.disable_p0, disableP1: metrics.disable_p1 };
}

export function formatRoutePolicy(metrics?: RouteMetrics | null): string | null {
  const policy = readRoutePolicy(metrics);
  if (!policy) return null;
  return `Actual P0: ${policy.disableP0 ? "disabled" : "enabled"} · P1: ${policy.disableP1 ? "disabled" : "enabled"}`;
}

export function formatDisabledDetectionNote(metrics?: RouteMetrics | null): string | null {
  const policy = readRoutePolicy(metrics);
  if (!policy) return null;
  const disabled = [policy.disableP0 ? "P0" : null, policy.disableP1 ? "P1" : null].filter(Boolean);
  if (!disabled.length) return null;
  return `${disabled.join("/")} detection was disabled. Default flag values for disabled detection are not an assessment.`;
}

/** Summarize actual per-turn evidence, keeping old requested settings distinguishable. */
export function formatVersionRoutePolicy(version: VersionEntry): string {
  const turns = version.runs.flatMap((run) => run.turns);
  const labels = turns.map((turn) => formatRoutePolicy(turn.metrics));
  const recorded = labels.filter((label): label is string => label !== null);
  if (new Set(recorded).size > 1) return "Routing varies by turn";
  if (recorded.length && recorded.length === turns.length) return recorded[0];
  if (recorded.length) return "Routing: partially recorded; see turn details";
  const config = version.eval_config;
  if (config?.route_policy === "server") return "Routing: server controlled (actual settings not reported)";
  if (typeof config?.disable_p0 === "boolean" && typeof config?.disable_p1 === "boolean") {
    return `Requested P0: ${config.disable_p0 ? "disabled" : "enabled"} · P1: ${config.disable_p1 ? "disabled" : "enabled"} (actual settings not reported)`;
  }
  return "Routing: not reported";
}
