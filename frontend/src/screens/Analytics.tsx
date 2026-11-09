import { useMemo } from 'react'
import { useMission } from '@/components/shell/missionContext'
import { MISSION } from '@/lib/mockData'
import {
  classTallies,
  confidenceHistogram,
  riskCells,
  summaryStats,
  timeline,
  uncoveredWithDetections,
} from '@/lib/analytics'
import { countByReview } from '@/hooks/useDetections'
import { formatArea, formatDuration } from '@/lib/geo'
import { formatConfidence } from '@/lib/risk'
import { StatTile } from '@/components/analytics/StatTile'
import {
  ClassBreakdown,
  ConfidenceHistogram,
  DetectionsOverTime,
} from '@/components/analytics/Charts'
import { RiskHeatmap } from '@/components/analytics/RiskHeatmap'

/**
 * Analytics — what the mission has actually produced.
 *
 * Ordered as an argument rather than a grid of whatever we could plot: the tiles
 * state the outcome, the timeline shows how it accumulated, the histogram shows
 * how trustworthy it is, and the heatmap shows where it is. The caveat strip at the
 * bottom is part of the screen, not a disclaimer bolted on — every number here has
 * a real limit and stating them is what makes the rest usable.
 */
export function Analytics() {
  const mission = useMission()
  const detections = mission?.detections ?? []
  const progress = mission?.progress ?? null

  const stats = useMemo(() => summaryStats(detections, progress), [detections, progress])
  const time = useMemo(() => timeline(detections, progress), [detections, progress])
  const hist = useMemo(() => confidenceHistogram(detections), [detections])
  const classes = useMemo(() => classTallies(detections), [detections])
  const cells = useMemo(() => riskCells(detections, MISSION.grid), [detections])
  const gaps = useMemo(() => uncoveredWithDetections(detections, progress), [detections, progress])
  const review = countByReview(detections)

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-3 py-2">
        <h1 className="font-display text-[15px] uppercase tracking-[0.12em] text-paper">
          Analytics
        </h1>
        <p className="font-mono text-[11px] text-paper-dim">
          {MISSION.name} · {formatDuration(progress?.elapsedS ?? 0)} elapsed
        </p>
      </header>

      <div className="space-y-2 p-2">
        {/* The outcome, in four numbers. */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatTile
            label="Hazards"
            value={stats.hazards}
            risk="hazard"
            sub={`${review.confirmed} confirmed by a reviewer`}
          />
          <StatTile
            label="Awaiting review"
            value={stats.unreviewed}
            risk={stats.unreviewed > 0 ? 'caution' : 'cleared'}
            sub={
              detections.length > 0
                ? `${Math.round((stats.unreviewed / detections.length) * 100)}% of the queue`
                : 'Queue is empty'
            }
          />
          <StatTile
            label="Area surveyed"
            value={formatArea(progress?.areaSurveyedM2 ?? 0)}
            sub={`${progress?.coveragePct ?? 0}% of the block`}
          />
          <StatTile
            label="Detection density"
            value={stats.perHectare}
            unit="/ ha"
            decimals={1}
            sub={`${detections.length} across ${stats.hectares.toFixed(2)} ha imaged`}
          />
        </div>

        {/* How it accumulated, and how trustworthy it is. */}
        <div className="grid gap-2 lg:grid-cols-2">
          <DetectionsOverTime data={time} />
          <ConfidenceHistogram data={hist} />
        </div>

        {/* Where it is, and what kind. */}
        <div className="grid gap-2 lg:grid-cols-[1.4fr_1fr]">
          <RiskHeatmap
            cells={cells}
            grid={MISSION.grid}
            coveredCells={progress?.coveredCells ?? []}
          />
          <ClassBreakdown data={classes} />
        </div>

        {/* Caveats. Part of the analysis, not a footnote. */}
        <section className="border border-rule bg-ink-raised">
          <header className="flex h-8 items-center border-b border-rule px-3">
            <h3 className="eyebrow">Reading these numbers</h3>
          </header>
          <ul className="space-y-1.5 p-3 text-[11px] leading-relaxed text-paper-dim">
            <li className="flex gap-2">
              <span className="text-paper-faint">—</span>
              <span>
                Mean confidence is {formatConfidence(stats.meanConfidence)}, and{' '}
                {stats.belowThreshold} detections fall under the review threshold. Low
                confidence is not evidence of safety; those are the hits most in need of
                a human look.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-paper-faint">—</span>
              <span>
                Coverage measures ground <em className="not-italic text-paper">imaged</em>,
                never ground cleared. {100 - (progress?.coveragePct ?? 0)}% of the block has
                not been flown, and nothing here says anything about it.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="text-paper-faint">—</span>
              <span>
                RGB imagery detects surface indicators only. A cell with zero detections
                may still hold buried ordnance, which this system cannot see.
              </span>
            </li>
            {gaps.length > 0 && (
              <li className="flex gap-2 text-caution">
                <span>—</span>
                <span>
                  {gaps.length} cell{gaps.length > 1 ? 's' : ''} hold detections but are not
                  marked surveyed ({gaps.join(', ')}). Expect this while the drone is still
                  mid-pass over them.
                </span>
              </li>
            )}
            <li className="flex gap-2 text-caution">
              <span>—</span>
              <span>
                Every figure on this screen is derived from simulated detections. None of it
                reflects a real survey.
              </span>
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
