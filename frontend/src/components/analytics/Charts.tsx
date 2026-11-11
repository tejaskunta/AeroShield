import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ConfidenceBucket, ReviewProgress, ReviewState, TimeBucket } from '@/types'
import { HAZARD_SOFT_HEX, HAZARD_THRESHOLD, REVIEW_THRESHOLD, RISK_HEX } from '@/lib/risk'
import { REVIEW_LABELS } from '@/types'
import {
  ChartFrame,
  ChartTooltip,
  NEUTRAL_SERIES,
  axisProps,
  gridProps,
} from './chartTheme'

/**
 * DetectionsOverTime — arrival rate against coverage progress.
 *
 * Two encodings on one frame because the interesting reading is the *relationship*:
 * a spike in detections while coverage climbs steadily means the drone flew into a
 * dense area, not that the model got noisier. Bars for counts (discrete events),
 * a line for coverage (a continuous quantity) — the mark type matches the data type.
 *
 * Neither series is risk-encoded, so both stay monochrome.
 */
export function DetectionsOverTime({ data }: { data: TimeBucket[] }) {
  if (data.length === 0) return <EmptyChart title="Detections over time" />

  return (
    <ChartFrame
      title="Detections over time"
      note="Bars count detections per minute, with confirmed hazards alongside. The dashed line is cumulative coverage. Coverage history is interpolated; the simulator does not log it per tick."
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="minute"
            {...axisProps}
            tickFormatter={(m: number) => `${m}′`}
            interval="preserveStartEnd"
          />
          <YAxis yAxisId="count" {...axisProps} allowDecimals={false} width={34} />
          <YAxis
            yAxisId="pct"
            orientation="right"
            {...axisProps}
            domain={[0, 100]}
            width={34}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            cursor={{ fill: '#22303D', opacity: 0.5 }}
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                label={`T+${label} min`}
                rows={[
                  {
                    label: 'Detections',
                    value: payload?.[0]?.payload?.detections ?? 0,
                    color: NEUTRAL_SERIES[0],
                  },
                  {
                    label: 'Confirmed',
                    value: payload?.[0]?.payload?.confirmed ?? 0,
                    color: RISK_HEX.hazard,
                  },
                  {
                    label: 'Coverage',
                    value: `${Math.round(payload?.[0]?.payload?.coveragePct ?? 0)}%`,
                    color: NEUTRAL_SERIES[1],
                  },
                ]}
              />
            )}
          />
          <Bar yAxisId="count" dataKey="detections" fill={NEUTRAL_SERIES[2]} maxBarSize={22} />
          {/* Confirmed hazards beside the total, not stacked on it — confirmed is a
              subset of detections, so stacking would double-count. This part IS
              risk-encoded, hence the one saturated colour on the chart. */}
          <Bar yAxisId="count" dataKey="confirmed" fill={RISK_HEX.hazard} maxBarSize={22} />
          <Line
            yAxisId="pct"
            type="monotone"
            dataKey="coveragePct"
            stroke={NEUTRAL_SERIES[0]}
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="3 3"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/**
 * ConfidenceHistogram — how the queue distributes across the decision thresholds.
 *
 * The thresholds are drawn *on* the chart as reference lines, because the shape of
 * the distribution is meaningless without them: what matters is how much mass sits
 * in the ambiguous middle band, since that band is the human's actual workload.
 * Bars are risk-coloured by which band they fall in.
 */
