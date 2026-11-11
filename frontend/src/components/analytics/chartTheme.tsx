import type { ReactNode } from 'react'
import { RISK_HEX } from '@/lib/risk'
import {
  CAUTION_HEX,
  CONSOLE_HEX,
  HAZARD_HEX,
  rgbOf,
} from '@/lib/consoleInk'

/**
 * One chart system for every chart on the Analytics screen.
 *
 * The palette rule from the design direction carries into the charts unchanged:
 * saturated colour means hazard. So series that are *not* risk-encoded get a
 * monochrome ramp drawn from the chrome tones, and only risk-encoded marks are
 * allowed the hazard triad. This is why the timeline is bone-and-grey while the
 * histogram is red/ochre/green — the second one is encoding risk, the first isn't.
 */

/**
 * Every value here is read from the shared console palette rather than typed
 * out again. The chart axis ticks are real text rendered by Recharts and were
 * holding their own copy of `paper-faint` — so when the palette was corrected
 * for contrast the ticks kept the old #5C6873 and stayed at 2.36:1. A chart
 * whose labels cannot be read is a chart that cannot be audited.
 */
export const CHART_INK = CONSOLE_HEX.inkDeep
export const CHART_GRID = CONSOLE_HEX.rule
export const CHART_AXIS = CONSOLE_HEX.paperFaint
export const CHART_LABEL = CONSOLE_HEX.paperDim

/**
 * Monochrome series ramp for non-risk data, brightest first.
 *
 * Four steps is the ceiling — beyond that the greys stop being distinguishable and
 * the chart needs direct labels or small multiples instead of more colours.
 */
export const NEUTRAL_SERIES = [
  CONSOLE_HEX.paper,
  CONSOLE_HEX.paperDim,
  CONSOLE_HEX.paperFaint,
  CONSOLE_HEX.ruleBright,
] as const

/** Shared Recharts axis props, so no chart hand-rolls its own tick styling. */
export const axisProps = {
  stroke: CHART_AXIS,
  strokeWidth: 1,
  tick: { fill: CHART_LABEL, fontSize: 10, fontFamily: 'IBM Plex Mono, monospace' },
  tickLine: { stroke: CHART_AXIS },
} as const

export const gridProps = {
  stroke: CHART_GRID,
  strokeDasharray: '2 4',
  vertical: false,
} as const

/**
 * Sequential ramp for hazard density: cold ink → field ochre → marker red.
 *
 * Risk-encoded, so it is allowed saturation. Interpolated in plain RGB, which is
 * good enough across a three-stop ramp this short and keeps the ramp readable
 * against the dark ground at every step.
 */
export function densityColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  if (clamped <= 0.001) return CONSOLE_HEX.inkRaised
  const stops: Array<[number, [number, number, number]]> = [
    [0, rgbOf(CONSOLE_HEX.inkRaised)],
    [0.45, rgbOf(CAUTION_HEX)],
    [1, rgbOf(HAZARD_HEX)],
  ]
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i - 1]!
    const [p2, c2] = stops[i]!
    if (clamped <= p2) {
      const local = (clamped - p1) / (p2 - p1)
      const mix = c1.map((v, j) => Math.round(v + (c2[j]! - v) * local))
      return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`
    }
  }
  return RISK_HEX.hazard
}

/**
 * ChartFrame — the plate every chart sits on.
 *
 * Carries the title, an optional note, and the height. Charts get a stated height
 * rather than an aspect ratio because they sit in a grid alongside each other and
 * ragged heights read as sloppy.
 */
export function ChartFrame({
  title,
  note,
  children,
  height = 190,
  aside,
}: {
  title: string
  /** One line saying what to read from the chart, or what it can't tell you. */
  note?: string
  children: ReactNode
  height?: number
  aside?: ReactNode
}) {
  return (
    <section className="border border-rule bg-ink-raised">
      <header className="flex h-8 items-center justify-between gap-2 border-b border-rule px-3">
        <h3 className="eyebrow truncate">{title}</h3>
        {aside}
      </header>
      <div className="p-2" style={{ height }}>
        {children}
      </div>
      {note && (
        <p className="border-t border-rule px-3 py-1.5 text-tiny leading-snug text-paper-faint">
          {note}
        </p>
      )}
    </section>
  )
}

/**
 * Tooltip styled into the system. Recharts' default is a white box, which would be
 * the brightest thing on the screen and break the palette.
 */
export function ChartTooltip({
  active,
  label,
  rows,
}: {
  active?: boolean
  label?: ReactNode
  rows: Array<{ label: string; value: ReactNode; color?: string }>
}) {
  if (!active) return null
  return (
    <div className="border border-rule-bright bg-ink-deep/95 px-2 py-1.5">
      {label != null && (
        <p className="mb-1 font-mono text-tiny uppercase tracking-[0.08em] text-paper-dim">
          {label}
        </p>
      )}
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline gap-2">
          {r.color && <span className="h-1.5 w-1.5 shrink-0" style={{ background: r.color }} />}
          <span className="flex-1 text-tiny text-paper-dim">{r.label}</span>
          <span className="font-mono text-small tabular text-paper">{r.value}</span>
        </div>
      ))}
    </div>
  )
}
