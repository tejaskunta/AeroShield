import type { ReactNode } from 'react'

/**
 * Toggle — a layer switch for the map, styled as a hairlined checkbox.
 *
 * Deliberately not a sliding pill: a map layer list is a checklist, and a row of
 * pills reads as a settings screen. The swatch slot carries the layer's own colour
 * so the legend and the control are the same object.
 */
export function Toggle({
  checked,
  onChange,
  label,
  swatch,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  /** Small colour/pattern sample shown before the label. */
  swatch?: ReactNode
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2.5 py-1 text-[0.8125rem] text-paper-dim transition-colors hover:text-paper">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        className={`relative h-4 w-7 shrink-0 rounded-full border transition-colors ${
          /* `paper-faint`, not `rule-bright`: an unchecked box has no inner mark,
             so its border is the only thing identifying the control. WCAG 1.4.11
             asks 3:1 of that, and `rule-bright` gave 1.62 — the switch was nearly
             invisible until hovered. The decorative hairlines elsewhere stay on
             `rule`, where the non-text exemption genuinely applies. */
          checked ? 'border-signal/60 bg-signal/30' : 'border-paper-faint bg-transparent'
        } peer-focus-visible:ring-2 peer-focus-visible:ring-signal/80 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-ink`}
        aria-hidden
      >
        <span className={`absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-all ${checked ? 'left-[0.9rem] bg-signal' : 'left-[0.2rem] bg-paper-faint'}`} />
      </span>
      {swatch}
      <span>{label}</span>
    </label>
  )
}
