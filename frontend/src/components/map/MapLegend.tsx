import type { ReactNode } from 'react'
import type { Detection } from '@/types'
import { RISK_HEX } from '@/lib/risk'
import { countByRisk } from '@/hooks/useDetections'
import { HARD_CLEARANCE_M } from '@/lib/pathfinding'

/**
 * MapLegend — what the marks mean, with live counts.
 *
 * The legend carries counts rather than just keys, so it doubles as the tally an
 * operator would otherwise have to go looking for. Shape is listed alongside
 * colour because shape is what carries meaning when colour can't.
 */
export function MapLegend({ detections }: { detections: Detection[] }) {
  const counts = countByRisk(detections)

  return (
    <div className="w-[168px] border border-rule bg-ink-deep/90 p-2 backdrop-blur-sm">
      <p className="eyebrow mb-1.5">Detections</p>

      <LegendRow
        mark={<Diamond color={RISK_HEX.hazard} />}
        label="Confirmed hazard"
        count={detections.filter((d) => d.review.state === 'confirmed').length}
      />
      <LegendRow
        mark={<Ring color={RISK_HEX.hazard} />}
        label="Likely hazard"
        count={counts.hazard - detections.filter((d) => d.review.state === 'confirmed').length}
      />
      <LegendRow
        mark={<Ring color={RISK_HEX.caution} />}
        label="Unverified"
        count={counts.caution}
      />
      <LegendRow
        mark={<SmallDot color={RISK_HEX.cleared} />}
        label="Ruled out"
        count={counts.cleared}
      />

      <div className="rule-line my-1.5" />
      <p className="text-[10px] leading-snug text-paper-faint">
        Rings show position uncertainty. Routes hold {HARD_CLEARANCE_M} m clearance.
      </p>
    </div>
  )
}

function LegendRow({
  mark,
  label,
  count,
}: {
  mark: ReactNode
  label: string
  count: number
}) {
  return (
    <div className="flex items-center gap-2 py-px">
      <span className="grid h-3.5 w-3.5 shrink-0 place-items-center">{mark}</span>
      <span className="flex-1 truncate text-[10px] text-paper-dim">{label}</span>
      <span className="font-mono text-[10px] tabular text-paper">{count}</span>
    </div>
  )
}

function Diamond({ color }: { color: string }) {
  return <span className="h-2 w-2 rotate-45" style={{ background: color }} aria-hidden />
}

function Ring({ color }: { color: string }) {
  return (
    <span
      className="h-2.5 w-2.5 rounded-full border-2"
      style={{ borderColor: color }}
      aria-hidden
    />
  )
}

function SmallDot({ color }: { color: string }) {
  return <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
}
