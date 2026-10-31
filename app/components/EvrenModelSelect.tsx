import { EVREN_FLASH_MODELS } from "@/lib/evren-models";

export function EvrenModelSelect({ value, onChange, disabled }: {
  value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  return <label className="mt-4 block text-sm font-medium text-stone-700">
    Evren Flash model
    <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}
      className="mt-1.5 block w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-stone-900">
      {EVREN_FLASH_MODELS.map((model) => <option key={model} value={model}>{model}</option>)}
    </select>
    <span className="mt-1 block text-xs font-normal text-stone-500">Changes Evren’s Flash calls, including classification. Pro stays unchanged.</span>
  </label>;
}
