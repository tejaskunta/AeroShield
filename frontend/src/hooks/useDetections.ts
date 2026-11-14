import { useCallback, useMemo, useRef, useState } from 'react'
import type { Detection, ReviewState } from '@/types'
import { simulator } from '@/lib/simulation'
import { reviewOverrides } from '@/lib/reviewOverrides'
import { deleteDetection, saveReview, type WriteOutcome } from '@/lib/api'
import { riskOf } from '@/lib/risk'

/**
 * Selection + review workflow over a set of detections.
 *
 * Selection is screen-local state (the map pins and the detection callout on
 * Mission Control share one selection; Detection Center keeps its own). Review
 * writes go to the simulator — which re-emits so every screen updates — and
 * then attempt a `saveReview`.
 *
 * That two-step is deliberate and the order matters: the in-memory decision always
 * lands, so the operator sees their adjudication immediately on every screen, and
 * persistence is a separate concern that can fail without taking the interaction
 * down with it. A simulated row stops at the first step, because it has no row to
 * persist to — see the provenance guard in `saveReview`.
 *
 * Both writes report a `WriteOutcome` rather than a boolean. The caller has to be
 * able to tell "this row is a fixture, nothing to write" from "the write failed",
 * because the first is normal and the second is a fault, and a single flag cannot
 * say which.
 */
export function useDetections(detections: Detection[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  /**
   * Rows ticked for a bulk action.
   *
   * Separate from `selectedId`, which drives the adjudication panel. They are two
   * different questions — "which one am I looking at" and "which ones am I acting
   * on" — and merging them would make reviewing a frame look like queueing it for
   * deletion.
   */
  const [checked, setChecked] = useState<Set<string>>(() => new Set())

  const selected = useMemo(
    () => detections.find((d) => d.id === selectedId) ?? null,
    [detections, selectedId],
  )

  const select = useCallback((id: string | null) => setSelectedId(id), [])

  const toggleChecked = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearChecked = useCallback(() => setChecked(new Set<string>()), [])

  /**
   * The rows the review callback must resolve provenance against.
   *
   * A ref rather than a dependency: `review` is handed to panels as a prop, and
   * re-creating it on every telemetry tick would re-render every consumer of the
   * list for no benefit. The ref is read at call time, so it is never stale.
   */
  const rowsRef = useRef(detections)
  rowsRef.current = detections

  const review = useCallback(
    async (id: string, state: ReviewState, reason?: string): Promise<WriteOutcome> => {
      const record: Detection['review'] = {
        state,
        reason,
        reviewedAt: new Date().toISOString(),
        reviewedBy: 'operator',
      }
      // Update the shared mission immediately; every subscriber re-renders.
      //
      // Two writes, because the two sources are held differently. The simulator
      // owns its seeded rows and re-emits, so `reviewDetection` is enough for
      // those. It holds NOTHING for a backend row -- that list lives in a ref
      // inside `useMissionStream` and is re-composed from the server's copy on
      // every tick, so a decision recorded only here would be reverted within
      // half a second. `reviewOverrides` is applied at the end of that compose,
      // which is the only place that covers both sources.
      simulator.reviewDetection(id, record)
      reviewOverrides.record(id, record)

      // Resolve provenance from the row we are actually reviewing. A simulated
      // id can collide with a real primary key after parsing (fixtures are
      // `D-0101`+, real ids are the integer PK), so the decision of *whether* to
      // write may not be made from the id string alone. An unknown id is treated
      // as non-persistable, which is the safe direction: a click that cannot be
      // attributed to a real row must never become a write.
      const row = rowsRef.current.find((d) => d.id === id)
      const { outcome, record: stamped } = await saveReview(
        id,
        record,
        row?.source ?? 'simulated',
      )

      // The server stamps `reviewed_by`/`reviewed_at` from the authenticated
      // principal, so its copy is the audit trail and replaces the optimistic one.
      // Without this the panel shows `operator` and a browser clock for a decision
      // the server attributed to a named key at its own time.
      if (stamped) {
        simulator.reviewDetection(id, stamped)
        reviewOverrides.record(id, stamped)
      }
      return outcome
    },
    [],
  )

  /**
   * Delete a row, and only hide it once the deletion is settled.
   *
   * The order is the opposite of `review`'s, and deliberately so. A review is the
   * operator's opinion, so it lands on screen first and persists second — nobody
   * else is harmed if the write fails. A delete destroys evidence, so the row must
   * stay on screen until the server has actually let go of it. Hiding first and
   * failing second would show an operator an empty queue while the database still
   * held every frame they thought they had removed.
   *
   * A simulated row is the exception: it was never on the server, so hiding it IS
   * the deletion, and it succeeds locally by definition.
   */
  const remove = useCallback(
    async (id: string): Promise<{ outcome: WriteOutcome; message?: string }> => {
      const row = rowsRef.current.find((d) => d.id === id)
      const result = await deleteDetection(id, row?.source ?? 'simulated')
      if (result.outcome === 'rejected') return result

      // Settled: gone from the server, or never there. Tombstone it so the next
      // compose cannot resurrect it, and drop the simulator's own copy so the
      // seeded list stops re-emitting it too.
      reviewOverrides.remove(id)
      simulator.removeDetection(id)
      if (selectedId === id) setSelectedId(null)
      return result
    },
    [selectedId],
  )

  /**
   * Delete several rows, reporting only the ones that did not go through.
   *
   * Run one at a time rather than in parallel, on purpose: these are destructive
   * writes against the same table, and a burst of concurrent DELETEs from one
   * browser is the kind of thing that turns a refused key into a partially applied
   * action. Sequential also means the first refusal can stop the run instead of
   * reporting a mixed result nobody can act on.
   *
   * A refusal does not roll back what already succeeded, because it cannot — those
   * rows are gone from the server. What it does do is *not* tombstone the rest, so
   * every row the server still holds stays on screen where the operator can see it.
   */
  const removeMany = useCallback(
    async (ids: string[]): Promise<{ removed: number; message?: string }> => {
      let removed = 0
      for (const id of ids) {
        const result = await remove(id)
        if (result.outcome === 'rejected') {
          return { removed, message: result.message ?? 'The server refused the delete.' }
        }
        removed++
      }
      clearChecked()
      return { removed }
    },
    [remove, clearChecked],
  )

  return { selected, selectedId, select, review, remove, removeMany, checked, toggleChecked, clearChecked }
}

/** Count detections by risk level — used by the map legend and status rail. */
export function countByRisk(detections: Detection[]) {
  let hazard = 0
  let caution = 0
  let cleared = 0
  for (const d of detections) {
    const level = riskOf(d)
    if (level === 'hazard') hazard++
    else if (level === 'caution') caution++
    else cleared++
  }
  return { hazard, caution, cleared, total: detections.length }
}

/** Count detections by review state — used by Detection Center and Reports. */
export function countByReview(detections: Detection[]): Record<ReviewState, number> {
  const counts: Record<ReviewState, number> = {
    unreviewed: 0,
    confirmed: 0,
    dismissed: 0,
    flagged: 0,
  }
  for (const d of detections) counts[d.review.state]++
  return counts
}
