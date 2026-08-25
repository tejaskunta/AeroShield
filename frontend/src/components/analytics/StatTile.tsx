import type { ReactNode } from 'react'
import type { RiskLevel } from '@/types'
import { RISK_CLASSES } from '@/lib/risk'
import { CountUp } from '@/components/ui/StatReadout'

/**
 * StatTile — one headline number.
 *
 * The number is the largest thing in the tile and the label the smallest, because
 * a tile row is scanned for magnitudes first and identified second. `risk` tints
 * the value only when the number genuinely represents a hazard count — a tinted
 * "area surveyed" would imply danger where there is none.
 *
 * `sub` carries the number's context (a denominator, a rate, a caveat). A bare
 * count without context is how dashboards mislead: 12 detections is meaningless
 * until you know it's 12 across 4 hectares.
 */
export function StatTile({
  label,
  value,
  unit,
  sub,
  risk,
  decimals = 0,
}: {
  label: string
  value: number | string
  unit?: string
  sub?: ReactNode
  risk?: RiskLevel
  decimals?: number
}) {
  const tone = risk ? RISK_CLASSES[risk].text : 'text-paper'

  return (
    <div className="border border-rule bg-ink-raised p-2.5">
      <p className="eyebrow">{label}</p>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={`font-display text-readout-lg tabular ${tone}`}>
          {typeof value === 'number' ? <CountUp value={value} decimals={decimals} /> : value}
        </span>
        {unit && <span className="font-mono text-[11px] text-paper-dim">{unit}</span>}
      </div>
      {sub && <p className="mt-1 text-[10px] leading-snug text-paper-faint">{sub}</p>}
    </div>
  )
}
