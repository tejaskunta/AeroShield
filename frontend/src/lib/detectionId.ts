/**
 * The one place that decides what a detection's display id means, and therefore
 * whether a write against it can be legitimate.
 *
 * ── Why this is its own module ────────────────────────────────────────────────
 *
 * Display ids are `D-` plus the backend's integer primary key (`D-0147` — short
 * enough to read over the radio). The simulator's seeded fixtures are built as
 * `D-${index + 101}`, i.e. `D-0101` upward (see `lib/fixtures/detections.ts`).
 *
 * Those two id spaces *overlap*. `D-0101` is a well-formed display id and parses
 * to 101, which is a real primary key. And `PATCH /api/detections/{id}/review`
 * carries no mission in its path — the backend resolves the row by PK alone. So
 * adjudicating a purely synthetic fixture used to write a review onto a genuine
 * detection belonging to a different mission, replacing whatever an operator had
 * actually decided about real ground.
 *
 * The failure was silent in the worst way: the request returned 200, the UI
 * reported "persisted", and the row that changed was nowhere on screen.
 *
 * ── Why provenance and not a cleverer parse ──────────────────────────────────
 *
 * No amount of id parsing fixes this, because the collision is a coincidence of
 * *values*, not of shape. `D-0101` is not ambiguous as a string — it is simply
 * that both a fixture and a real row can legitimately produce it. The only
 * trustworthy signal is where the row came from, which the caller knows and the
 * id does not. Hence `canPersistReview(id, source)`.
 *
 * This lives outside `api.ts` for the same reason `risk.ts` does: `api.ts` reads
 * `import.meta.env` and so cannot be loaded by the Node test runner, while this
 * rule is pure and is exactly the kind of safety claim that should be pinned by a
 * test rather than left to a comment.
 */

import type { Detection } from '@/types'

/**
 * Parse a display id into the backend's integer primary key.
 *
 * Returns null for anything that is not a display id. Note that this says nothing
 * about whether the row *exists* or is safe to write — a fixture id parses
 * perfectly. Use `canPersistReview` before writing.
 */
export function toIntId(id: string): number | null {
  const m = /^D-(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
}

/**
 * May a review of this row be written to the backend?
 *
 * Only when the row came from the backend. A simulated detection has no row to
 * write to, and its display id may well collide with one that does — so an
 * unattributable row is refused rather than guessed at.
 *
 * The caller must supply provenance it actually resolved from the row. Passing a
 * default of `'backend'` would reinstate the original bug, so the parameter is
 * required and the failure direction is closed.
 */
export function canPersistReview(id: string, source: Detection['source']): boolean {
  if (source !== 'backend') return false
  return toIntId(id) !== null
}