export function ConfidenceHistogram({ data }: { data: ConfidenceBucket[] }) {
  const total = data.reduce((s, b) => s + b.count, 0)
  if (total === 0) return <EmptyChart title="Confidence distribution" />

  const middleBand = data
    .filter((b) => b.binStart >= REVIEW_THRESHOLD && b.binStart < HAZARD_THRESHOLD)
    .reduce((s, b) => s + b.count, 0)

  return (
    <ChartFrame
      title="Confidence distribution"
      note={`${middleBand} of ${total} detections sit between the review and hazard thresholds. That band is the review workload: neither auto-cleared nor auto-escalated.`}
      aside={
        <span className="font-mono text-tiny text-paper-faint">
          bins of 0.10
        </span>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="binStart"
            {...axisProps}
            tickFormatter={(v: number) => v.toFixed(1)}
          />
          <YAxis {...axisProps} allowDecimals={false} width={34} />
          <Tooltip
            cursor={{ fill: '#22303D', opacity: 0.5 }}
            content={({ active, payload }) => {
              const b = payload?.[0]?.payload as ConfidenceBucket | undefined
              return (
                <ChartTooltip
                  active={active}
                  label={
                    b ? `${b.binStart.toFixed(2)} – ${(b.binStart + 0.1).toFixed(2)}` : undefined
                  }
                  rows={[
                    {
                      label: 'Detections',
                      value: b?.count ?? 0,
                      color: b ? RISK_HEX[b.level] : undefined,
                    },
                  ]}
                />
              )
            }}
          />
          {/* The two lines that make the distribution mean something. */}
          <ReferenceLine
            x={REVIEW_THRESHOLD}
            stroke={RISK_HEX.caution}
            strokeDasharray="3 3"
            label={{
              value: 'review',
              position: 'insideTopLeft',
              fill: RISK_HEX.caution,
              fontSize: 9,
              fontFamily: 'IBM Plex Mono, monospace',
            }}
          />
          <ReferenceLine
            x={HAZARD_THRESHOLD}
            stroke={RISK_HEX.hazard}
            strokeDasharray="3 3"
            label={{
              value: 'hazard',
              position: 'insideTopRight',
              fill: RISK_HEX.hazard,
              fontSize: 9,
              fontFamily: 'IBM Plex Mono, monospace',
            }}
          />
          <Bar dataKey="count" maxBarSize={30}>
            {data.map((b) => (
              <Cell key={b.binStart} fill={RISK_HEX[b.level]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  )
}

/**
 * ReviewProgressPanel -- the mission's review backlog as one stacked meter plus a
 * legend of counts.
 *
 * This occupies the slot the class-breakdown chart used to hold. That chart had
 * nothing real to plot: the detector emits one class, so it rendered four rows
 * with three of them permanently zero and the fourth equal to the total. A panel
 * that is always 100% wide tells an operator nothing and quietly advertises a
 * capability the aircraft does not have.
 *
 * Review state is the axis that genuinely varies, and it is the one that decides
 * whether the mission is finished. A stacked single meter is used rather than
 * grouped bars because the interesting quantity is a *proportion of a fixed
 * whole* -- what fraction of these detections has a person ruled on -- and a
 * single bar makes part-to-whole legible at a glance without any axis.
 *
 * Colours: confirmed reads as hazard (a person agreed it is a mine), dismissed as
 * cleared, unreviewed as the neutral caution tone, and flagged as the recessed
 * hazard fill so it is visibly red without competing with a confirmation at small
 * sizes. Every segment also appears in the legend with a count, so colour is never
 * the only channel carrying the meaning.
 */
export function ReviewProgressPanel({ data }: { data: ReviewProgress }) {
  if (data.total === 0) {
    return (
      <ChartFrame title="Review progress" height={190}>
        <div className="flex h-full items-center justify-center">
          <p className="text-small text-paper-faint">Nothing to review yet.</p>
        </div>
      </ChartFrame>
    )
  }

  const segments: { state: ReviewState; label: string; fill: string }[] = [
    { state: 'confirmed', label: REVIEW_LABELS.confirmed, fill: RISK_HEX.hazard },
    { state: 'dismissed', label: REVIEW_LABELS.dismissed, fill: RISK_HEX.cleared },
    { state: 'flagged', label: REVIEW_LABELS.flagged, fill: HAZARD_SOFT_HEX },
    { state: 'unreviewed', label: REVIEW_LABELS.unreviewed, fill: RISK_HEX.caution },
  ]

  return (
    <ChartFrame title="Review progress" height={190}>
      <div className="flex h-full flex-col justify-center gap-4 px-1">
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="font-mono text-display leading-none tabular text-paper">
              {data.pctDecided}%
            </span>
            <span className="text-small text-paper-dim">
              {data.decided} of {data.total} ruled on
            </span>
          </div>
          <div
            className="flex h-3 overflow-hidden bg-ink-deep"
            role="img"
            aria-label={`Review progress: ${data.pctDecided} percent ruled on, ${data.remaining} still needing attention`}
          >
            {segments.map((s) => {
              const count = data.counts[s.state]
              if (count === 0) return null
              return (
                <div
                  key={s.state}
                  style={{
                    width: `${(count / data.total) * 100}%`,
                    background: s.fill,
                  }}
                />
              )
            })}
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {segments.map((s) => (
            <div key={s.state} className="flex items-center justify-between gap-2">
              <dt className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0"
                  style={{ background: s.fill }}
                />
                <span className="truncate text-small text-paper-dim">{s.label}</span>
              </dt>
              <dd className="font-mono text-small tabular text-paper">{data.counts[s.state]}</dd>
            </div>
          ))}
        </dl>

        {data.remaining > 0 && (
          <p className="text-small leading-snug text-paper-dim">
            {data.remaining === 1
              ? '1 detection still needs a decision.'
              : `${data.remaining} detections still need a decision.`}
          </p>
        )}
      </div>
    </ChartFrame>
  )
}

function EmptyChart({ title }: { title: string }) {
  return (
    <ChartFrame title={title}>
      <div className="flex h-full items-center justify-center bg-chart-grid [background-size:16px_16px]">
        <p className="text-small text-paper-faint">No detections to chart yet.</p>
      </div>
    </ChartFrame>
  )
}
