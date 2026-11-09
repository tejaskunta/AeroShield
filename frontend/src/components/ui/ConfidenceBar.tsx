import type { RiskLevel } from '@/types'
import { RISK_CLASSES, formatConfidence, riskOfConfidence, HAZARD_THRESHOLD, REVIEW_THRESHOLD } from '@/lib/risk'

/**
 * ConfidenceBar — a confidence value as a marked scale, not a progress bar.
 *
 * The two thresholds are drawn as ticks on the track, so the number is always read
 * *against* the bands that govern it. A bare fill would tell you 0.52 is "about
 * half" when what actually matters is that it sits above review and below hazard.
 */
export function ConfidenceBar({
  confidence,
  level,
  showValue = true,
  className = '',
}: {
  confidence: number
  /** Override the level — a reviewed detection's colour comes from its review. */
  level?: RiskLevel
  showValue?: boolean
  className?: string
}) {
  const resolved = level ?? riskOfConfidence(confidence)
  const pct = Math.max(0, Math.min(1, confidence)) * 100

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        className="relative h-1.5 flex-1 bg-ink-deep"
        role="meter"
        aria-valuenow={confidence}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-label="Detection confidence"
      >
        <div
          className={`absolute inset-y-0 left-0 ${RISK_CLASSES[resolved].bg}`}
          style={{ width: `${pct}%` }}
        />
        {/* Threshold ticks — the bands the number is judged against. */}
        <Tick at={REVIEW_THRESHOLD} title="Review threshold 0.40" />
        <Tick at={HAZARD_THRESHOLD} title="Hazard threshold 0.75" />
      </div>
      {showValue && (
        <span className={`font-mono text-[11px] tabular ${RISK_CLASSES[resolved].text}`}>
          {formatConfidence(confidence)}
        </span>
      )}
    </div>
  )
}

function Tick({ at, title }: { at: number; title: string }) {
  return (
    <span
      className="absolute top-[-2px] h-[10px] w-px bg-paper-faint"
      style={{ left: `${at * 100}%` }}
      title={title}
      aria-hidden
    />
  )
}

/**
 * Meter — a segmented bar for coverage and battery.
 *
 * Segmented rather than continuous because these are read as "how many blocks
 * left", the way a fuel gauge is, and discrete blocks are easier to compare at a
 * glance across two panels than two smooth fills.
 */
export function Meter({
  value,
  segments = 16,
  tone = 'paper',
  className = '',
  label,
}: {
  /** 0..1. */
  value: number
  segments?: number
  tone?: 'paper' | RiskLevel
  className?: string
  label?: string
}) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * segments)
  const fillClass = tone === 'paper' ? 'bg-paper' : RISK_CLASSES[tone].bg

  return (
    <div
      className={`flex items-center gap-px ${className}`}
      role="meter"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Meter'}
    >
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 flex-1 ${i < filled ? fillClass : 'bg-rule'}`}
          aria-hidden
        />
      ))}
    </div>
  )
}
