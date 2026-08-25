import { useState } from 'react'
import type { MissionGrid, RiskCell } from '@/types'
import { cellId } from '@/lib/geo'
import { ChartFrame, densityColor } from './chartTheme'

/**
 * RiskHeatmap — hazard density over the survey block, in the block's own shape.
 *
 * Deliberately not a generic heatmap grid: it is drawn at the mission's real
 * aspect ratio with the same `A1`-style cell references used on the map, in the
 * detection records, and over radio. That makes it directly comparable to the Live
 * Map rather than a second, differently-shaped abstraction the reader has to
 * mentally register against the first.
 *
 * Rows are flipped on render because grid row 1 is the *south* edge — north-up is
 * how every other view shows this block, and a north-down heatmap would silently
 * mirror the operator's mental map.
 */
export function RiskHeatmap({
  cells,
  grid,
  coveredCells,
}: {
  cells: RiskCell[]
  grid: MissionGrid
  coveredCells: string[]
}) {
  const [hover, setHover] = useState<RiskCell | null>(null)
  const covered = new Set(coveredCells)

  // North-up: highest row index first.
  const rows = Array.from({ length: grid.rows }, (_, i) => grid.rows - 1 - i)

  return (
    <ChartFrame
      title="Risk density by cell"
      height={218}
      note="Weighted by confidence, capped per cell. Hatched cells have not been surveyed — no detections there means no data, not no hazard."
      aside={
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[9px] text-paper-faint">low</span>
          <span className="flex h-2 w-16" aria-hidden>
            {Array.from({ length: 16 }, (_, i) => (
              <span key={i} className="flex-1" style={{ background: densityColor(i / 15) }} />
            ))}
          </span>
          <span className="font-mono text-[9px] text-paper-faint">high</span>
        </div>
      }
    >
      <div className="flex h-full gap-2">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Column letters */}
          <div className="flex pl-5">
            {Array.from({ length: grid.cols }, (_, col) => (
              <span
                key={col}
                className="flex-1 text-center font-mono text-[8px] text-paper-faint"
              >
                {String.fromCharCode(65 + col)}
              </span>
            ))}
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {rows.map((row) => (
              <div key={row} className="flex min-h-0 flex-1 items-stretch">
                <span className="w-5 shrink-0 self-center pr-1 text-right font-mono text-[8px] text-paper-faint">
                  {row + 1}
                </span>
                {Array.from({ length: grid.cols }, (_, col) => {
                  const id = cellId(col, row)
                  const cell = cells.find((c) => c.cellId === id)
                  const isCovered = covered.has(id)
                  return (
                    <button
                      key={col}
                      type="button"
                      onMouseEnter={() => setHover(cell ?? null)}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover(cell ?? null)}
                      onBlur={() => setHover(null)}
                      aria-label={`Cell ${id}: ${cell?.detections ?? 0} detections`}
                      className={`min-w-0 flex-1 border border-ink transition-colors ${
                        !isCovered ? 'bg-survey-hatch' : ''
                      }`}
                      style={
                        isCovered
                          ? { background: densityColor(cell?.density ?? 0) }
                          : undefined
                      }
                    />
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Readout for the hovered cell — a legend can't give exact counts. */}
        <div className="w-24 shrink-0 border-l border-rule pl-2">
          <p className="eyebrow">Cell</p>
          <p className="font-display text-readout tabular text-paper">
            {hover?.cellId ?? '—'}
          </p>
          <p className="mt-1.5 eyebrow">Detections</p>
          <p className="font-mono text-[13px] tabular text-paper">
            {hover ? hover.detections : '—'}
          </p>
          <p className="mt-1.5 eyebrow">Density</p>
          <p className="font-mono text-[13px] tabular text-paper">
            {hover ? hover.density.toFixed(2) : '—'}
          </p>
        </div>
      </div>
    </ChartFrame>
  )
}
