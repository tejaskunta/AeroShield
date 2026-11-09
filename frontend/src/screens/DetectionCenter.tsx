import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ReviewState } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { useDetections, countByReview } from '@/hooks/useDetections'
import { FilterRail, NO_FILTERS, applyFilters, isFiltered, type Filters } from '@/components/detections/FilterRail'
import { ContactSheet } from '@/components/detections/ContactSheet'
import { AdjudicationPanel } from '@/components/detections/AdjudicationPanel'
import { BackendCheck } from '@/components/detections/BackendCheck'

/**
 * Detection Center — the review workspace.
 *
 * Three columns: filters, contact sheet, adjudication. The shape follows the actual
 * task, which is not "browse detections" but "clear a queue": narrow it, scan it,
 * decide, move on. Hence keyboard-first — J/K to walk, C to confirm, X to dismiss,
 * F to flag — because a reviewer with a few hundred frames should never have to
 * move their hand to the mouse.
 */
export function DetectionCenter() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const mission = useMission()
  const all = mission?.detections ?? []

  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const visible = useMemo(() => applyFilters(all, filters), [all, filters])

  const { selected, selectedId, select, review } = useDetections(all)
  const [persisted, setPersisted] = useState(true)

  // Arriving from Mission Control's "Inspect" — focus that detection, then drop
  // the param so a refresh doesn't keep re-selecting it.
  const focus = params.get('focus')
  useEffect(() => {
    if (!focus) return
    select(focus)
    const next = new URLSearchParams(params)
    next.delete('focus')
    setParams(next, { replace: true })
  }, [focus, select, params, setParams])

  const submitReview = useCallback(
    async (id: string, state: ReviewState, reason?: string) => {
      const ok = await review(id, state, reason)
      setPersisted(ok)
    },
    [review],
  )

  /** Move the selection within the currently visible queue. */
  const step = useCallback(
    (delta: number) => {
      if (visible.length === 0) return
      const idx = visible.findIndex((d) => d.id === selectedId)
      const nextIdx = idx === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, idx + delta))
      const next = visible[nextIdx]
      if (next) select(next.id)
    },
    [visible, selectedId, select],
  )

  // Keyboard review. Ignored while typing so filters and reason fields still work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      switch (e.key.toLowerCase()) {
        case 'j':
          e.preventDefault()
          step(1)
          break
        case 'k':
          e.preventDefault()
          step(-1)
          break
        case 'c':
          if (selectedId) {
            e.preventDefault()
            void submitReview(selectedId, 'confirmed')
            // Advance after a decision — the queue keeps moving.
            step(1)
          }
          break
        case 'x':
          if (selectedId) {
            e.preventDefault()
            void submitReview(selectedId, 'dismissed', 'Dismissed by keyboard review')
            step(1)
          }
          break
        case 'f':
          if (selectedId) {
            e.preventDefault()
            void submitReview(selectedId, 'flagged', 'Flagged by keyboard review')
            step(1)
          }
          break
        case 'escape':
          select(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, selectedId, submitReview, select])

  const tallies = countByReview(all)

  return (
    <div className="flex h-full min-w-0">
      <div className="hidden lg:flex">
        <FilterRail all={all} value={filters} onChange={setFilters} shown={visible.length} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Queue header — progress through the backlog, not just a title. */}
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-rule px-3 py-2">
          <h1 className="font-display text-[15px] uppercase tracking-[0.12em] text-paper">
            Detection Center
          </h1>
          <p className="font-mono text-[11px] text-paper-dim">
            <span className="text-paper">{tallies.unreviewed}</span> unreviewed ·{' '}
            {tallies.confirmed} confirmed · {tallies.dismissed} dismissed ·{' '}
            {tallies.flagged} flagged
          </p>
          <div className="ml-auto">
            <BackendCheck />
          </div>
        </header>

        <ContactSheet
          detections={visible}
          selectedId={selectedId}
          onSelect={select}
          onClearFilters={() => setFilters(NO_FILTERS)}
          filtered={isFiltered(filters)}
        />
      </div>

      <div className="hidden min-w-0 lg:flex">
        <AdjudicationPanel
          detection={selected}
          onReview={submitReview}
          onShowOnMap={(id) => navigate(`/?focus=${id}`)}
          persisted={persisted}
        />
      </div>
    </div>
  )
}
