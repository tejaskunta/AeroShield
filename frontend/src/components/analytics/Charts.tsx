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
import type { ClassTally, ConfidenceBucket, TimeBucket } from '@/types'
import { HAZARD_THRESHOLD, REVIEW_THRESHOLD, RISK_HEX } from '@/lib/risk'
import { CLASS_LABELS } from '@/types'
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
      note="Bars count detections per minute — total, with confirmed hazards alongside. The dashed line is cumulative coverage. Coverage history is interpolated; the simulator does not log it per tick."
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
      note={`${middleBand} of ${total} detections sit between the review and hazard thresholds. That band is the review workload — neither auto-cleared nor auto-escalated.`}
      aside={
        <span className="font-mono text-[10px] text-paper-faint">
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
 * ClassBreakdown — horizontal bars, not a pie.
 *
 * Three categories with wildly different magnitudes, and the reader's question is
 * "how many of each", which is a length comparison. A pie would make the two
 * landmine classes hard to compare against each other and impossible to read
 * exact counts from.
 */
export function ClassBreakdown({ data }: { data: ClassTally[] }) {
  const total = data.reduce((s, c) => s + c.count, 0)
  if (total === 0) return <EmptyChart title="Class breakdown" />
  const max = Math.max(...data.map((c) => c.count))

  return (
    <ChartFrame title="Class breakdown" height={190}>
      <div className="flex h-full flex-col justify-center gap-3 px-1">
        {data.map((c, i) => (
          <div key={c.class}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-paper">{CLASS_LABELS[c.class]}</span>
              <span className="font-mono text-[11px] tabular text-paper">
                {c.count}
                <span className="ml-1.5 text-paper-faint">
                  {total > 0 ? `${Math.round((c.count / total) * 100)}%` : ''}
                </span>
              </span>
            </div>
            <div className="h-2.5 bg-ink-deep">
              <div
                className="h-full transition-[width] duration-500"
                style={{
                  width: `${max > 0 ? (c.count / max) * 100 : 0}%`,
                  // debris_negative is the model's correct negative — the only
                  // class here that is genuinely a cleared outcome.
                  background:
                    c.class === 'debris_negative' ? RISK_HEX.cleared : NEUTRAL_SERIES[i],
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartFrame>
  )
}

function EmptyChart({ title }: { title: string }) {
  return (
    <ChartFrame title={title}>
      <div className="flex h-full items-center justify-center bg-chart-grid [background-size:16px_16px]">
        <p className="text-[11px] text-paper-faint">No detections to chart yet.</p>
      </div>
    </ChartFrame>
  )
}
