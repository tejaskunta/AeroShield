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
    <label className="flex cursor-pointer select-none items-center gap-2 py-0.5 text-small text-paper-dim hover:text-paper">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        className={`grid h-3 w-3 shrink-0 place-items-center border transition-colors ${
          /* `paper-faint`, not `rule-bright`: an unchecked box has no inner mark,
             so its border is the only thing identifying the control. WCAG 1.4.11
             asks 3:1 of that, and `rule-bright` gave 1.62 — the switch was nearly
             invisible until hovered. The decorative hairlines elsewhere stay on
             `rule`, where the non-text exemption genuinely applies. */
          checked ? 'border-paper-dim bg-paper' : 'border-paper-faint bg-transparent'
        } peer-focus-visible:ring-2 peer-focus-visible:ring-paper/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-ink`}
        aria-hidden
      >
        {checked && <span className="h-1 w-1 bg-ink" />}
      </span>
      {swatch}
      <span className="font-mono uppercase tracking-[0.06em]">{label}</span>
    </label>
  )
}
