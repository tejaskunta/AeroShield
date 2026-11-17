import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ReviewState } from '@/types'
import type { WriteOutcome } from '@/lib/api'
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

  const { selected, selectedId, select, review, remove, removeMany, checked, toggleChecked, clearChecked } =
    useDetections(all)

  /**
   * How the last write for the *currently selected* row went.
   *
   * Held with the id it describes rather than as a bare flag. The panel is what
   * renders it, and `selectedId` changes without any write happening — walking the
   * queue with J/K would otherwise show the previous row's verdict over this one's
   * evidence.
   */
  const [write, setWrite] = useState<{ id: string; outcome: WriteOutcome } | null>(null)
  const [deleteNote, setDeleteNote] = useState<string | null>(null)

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
      const outcome = await review(id, state, reason)
      setWrite({ id, outcome })
    },
    [review],
  )

  /**
   * Delete one row from the panel's footer. Resolves to a message when refused, so
   * the panel can keep its confirm open with the reason instead of closing as if
   * the row were gone.
   */
  const deleteOne = useCallback(
    async (id: string) => {
      const result = await remove(id)
      if (result.outcome === 'rejected') {
        return result.message ?? 'The server refused the delete.'
      }
      setWrite(null)
      return undefined
    },
    [remove],
  )

  /** Bulk delete over the ticked rows. Refusals are reported, not swallowed. */
  const deleteChecked = useCallback(async (): Promise<string | undefined> => {
    const result = await removeMany([...checked])
    setDeleteNote(result.message ?? null)
    if (!result.message) {
      clearChecked()
      return undefined
    }
    // Returned as well as stored, so the sheet can keep its confirm open on a
    // refusal without having to read back through the parent's state.
    return result.message
  }, [checked, removeMany, clearChecked])

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
        <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-6 pb-3 pt-5">
          <h1 className="text-[1.25rem] font-semibold tracking-tight text-paper">
            Detection Center
          </h1>
          <p className="text-[0.8125rem] text-paper-faint">
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
          checked={checked}
          onToggleChecked={toggleChecked}
          onClearChecked={() => {
            clearChecked()
            setDeleteNote(null)
          }}
          onDeleteChecked={deleteChecked}
          deleteNote={deleteNote}
        />
      </div>

      <div className="hidden min-w-0 lg:flex">
        <AdjudicationPanel
          detection={selected}
          onReview={submitReview}
          onShowOnMap={(id) => navigate(`/?focus=${id}`)}
          outcome={write && write.id === selectedId ? write.outcome : null}
          onDelete={deleteOne}
        />
      </div>
    </div>
  )
}
