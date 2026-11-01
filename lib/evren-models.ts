export function validRouteControls(value: { disable_p0?: unknown; disable_p1?: unknown }): boolean {
  return [value.disable_p0, value.disable_p1].every((v) => v === undefined || typeof v === "boolean");
}

export const EVREN_FLASH_MODELS = ["gemini-2.5-flash", "gemini-3.8-flash"] as const;
export function isEvrenFlashModel(value: unknown): value is typeof EVREN_FLASH_MODELS[number] {
  return typeof value === "string" && EVREN_FLASH_MODELS.some((model) => model === value);
}
