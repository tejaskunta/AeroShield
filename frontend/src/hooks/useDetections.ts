import { useCallback, useMemo, useRef, useState } from 'react'
import type { Detection, ReviewState } from '@/types'
import { simulator } from '@/lib/simulation'
import { saveReview } from '@/lib/api'
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
 */
export function useDetections(detections: Detection[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = useMemo(
    () => detections.find((d) => d.id === selectedId) ?? null,
    [detections, selectedId],
  )

  const select = useCallback((id: string | null) => setSelectedId(id), [])

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
    async (id: string, state: ReviewState, reason?: string) => {
      const record: Detection['review'] = {
        state,
        reason,
        reviewedAt: new Date().toISOString(),
        reviewedBy: 'operator',
      }
      // Update the shared mission immediately; every subscriber re-renders.
      simulator.reviewDetection(id, record)

      // Resolve provenance from the row we are actually reviewing. A simulated
      // id can collide with a real primary key after parsing (fixtures are
      // `D-0101`+, real ids are the integer PK), so the decision of *whether* to
      // write may not be made from the id string alone. An unknown id is treated
      // as non-persistable, which is the safe direction: a click that cannot be
      // attributed to a real row must never become a write.
      const row = rowsRef.current.find((d) => d.id === id)
      const { persisted } = await saveReview(id, record, row?.source ?? 'simulated')
      return persisted
    },
    [],
  )

  return { selected, selectedId, select, review }
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
