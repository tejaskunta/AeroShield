import { useEffect, useRef } from 'react'
import type { Detection } from '@/types'
import { RISK_CLASSES, formatConfidence, riskOf } from '@/lib/risk'
import { formatZulu } from '@/lib/geo'
import { CLASS_LABELS } from '@/types'

/**
 * DetectionTicker — the live detection feed along the bottom.
 *
 * Newest first, scrolling horizontally. It exists because the map shows *where*
 * detections are but not *when* they arrived, and arrival order is how an operator
 * follows a running mission. Clicking an entry selects its pin, which is the fast
 * path from "something just landed" to "show me where".
 *
 * The strip auto-scrolls to the newest entry, but only if the operator hasn't
 * scrolled away — hijacking their position mid-read would be worse than being
 * one entry behind.
 */
export function DetectionTicker({
  detections,
  selectedId,
  onSelect,
}: {
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const atStart = useRef(true)

  // Newest first.
  const ordered = [...detections].reverse()
  const newestId = ordered[0]?.id

  useEffect(() => {
    if (atStart.current && scroller.current) scroller.current.scrollLeft = 0
  }, [newestId])

  return (
    <div className="flex h-ticker shrink-0 items-stretch border-t border-rule bg-ink-deep">
      <div className="flex shrink-0 items-center gap-2 border-r border-rule px-3">
        <span className="eyebrow">Feed</span>
        <span className="font-mono text-[11px] tabular text-paper">{detections.length}</span>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          atStart.current = e.currentTarget.scrollLeft < 24
        }}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {ordered.length === 0 ? (
          <p className="self-center px-3 text-[11px] text-paper-faint">
            No detections yet. The feed fills as the drone surveys.
          </p>
        ) : (
          ordered.map((d, i) => {
            const level = riskOf(d)
            const selected = d.id === selectedId
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => onSelect(d.id)}
                aria-current={selected}
                className={`flex shrink-0 items-center gap-2 border-r border-rule/60 px-3 text-left transition-colors ${
                  selected ? 'bg-ink-hover' : 'hover:bg-ink-raised'
                }`}
              >
                {/* Newest entry gets a single ping, so an arrival is noticeable
                    without the whole strip animating. */}
                <span className="relative grid h-2 w-2 place-items-center" aria-hidden>
                  {i === 0 && (
                    <span
                      className={`absolute inset-0 motion-safe:animate-ping ${RISK_CLASSES[level].bg}`}
                    />
                  )}
                  <span className={`h-2 w-2 ${RISK_CLASSES[level].bg}`} />
                </span>
                <span className="font-mono text-[11px] tracking-[0.04em] text-paper">{d.id}</span>
                <span className={`font-mono text-[11px] tabular ${RISK_CLASSES[level].text}`}>
                  {formatConfidence(d.confidence)}
                </span>
                <span className="hidden text-[10px] text-paper-dim lg:inline">
                  {CLASS_LABELS[d.class]}
                </span>
                <span className="font-mono text-[10px] text-paper-faint">{d.gridCell}</span>
                <span className="hidden font-mono text-[10px] text-paper-faint xl:inline">
                  {formatZulu(d.capturedAt)}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
