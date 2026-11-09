import { useEffect, useId, useRef } from 'react'
import { ChevronUp } from 'lucide-react'
import type { Detection } from '@/types'
import { RISK_CLASSES, formatConfidence, riskOf } from '@/lib/risk'
import { formatZulu } from '@/lib/geo'
import { CLASS_LABELS } from '@/types'
import { usePersistedState } from '@/hooks/usePersistedState'
import { isBoolean } from '@/lib/persistedState'

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
 *
 * The `Feed` rail doubles as the fold control. Folding keeps the rail — the count
 * stays visible — because "how much has landed" is the one number here worth
 * carrying even when the strip is put away. Fold state is persisted, so a strip
 * the operator folded stays folded across a reload.
 *
 * `detections` may be a DISPLAY-CAPPED slice of the mission (see the cap in
 * MissionControl). When it is, `total` carries the real count so the badge can
 * say "60 / 214" instead of reporting the cap as the mission's output. Without
 * `total` the two are the same and the badge is a plain count, which is what the
 * other views that render this strip see.
 */
export function DetectionTicker({
  detections,
  total,
  selectedId,
  onSelect,
}: {
  detections: Detection[]
  /** True number of detections in the mission; defaults to `detections.length`. */
  total?: number
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const shown = detections.length
  const all = total ?? shown
  const capped = all > shown
  const panelId = useId()
  const [open, setOpen] = usePersistedState('ticker-open', true, isBoolean)
  const scroller = useRef<HTMLDivElement>(null)
  const atStart = useRef(true)

  // Newest first.
  const ordered = [...detections].reverse()
  const newestId = ordered[0]?.id

  useEffect(() => {
    if (!open) return
    if (atStart.current && scroller.current) scroller.current.scrollLeft = 0
  }, [newestId, open])

  return (
    <div className="flex h-ticker shrink-0 items-stretch border-t border-rule bg-ink-deep">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? 'Collapse detection feed' : 'Expand detection feed'}
        title={open ? 'Collapse feed' : 'Expand feed'}
        className={`flex shrink-0 items-center gap-2 px-3 text-left hover:bg-ink-raised focus-visible:ring-2 focus-visible:ring-paper/70 ${
          open ? 'border-r border-rule' : ''
        }`}
      >
        <ChevronUp
          size={12}
          className={`text-paper-faint transition-transform ${open ? '' : 'rotate-180'}`}
        />
        <span className="eyebrow">Feed</span>
        <span className="font-mono text-[11px] tabular text-paper">{all}</span>
        {capped && (
          /*
           * Explicitly "showing N of M". The alternative - drawing the cap as
           * if it were the total - would make a busy mission look like it
           * produced sixty detections and then stopped, which is the one reading
           * that would send an operator looking for a fault.
           */
          <span
            className="font-mono text-[10px] tabular text-paper-faint"
            title={`${shown} most recent of ${all} drawn — every detection is recorded`}
          >
            {shown} shown
          </span>
        )}
      </button>

      {/*
       * Kept mounted and hidden with a utility class rather than unmounted, so
       * `aria-controls` always points at a real element. Note it must be the
       * `hidden` CLASS, not the attribute: Tailwind's `flex` is an author rule and
       * would otherwise win over the UA stylesheet's `[hidden] { display: none }`.
       */}
      <div
        id={panelId}
        ref={scroller}
        hidden={!open}
        onScroll={(e) => {
          atStart.current = e.currentTarget.scrollLeft < 24
        }}
        className={`min-w-0 flex-1 items-stretch overflow-x-auto ${open ? 'flex' : 'hidden'}`}
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
