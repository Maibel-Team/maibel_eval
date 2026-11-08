export const EVREN_FLASH_MODELS = ["gemini-2.5-flash", "gemini-3.8-flash"] as const;
export function isEvrenFlashModel(value: unknown): value is typeof EVREN_FLASH_MODELS[number] {
  return typeof value === "string" && EVREN_FLASH_MODELS.some((model) => model === value);
}
