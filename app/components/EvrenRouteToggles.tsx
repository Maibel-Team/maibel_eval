export function EvrenRouteToggles({ disableP0, disableP1, onP0Change, onP1Change, disabled }: {
  disableP0: boolean; disableP1: boolean;
  onP0Change: (value: boolean) => void; onP1Change: (value: boolean) => void;
  disabled?: boolean;
}) {
  return <fieldset className="mt-4 rounded-lg border border-stone-200 p-3" disabled={disabled}>
    <legend className="px-1 text-sm font-medium text-stone-700">Eval P0/P1 configuration</legend>
    <div className="flex flex-wrap gap-3">
      {([
        ["Disable P0", disableP0, onP0Change],
        ["Disable P1", disableP1, onP1Change],
      ] as const).map(([label, checked, onChange]) =>
        <button key={label} type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
          className={`rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${checked ? "border-amber-600 bg-amber-100 text-amber-950" : "border-stone-300 bg-white text-stone-700"}`}>
          {label}: {checked ? "On" : "Off"}
        </button>)}
    </div>
    <p className="mt-2 text-xs text-stone-600">P0: {disableP0 ? "disabled" : "enabled"} · P1: {disableP1 ? "disabled" : "enabled"}. Applies only to this eval version.</p>
    <p className="mt-1 text-xs text-stone-500">P0 controls the safety-classifier path. P1 controls distress, withdrawal and warm-hold replies. Turn both switches on to bypass both layers.</p>
  </fieldset>;
}
