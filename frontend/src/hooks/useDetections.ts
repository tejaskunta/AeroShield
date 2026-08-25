import { useCallback, useMemo, useState } from 'react'
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
 * attempt a `saveReview`, which is a no-op stub today. That two-step is on purpose:
 * it's already shaped for the real PATCH endpoint, and the UI can show a
 * "not persisted" state honestly until then.
 */
export function useDetections(detections: Detection[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = useMemo(
    () => detections.find((d) => d.id === selectedId) ?? null,
    [detections, selectedId],
  )

  const select = useCallback((id: string | null) => setSelectedId(id), [])

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
      // Attempt to persist. Today this resolves { persisted: false }.
      const { persisted } = await saveReview(id, record)
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
