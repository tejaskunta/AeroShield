import { useMemo } from 'react'
import { useMission } from '@/components/shell/missionContext'
import { MISSION } from '@/lib/mockData'
import { HAS_LIVE_MISSION, MISSION_NAME } from '@/lib/config'
import {
  confidenceHistogram,
  reviewProgress,
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
  ConfidenceHistogram,
  CoverageOverTime,
  DetectionsOverTime,
  ReviewProgressPanel,
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
 *
 * The provenance caveat is derived, not fixed. It used to read "every figure on
 * this screen is derived from simulated detections", which was true of the keyless
 * demo and became a false alarm the moment a mission was configured: it told an
 * operator that measured results were invented. Which line is shown now follows the
 * same signal the rest of the app uses — whether the API is answering at all.
 */
export function Analytics() {
  const mission = useMission()
  const detections = mission?.detections ?? []
  const progress = mission?.progress ?? null

  const stats = useMemo(() => summaryStats(detections, progress), [detections, progress])
  const time = useMemo(() => timeline(detections, progress), [detections, progress])
  const hist = useMemo(() => confidenceHistogram(detections), [detections])
  const review = useMemo(() => reviewProgress(detections), [detections])
  const cells = useMemo(() => riskCells(detections, MISSION.grid), [detections])
  const gaps = useMemo(() => uncoveredWithDetections(detections, progress), [detections, progress])
  const byReview = countByReview(detections)

  /*
   * A live mission is one the API is answering for. A configured call-sign is not
   * enough on its own — the name can be set with no key or no backend, and
   * declaring the figures measured in that case would be the same lie in the
   * opposite direction. The rows themselves are the test: any `backend` row means
   * the aircraft's own pipeline produced at least part of this screen.
   */
  const flown = detections.some((d) => d.source === 'backend')
  const simulatedRows = detections.length - detections.filter((d) => d.source === 'backend').length

  return (
    <div className="h-full overflow-y-auto">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-6 pb-3 pt-5">
        <h1 className="text-[1.25rem] font-semibold tracking-tight text-paper">
          Analytics
        </h1>
        <p className="text-[0.8125rem] text-paper-faint">
          {HAS_LIVE_MISSION ? MISSION_NAME : MISSION.name} ·{' '}
          {formatDuration(progress?.elapsedS ?? 0)} elapsed
        </p>
      </header>

      <div className="space-y-3 px-6 pb-6">
        {/* The outcome, in four numbers. */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Hazards"
            value={stats.hazards}
            risk="hazard"
            sub={`${byReview.confirmed} confirmed by a reviewer`}
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
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          <DetectionsOverTime data={time} />
          <ConfidenceHistogram data={hist} />
          <CoverageOverTime data={time} />
        </div>

        {/* Where it is, and how much of it a person has ruled on. */}
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <RiskHeatmap
            cells={cells}
            grid={MISSION.grid}
            coveredCells={progress?.coveredCells ?? []}
          />
          <ReviewProgressPanel data={review} />
        </div>

        {/* Caveats. Part of the analysis, not a footnote. */}
        <section className="card">
          <header className="flex h-11 items-center px-4">
            <h3 className="text-[0.8125rem] font-medium text-paper-dim">Reading these numbers</h3>
          </header>
          <ul className="space-y-1.5 px-4 pb-4 text-[0.8125rem] leading-relaxed text-paper-dim">
            <li className="flex gap-2">
              <span aria-hidden className="text-paper-faint">·</span>
              <span>
                Mean confidence is {formatConfidence(stats.meanConfidence)}, and{' '}
                {stats.belowThreshold} detections fall under the review threshold. Low
                confidence is not evidence of safety; those are the hits most in need of
                a human look.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-paper-faint">·</span>
              <span>
                Coverage measures ground <em className="not-italic text-paper">imaged</em>,
                never ground cleared. {100 - (progress?.coveragePct ?? 0)}% of the block has
                not been flown, and nothing here says anything about it.
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="text-paper-faint">·</span>
              <span>
                RGB imagery detects surface indicators only. A cell with zero detections
                may still hold buried ordnance, which this system cannot see.
              </span>
            </li>
            {gaps.length > 0 && (
              <li className="flex gap-2 text-caution">
                <span aria-hidden>·</span>
                <span>
                  {gaps.length} cell{gaps.length > 1 ? 's' : ''} hold detections but are not
                  marked surveyed ({gaps.join(', ')}). Expect this while the drone is still
                  mid-pass over them.
                </span>
              </li>
            )}
            <li className={`flex gap-2 ${flown ? 'text-paper-dim' : 'text-caution'}`}>
              <span aria-hidden>·</span>
              {flown ? (
                <span>
                  The detections behind these figures came from the aircraft.{' '}
                  {simulatedRows > 0 && (
                    <>
                      {simulatedRows} of the {detections.length} rows are invented demo
                      fixtures and are counted in the totals above — filter them out in the
                      Detection Center to see the flown result alone.{' '}
                    </>
                  )}
                  Coverage and the survey grid are still the simulator's: the backend keeps
                  no per-cell record, so those two describe the planned block, not ground the
                  aircraft has imaged.
                </span>
              ) : (
                <span>
                  Every figure on this screen is derived from simulated detections. None of it
                  reflects a real survey.
                </span>
              )}
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
