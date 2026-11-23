import { useEffect, useRef } from 'react'
import { Trash2 } from 'lucide-react'
import type { Detection } from '@/types'
import { RISK_CLASSES, formatConfidence, riskOf } from '@/lib/risk'
import { DetectionFrame } from '@/components/ui/DetectionFrame'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { DemoEmptyAction } from '@/components/mission/DemoEmptyAction'

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
 *
 * TICKING VERSUS OPENING. Two interactions on one tile, and they must not be
 * confused: clicking the tile opens the frame for adjudication, clicking the box in
 * its corner ticks it for a bulk action. The box sits in the tile's own corner and
 * stops the click from propagating, so a reviewer can never destroy evidence while
 * meaning to read it. The bulk bar only exists while something is ticked, because a
 * permanent Delete button next to a queue invites exactly the misclick it fears.
 */
export function ContactSheet({
  detections,
  selectedId,
  onSelect,
  onClearFilters,
  filtered,
  checked,
  onToggleChecked,
  onClearChecked,
  onDeleteChecked,
  deleteNote,
}: {
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string) => void
  onClearFilters: () => void
  filtered: boolean
  /** Ids ticked for a bulk action. */
  checked: Set<string>
  onToggleChecked: (id: string) => void
  onClearChecked: () => void
  /** Resolves to a message when the delete was refused. */
  onDeleteChecked: () => Promise<string | undefined>
  /** Set when a bulk delete was partly or wholly refused. */
  deleteNote: string | null
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
            filtered ? <Button onClick={onClearFilters}>Clear filters</Button> : <DemoEmptyAction />
          }
        />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
      {/* Bulk bar. Only mounted while a tick exists, so it can never be the thing
          the cursor happens to be over when a reviewer reaches for a tile. */}
      {checked.size > 0 && (
        <div className="glass sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 px-3 py-2">
          <span className="font-mono text-small text-paper">
            {checked.size} selected
          </span>
          {deleteNote && (
            <span className="border-l-2 border-caution pl-2 font-mono text-tiny leading-snug text-caution">
              {deleteNote}
            </span>
          )}
          <span className="flex-1" />
          <Button variant="quiet" onClick={onClearChecked}>
            Clear
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 size={12} aria-hidden />}
            onClick={() => void onDeleteChecked()}
          >
            Delete {checked.size}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {detections.map((d) => {
          const level = riskOf(d)
          const selected = d.id === selectedId
          const ticked = checked.has(d.id)
          return (
            <div
              key={d.id}
              data-det={d.id}
              className={`group relative overflow-hidden rounded-lg border text-left transition-all ${
                selected
                  ? 'border-signal/60 bg-ink-hover shadow-glow'
                  : 'border-white/[0.06] bg-ink-raised hover:-translate-y-0.5 hover:border-white/15 hover:shadow-lift'
              }`}
            >
              {/* The click target is a real button covering the tile content, so
                  the checkbox can sit above it as a sibling rather than nested
                  inside it — a button inside a button is invalid markup. */}
              <button
                type="button"
                onClick={() => onSelect(d.id)}
                aria-current={selected}
                className="block w-full text-left"
              >
                <div className="relative aspect-video bg-ink-deep">
                  <DetectionFrame detection={d} risk={level} showStamp={false} />
                  {/* Review mark, top-right — shape-coded to match the map pins. */}
                  <span className="absolute right-2 top-2 rounded-full bg-black/45 p-1 backdrop-blur-sm">
                    <ReviewMark state={d.review.state} level={level} />
                  </span>
                </div>

                <div className="px-3 py-2.5">
                  <div className="flex items-baseline justify-between gap-1">
                    <span className="font-mono text-[0.75rem] text-paper">
                      {d.id}
                    </span>
                    <span className="font-mono text-[0.6875rem] text-paper-faint">{d.gridCell || '—'}</span>
                  </div>
                  {/* Bare bar, no number — the number is already in the row above at
                      the size it needs. Repeating it here would be noise. */}
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
                      <div
                        className={`h-full rounded-full ${RISK_CLASSES[level].bg}`}
                        style={{ width: `${Math.min(100, d.confidence * 100)}%` }}
                      />
                    </div>
                    <span className={`font-mono text-[0.75rem] tabular-nums ${RISK_CLASSES[level].text}`}>
                      {formatConfidence(d.confidence)}
                    </span>
                  </div>
                </div>
              </button>

              {/* Tick box, top-left, above the button rather than inside it. */}
              <label
                className="absolute left-2 top-2 flex cursor-pointer items-center justify-center rounded bg-black/55 p-1 backdrop-blur-sm"
                title={ticked ? 'Deselect for bulk action' : 'Select for bulk action'}
              >
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={() => onToggleChecked(d.id)}
                  aria-label={`Select ${d.id}`}
                  className="h-3.5 w-3.5 accent-[var(--signal)]"
                />
              </label>
            </div>
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
