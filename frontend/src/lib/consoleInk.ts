/**
 * Console inks — the chrome and semantic tokens as literals.
 *
 * The sibling of `printInk.ts`, for the dark console instead of the cream sheet.
 * A Tailwind class cannot reach an SVG `fill`, a Leaflet `strokeColor`, or a
 * Recharts `stroke` prop, so those surfaces need the palette in JavaScript.
 *
 * This module exists because the palette had already drifted. `chartTheme.tsx`
 * held its own copy of `paper-faint` (#5C6873) and `paper-dim` (#8C97A1), so
 * when the tokens were corrected for contrast the chart axis ticks silently kept
 * the old, unreadable greys — chart labels are real text and were failing the
 * same 2.36:1 test as everything else. `CoverageHatchLayer` and `LayerToggles`
 * had a third and fourth copy of the hazard red. Four undeclared copies of one
 * colour is how the tower markings on the map stop matching the badge in the
 * dock.
 *
 * These MUST stay in step with `theme.extend.colors` in `tailwind.config.ts`.
 * They are the same list expressed twice, because Tailwind cannot export its
 * config to runtime. If you change one, change both.
 *
 * Contrast, measured on the four chrome surfaces (ink / ink-deep / ink-raised /
 * ink-hover): every value below meets at least 3:1 as a mark, and every value
 * used for TEXT meets 4.5:1. `HAZARD_HEX` is deliberately the mark-only red —
 * see `HAZARD_TEXT_HEX`.
 */
export const CONSOLE_HEX = {
  ink: '#131A21',
  inkDeep: '#0E141A',
  inkRaised: '#1B2530',
  inkHover: '#22303D',
  rule: '#2C3A47',
  ruleBright: '#3E5060',
  paper: '#E8E4DA',
  paperDim: '#A9B3BD',
  paperFaint: '#8A97A2',
} as const

/**
 * The hazard red as a MARK — status dots, coverage ticks, meter segments, map
 * borders. 3.01:1 at worst, which is the graphics threshold.
 *
 * Do not use this for text. It reads at 2.7:1 on a hovered panel, so a label
 * painted in it is a label the operator cannot read. Use `HAZARD_TEXT_HEX`.
 */
export const HAZARD_HEX = '#DC3840'

/**
 * The hazard red as TEXT. A lighter tint of the same hue, because no red that
 * still reads as alarm reaches 4.5:1 for type without being lightened past
 * recognition. 4.52:1 at worst.
 */
export const HAZARD_TEXT_HEX = '#E67277'

/** Unverified / low confidence. Unchanged — it already cleared 4.5:1 on its own. */
export const CAUTION_HEX = '#C9922C'

/**
 * Cleared / safe. Nudged one shade lighter from #4E9E86, which scored 4.21 as
 * text on `ink-hover`; a single value is now safe for both a dot and a label.
 */
export const CLEARED_HEX = '#51A48B'

/**
 * A `#RRGGBB` string as an RGB triple, for colour ramps that interpolate.
 *
 * `densityColor` mixes between stops channel by channel, so it needs numbers
 * rather than hex. Deriving them from the declared tokens means the ramp's ends
 * follow the palette instead of being the third place the hazard red is written
 * down.
 */
export function rgbOf(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}