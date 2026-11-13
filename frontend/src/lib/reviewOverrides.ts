import type { Detection } from '@/types'

/**
 * Review decisions that outlive a single simulator frame.
 *
 * WHY THIS EXISTS. A mission snapshot is composed from two independent sources:
 * the simulator's own seeded list, and the backend's real rows, which live in a
 * ref inside `useMissionStream` so they survive the simulator re-emitting twice a
 * second. A review decision was only ever written into the *simulator's* list. For
 * a seeded row that works, because the simulator owns it and re-emits the change.
 * For a real row it does nothing at all:
 *
 *   - `simulator.reviewDetection` looks the id up in `this.detections`, which
 *     holds seeds only, so it finds nothing and emits nothing;
 *   - the next compose rebuilt the snapshot from `realDetections.current`, which
 *     still carried the untouched review.
 *
 * The operator's decision therefore never appeared on screen, and the PATCH that
 * ran underneath could succeed while the UI kept insisting it had not. A verdict
 * that looks like it failed but was in fact written is worse than one that failed
 * loudly: the reviewer re-does the work, and two people reading the same row
 * disagree about its state.
 *
 * The fix is a small store keyed by id, applied at the end of every compose. It
 * is deliberately *not* owned by either source. Review state is the operator's
 * decision about a row, not a property that either feed is entitled to overwrite
 * on its next tick.
 *
 * It is also not persisted here. Persistence is `saveReview`'s job, and the two
 * are independent on purpose: a decision must land on screen even with no backend,
 * no key, or a rejected write.
 */
export class ReviewOverrides {
  private map = new Map<string, Detection['review']>()

  /** Record what the operator decided. Last write wins, like the audit trail. */
  record(id: string, review: Detection['review']): void {
    this.map.set(id, review)
  }

  /**
   * Overlay recorded decisions onto a detection list.
   *
   * Returns the *same array reference* when nothing matched, because `compose`
   * runs on every simulator tick and handing back a fresh array each time would
   * re-render every consumer twice a second for no change. Callers depend on
   * reference stability elsewhere (see `TrackLayer`), so this keeps the cheap
   * path genuinely cheap.
   *
   * Matched rows are copied, not mutated: the list may still be the simulator's
   * own array, and mutating it in place would edit the source rather than overlay.
   */
  apply(list: Detection[]): Detection[] {
    if (this.map.size === 0) return list
    let changed = false
    const next = list.map((d) => {
      const review = this.map.get(d.id)
      if (!review) return d
      changed = true
      return { ...d, review }
    })
    return changed ? next : list
  }

  /** How many decisions are held. Read by tests; no production caller needs it. */
  get size(): number {
    return this.map.size
  }
}

/** One shared instance — the app has a single live mission, as the simulator does. */
export const reviewOverrides = new ReviewOverrides()