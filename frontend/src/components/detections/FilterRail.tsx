import type { ReactNode } from 'react'
import type { Detection, DetectionClass, ReviewState, RiskLevel } from '@/types'
import { CLASS_LABELS, DETECTION_CLASSES } from '@/types'
import { RISK_CLASSES, RISK_LABELS, REVIEW_THRESHOLD, riskOf } from '@/lib/risk'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'

/**
 * FilterRail — narrow the queue down to what this reviewer is working through.
 *
 * Every filter shows its live count, so the operator can see the size of a slice
 * before committing to it, and can tell an empty result from a filter mistake.
 * Default state hides nothing: a review tool that silently starts filtered would
 * let detections go unseen.
 */
export interface Filters {
  risk: Set<RiskLevel>
  review: Set<ReviewState>
  classes: Set<DetectionClass>
  /** Hide anything under the review threshold — off by default, deliberately. */
  hideBelowThreshold: boolean
  query: string
}

export const NO_FILTERS: Filters = {
  risk: new Set<RiskLevel>(['hazard', 'caution', 'cleared']),
  review: new Set<ReviewState>(['unreviewed', 'confirmed', 'dismissed', 'flagged']),
  classes: new Set<DetectionClass>(DETECTION_CLASSES),
  hideBelowThreshold: false,
  query: '',
}

const REVIEW_LABELS: Record<ReviewState, string> = {
  unreviewed: 'Unreviewed',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  flagged: 'Flagged',
}

/** Apply the filter set. Pure, so the contact sheet and the tallies agree. */
export function applyFilters(detections: Detection[], f: Filters): Detection[] {
  const q = f.query.trim().toLowerCase()
  return detections.filter((d) => {
    if (!f.risk.has(riskOf(d))) return false
    if (!f.review.has(d.review.state)) return false
    if (!f.classes.has(d.class)) return false
    if (f.hideBelowThreshold && d.confidence < REVIEW_THRESHOLD) return false
    if (q && !`${d.id} ${d.gridCell} ${CLASS_LABELS[d.class]}`.toLowerCase().includes(q)) {
      return false
    }
    return true
  })
}

export function isFiltered(f: Filters): boolean {
  return (
    f.risk.size < 3 ||
    f.review.size < 4 ||
    f.classes.size < DETECTION_CLASSES.length ||
    f.hideBelowThreshold ||
    f.query.trim() !== ''
  )
}

export function FilterRail({
  all,
  value,
  onChange,
  shown,
}: {
  /** Unfiltered set, for computing each option's count. */
  all: Detection[]
  value: Filters
  onChange: (next: Filters) => void
  shown: number
}) {
  const countRisk = (level: RiskLevel) => all.filter((d) => riskOf(d) === level).length
  const countReview = (s: ReviewState) => all.filter((d) => d.review.state === s).length
  const countClass = (c: DetectionClass) => all.filter((d) => d.class === c).length

  const toggleIn = <T,>(set: Set<T>, item: T): Set<T> => {
    const next = new Set(set)
    if (next.has(item)) next.delete(item)
    else next.add(item)
    return next
  }

  return (
    <div className="flex h-full w-52 shrink-0 flex-col border-r border-rule bg-ink-deep">
      <div className="border-b border-rule p-2">
        <label className="sr-only" htmlFor="det-search">
          Search detections
        </label>
        <input
          id="det-search"
          type="search"
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          placeholder="ID or cell…"
          className="w-full border border-rule bg-ink px-2 py-1 font-mono text-[11px] text-paper placeholder:text-paper-faint focus:border-rule-bright focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <Group label="Risk">
          {(['hazard', 'caution', 'cleared'] as RiskLevel[]).map((level) => (
            <Toggle
              key={level}
              checked={value.risk.has(level)}
              onChange={() => onChange({ ...value, risk: toggleIn(value.risk, level) })}
              label={`${RISK_LABELS[level]} · ${countRisk(level)}`}
              swatch={<span className={`h-2 w-2 shrink-0 ${RISK_CLASSES[level].bg}`} aria-hidden />}
            />
          ))}
        </Group>

        <Group label="Review state">
          {(Object.keys(REVIEW_LABELS) as ReviewState[]).map((s) => (
            <Toggle
              key={s}
              checked={value.review.has(s)}
              onChange={() => onChange({ ...value, review: toggleIn(value.review, s) })}
              label={`${REVIEW_LABELS[s]} · ${countReview(s)}`}
            />
          ))}
        </Group>

        <Group label="Class">
          {DETECTION_CLASSES.map((c) => (
            <Toggle
              key={c}
              checked={value.classes.has(c)}
              onChange={() => onChange({ ...value, classes: toggleIn(value.classes, c) })}
              label={`${CLASS_LABELS[c]} · ${countClass(c)}`}
            />
          ))}
        </Group>

        <Group label="Confidence">
          <Toggle
            checked={value.hideBelowThreshold}
            onChange={(next) => onChange({ ...value, hideBelowThreshold: next })}
            label={`Hide under ${REVIEW_THRESHOLD.toFixed(2)}`}
          />
          <p className="mt-1 text-[10px] leading-snug text-paper-faint">
            Low-confidence hits are the ones most worth a human look. Hiding them is
            available, not recommended.
          </p>
        </Group>
      </div>

      {/* Standing count, plus an escape hatch when a filter hides everything. */}
      <div className="border-t border-rule p-2">
        <p className="font-mono text-[10px] text-paper-dim">
          <span className="text-paper">{shown}</span> of {all.length} shown
        </p>
        {isFiltered(value) && (
          <Button variant="quiet" className="mt-1 w-full" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <p className="eyebrow mb-1">{label}</p>
      {children}
    </div>
  )
}
