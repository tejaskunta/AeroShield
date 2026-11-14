import type { Detection } from '@/types'

/**
 * Local edits that outlive a single mission frame: review decisions the operator
 * made, and rows the operator deleted.
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
 * The fix for both problems is a small store keyed by id, applied at the end of
 * every compose. It is deliberately *not* owned by either source. Review state is
 * the operator's decision about a row, and removal is the operator's decision
 * about the list; neither is a property that a feed is entitled to overwrite on
 * its next tick.
 *
 * DELETING NEEDS THE SAME ANSWER. The backend's list is re-read on a timer and on
 * every reconnect, so a row deleted on the server drops out of the next frame by
 * itself - but a row deleted while the request is still in flight would flash
 * back, and a *simulated* row has no server row at all, so without a tombstone it
 * could never be removed from the contact sheet by any means. The tombstone is
 * what makes "deleted" mean deleted for the rest of the session.
 *
 * It is also not persisted here. Persistence is `saveReview`'s and
 * `deleteDetection`'s job, and the two are independent on purpose: a decision must
 * land on screen even with no backend, no key, or a rejected write. What this
 * store records is only "what this operator has decided", which is a fact about
 * the session, not about the database.
 */
export class ReviewOverrides {
  private map = new Map<string, Detection['review']>()

  /**
   * Ids the operator deleted this session.
   *
   * A `Set` beside the review map rather than a sentinel review state, because the
   * two are orthogonal: a row can be confirmed and then deleted, and collapsing
   * that into one field would lose which of the two the audit trail should say.
   */
  private removed = new Set<string>()

  /** Record what the operator decided. Last write wins, like the audit trail. */
  record(id: string, review: Detection['review']): void {
    this.map.set(id, review)
  }

  /**
   * Hide a row from every subsequent frame.
   *
   * Callers are responsible for calling this only once the row is genuinely gone,
   * or once they have accepted that it was never real. Hiding a row whose DELETE
   * was refused would leave the operator believing evidence was destroyed while
   * the server still has it, which is the one failure mode worse than refusing.
   */
  remove(id: string): void {
    this.removed.add(id)
  }

  /** Undo a removal, for a caller that offers the operator a second thought. */
  restore(id: string): void {
    this.removed.delete(id)
  }

  /** Whether this session has deleted the row. */
  isRemoved(id: string): boolean {
    return this.removed.has(id)
  }

  /**
   * Overlay recorded decisions onto a detection list, and drop deleted rows.
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
    if (this.map.size === 0 && this.removed.size === 0) return list
    let changed = false
    const next: Detection[] = []
    for (const d of list) {
      if (this.removed.has(d.id)) {
        changed = true
        continue
      }
      const review = this.map.get(d.id)
      if (review) {
        changed = true
        next.push({ ...d, review })
      } else {
        next.push(d)
      }
    }
    return changed ? next : list
  }

  /** How many decisions are held. Read by tests; no production caller needs it. */
  get size(): number {
    return this.map.size
  }

  /** How many rows this session has deleted. Read by tests. */
  get removedSize(): number {
    return this.removed.size
  }
}

/** One shared instance — the app has a single live mission, as the simulator does. */
export const reviewOverrides = new ReviewOverrides()