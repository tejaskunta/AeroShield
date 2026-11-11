import type { ReactNode } from 'react'
import type { Detection, ReviewState, RiskLevel } from '@/types'
import { REVIEW_LABELS } from '@/types'
import { RISK_CLASSES, RISK_LABELS, REVIEW_THRESHOLD, riskOf } from '@/lib/risk'
import { Toggle } from '@/components/ui/Toggle'
import { Button } from '@/components/ui/Button'

/**
 * FilterRail -- narrow the queue down to what this reviewer is working through.
 *
 * Every filter shows its live count, so the operator can see the size of a slice
 * before committing to it, and can tell an empty result from a filter mistake.
 * Default state hides nothing: a review tool that silently starts filtered would
 * let detections go unseen.
 *
 * There is no class filter. There used to be, offering four classes to triage by,
 * but the model predicts one class -- so three of those chips could only ever
 * return nothing and the fourth returned everything. A control that cannot change
 * the result is worse than no control: it implies the detector distinguishes
 * things it does not.
 */
export interface Filters {
  risk: Set<RiskLevel>
  review: Set<ReviewState>
  /** Hide anything under the review threshold -- off by default, deliberately. */
  hideBelowThreshold: boolean
  query: string
}

export const NO_FILTERS: Filters = {
  risk: new Set<RiskLevel>(['hazard', 'caution', 'cleared']),
  review: new Set<ReviewState>(['unreviewed', 'confirmed', 'dismissed', 'flagged']),
  hideBelowThreshold: false,
  query: '',
}

/** Apply the filter set. Pure, so the contact sheet and the tallies agree. */
export function applyFilters(detections: Detection[], f: Filters): Detection[] {
  const q = f.query.trim().toLowerCase()
  return detections.filter((d) => {
    if (!f.risk.has(riskOf(d))) return false
    if (!f.review.has(d.review.state)) return false
    if (f.hideBelowThreshold && d.confidence < REVIEW_THRESHOLD) return false
    if (q && !`${d.id} ${d.gridCell} ${REVIEW_LABELS[d.review.state]}`.toLowerCase().includes(q)) {
      return false
    }
    return true
  })
}

export function isFiltered(f: Filters): boolean {
  return (
    f.risk.size < 3 ||
    f.review.size < 4 ||
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
          className="w-full border border-rule bg-ink px-2 py-1 font-mono text-small text-paper placeholder:text-paper-faint focus:border-rule-bright focus:outline-none"
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

        <Group label="Confidence">
          <Toggle
            checked={value.hideBelowThreshold}
            onChange={(next) => onChange({ ...value, hideBelowThreshold: next })}
            label={`Hide under ${REVIEW_THRESHOLD.toFixed(2)}`}
          />
          <p className="mt-1 text-tiny leading-snug text-paper-faint">
            Low-confidence hits are the ones most worth a human look. Hiding them is
            available, not recommended.
          </p>
        </Group>
      </div>

      {/* Standing count, plus an escape hatch when a filter hides everything. */}
      <div className="border-t border-rule p-2">
        <p className="font-mono text-tiny text-paper-dim">
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
