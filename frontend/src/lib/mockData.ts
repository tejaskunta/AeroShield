/**
 * Fixture barrel.
 *
 * This module used to be a 388-line monolith holding four unrelated domains: the
 * mission and its grid, the seeded detection field, the copilot's canned corpus,
 * and the sample reports. Those have moved to `./fixtures/*` — one file per domain,
 * each with its own dependencies visible in its import block rather than implied by
 * its position in a longer file.
 *
 * The re-exports below are the compatibility surface. Eleven call sites import from
 * `./mockData` (or `@/lib/mockData`), including `geo.test.ts`, which reads the
 * mission origin straight out of here. Keeping the barrel means none of them had to
 * change, and the split is verifiable by whether those call sites still build.
 *
 * The set of names here is deliberately identical to the set the monolith exported
 * — no more, no less. `isoAt`, `BLOCK_W_M`, `BLOCK_H_M` and `SEEDS` are exported by
 * their fixture modules because the other fixtures need them, but they were private
 * before and nothing imported them through this path, so they are not re-exported
 * here. That keeps "the barrel is the old public surface" a checkable claim rather
 * than an approximate one.
 *
 * Prefer importing from `./fixtures/<domain>` in new code: it says which domain you
 * actually depend on, and it keeps this list from growing a fifth entry.
 */

export {
  MISSION,
  MISSION_CENTER,
  MISSION_EPOCH,
  MISSION_GRID,
  ELAPSED_AT_LOAD_S,
} from './fixtures/mission'

export {
  ALL_DETECTIONS,
  INITIAL_DETECTIONS,
  PENDING_DETECTIONS,
  detectionDueAtS,
} from './fixtures/detections'

export {
  COPILOT_CORPUS,
  COPILOT_INTRO,
  SUGGESTED_QUERIES,
  UNGROUNDED_REPLY,
} from './fixtures/copilot'
export type { CorpusEntry } from './fixtures/copilot'

export { REPORTS } from './fixtures/reports'
