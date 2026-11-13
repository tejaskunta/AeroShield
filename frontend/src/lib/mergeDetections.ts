import type { Detection } from '@/types'

/**
 * Decide which detections a mission frame should show.
 *
 * The console has two sources of detections and they must not be mixed once the
 * aircraft is real.
 *
 * The simulator seeds a fixed block of fixtures (`D-0101`..`D-0114`) so the demo
 * has a believable hazard field to work against with no backend and no key. Those
 * rows are invented: their frames are `placeholder:frame/...`, their positions are
 * grid cells picked by hand, and three of them carry a pre-baked review verdict.
 * They exist to be looked at, not to be acted on.
 *
 * Once a live mission is answering, a seeded row is no longer a harmless prop. A
 * demining console that renders a synthetic landmine beside a genuine find gives
 * the operator no way to tell which of the two correspond to real buried metal,
 * and the seeded ones sit at the *top* of the contact sheet, so they are what a
 * reviewer sees first. The numbers on the rail are then wrong too — the tallies
 * count them.
 *
 * So the rule is: a live backend replaces the seeded block outright. The seeds are
 * a *fallback* for the keyless demo, never an addition to real data.
 *
 * `live` is deliberately broader than "has detections". A mission that is
 * connected but has found nothing yet is a real answer — the aircraft flew and
 * found nothing so far — and painting it with invented finds would hide exactly
 * the thing an operator is watching for. The empty contact sheet, which says the
 * mission is still early, is the truthful render.
 */
export function mergeDetections(
  seeds: Detection[],
  real: Detection[],
  live: boolean,
): Detection[] {
  if (!live) return seeds

  // No de-duplication is needed here: the seeds are dropped whole, so the only
  // rows left are the backend's own, and the backend is already de-duplicated by
  // id at the point it is admitted (`addDetection`). When no live mission is
  // known, the caller passes `live: false` and the seeds pass straight through.
  return real
}