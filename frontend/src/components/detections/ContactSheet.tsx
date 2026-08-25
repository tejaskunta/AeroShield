import { useEffect, useRef } from 'react'
import type { Detection } from '@/types'
import { RISK_CLASSES, formatConfidence, riskOf } from '@/lib/risk'
import { PlaceholderFrame } from '@/components/ui/PlaceholderFrame'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'

/**
 * ContactSheet — the review queue as a photographic contact sheet.
 *
 * Dense on purpose. A reviewer working a backlog is pattern-matching across many
 * frames, and the thing that makes that fast is seeing twenty at once with their
 * boxes drawn, not paging through cards. Each tile carries only what's needed to
 * decide whether to open it: the frame, the box, the id, the confidence bar, and a
 * review mark.
 *
 * The selected tile is outlined in `paper`, never filled with a risk colour —
 * selection is a UI state, not a hazard state, and colouring it red would collide
 * with the one meaning red is allowed to have.
 */
export function ContactSheet({
  detections,
  selectedId,
  onSelect,
  onClearFilters,
  filtered,
}: {
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClearFilters: () => void
  filtered: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Keep the keyboard-selected tile in view as J/K walks the queue.
  useEffect(() => {
    if (!selectedId || !containerRef.current) return
    const el = containerRef.current.querySelector(`[data-det="${selectedId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  if (detections.length === 0) {
    return (
      <div className="flex-1 p-3">
        <EmptyState
          title={filtered ? 'Nothing matches these filters' : 'No detections yet'}
          detail={
            filtered
              ? 'The queue has detections, but none pass the current filter set. Widen the filters to see them.'
              : 'Detections appear here as the drone surveys the block. The mission is still early.'
          }
          action={
            filtered ? <Button onClick={onClearFilters}>Clear filters</Button> : undefined
          }
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto p-2">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2">
        {detections.map((d) => {
          const level = riskOf(d)
          const selected = d.id === selectedId
          return (
            <button
              key={d.id}
              type="button"
              data-det={d.id}
              onClick={() => onSelect(d.id)}
              aria-current={selected}
              className={`group border text-left transition-colors ${
                selected
                  ? 'border-paper bg-ink-hover'
                  : 'border-rule bg-ink-raised hover:border-rule-bright'
              }`}
            >
              <div className="relative aspect-video border-b border-rule bg-ink-deep">
                <PlaceholderFrame
                  seed={d.id}
                  bbox={d.bbox}
                  risk={level}
                  showStamp={false}
                />
                {/* Review mark, top-right — shape-coded to match the map pins. */}
                <span className="absolute right-1 top-1">
                  <ReviewMark state={d.review.state} level={level} />
                </span>
              </div>

              <div className="p-1.5">
                <div className="flex items-baseline justify-between gap-1">
                  <span className="font-mono text-[10px] tracking-[0.04em] text-paper">
                    {d.id}
                  </span>
                  <span className="font-mono text-[10px] text-paper-faint">{d.gridCell}</span>
                </div>
                {/* Bare bar, no number — the number is already in the row above at
                    the size it needs. Repeating it here would be noise. */}
                <div className="mt-1 flex items-center gap-1.5">
                  <div className="h-1 flex-1 bg-ink-deep">
                    <div
                      className={`h-full ${RISK_CLASSES[level].bg}`}
                      style={{ width: `${Math.min(100, d.confidence * 100)}%` }}
                    />
                  </div>
                  <span className={`font-mono text-[10px] tabular ${RISK_CLASSES[level].text}`}>
                    {formatConfidence(d.confidence)}
                  </span>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Same shape vocabulary as the map pins, so the two views read alike. */
function ReviewMark({
  state,
  level,
}: {
  state: Detection['review']['state']
  level: ReturnType<typeof riskOf>
}) {
  const cls = RISK_CLASSES[level]
  if (state === 'confirmed') {
    return <span className={`block h-2.5 w-2.5 rotate-45 ${cls.bg}`} title="Confirmed" />
  }
  if (state === 'flagged') {
    return (
      <span
        className={`block h-2.5 w-2.5 rotate-45 border-2 ${cls.border}`}
        title="Flagged"
      />
    )
  }
  if (state === 'dismissed') {
    return <span className="block h-1.5 w-1.5 rounded-full bg-cleared" title="Dismissed" />
  }
  return (
    <span
      className={`block h-2.5 w-2.5 rounded-full border-2 ${cls.border}`}
      title="Unreviewed"
    />
  )
}
