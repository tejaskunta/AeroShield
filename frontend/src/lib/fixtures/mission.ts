import type { LatLng, Mission, MissionGrid } from '@/types'
import { gridCenter } from '../geo'
import { SURVEY_ORIGIN } from '../config'

/**
 * The mission, its survey block, and the shared clock.
 *
 * Everything downstream is derived from this file: detections are placed in the
 * grid, pending arrivals are timed against the epoch, and reports are dated from
 * it. So it is the one fixture module with no dependencies on the others.
 *
 * NONE of this is real. `Detection.source` is `'simulated'` on every record, and
 * the UI surfaces that. See the plan's honesty rule.
 */

/**
 * Fixed epoch for all timestamps. Real code would use `Date.now()`, but pinning
 * it keeps fixtures reproducible and lets the simulator advance time itself.
 * Hyderabad is UTC+5:30; this instant is ~19:52 local, late afternoon.
 */
export const MISSION_EPOCH = Date.parse('2026-08-24T14:22:07Z')

/**
 * Render a mission-elapsed offset as an ISO timestamp.
 *
 * Exported because three fixture modules date records against the same clock; a
 * second copy of this arithmetic would be a second chance to get the sign wrong.
 */
export function isoAt(offsetSeconds: number): string {
  return new Date(MISSION_EPOCH + offsetSeconds * 1000).toISOString()
}

/**
 * The survey block's SW corner.
 *
 * This must match the origin the aircraft is actually flying from, or the drone is
 * drawn somewhere the map is not looking and the only honest conclusion available to
 * an operator is that the aircraft is missing. It previously held a Kandahar fixture
 * while the Jetson was flying from its default simulated origin, which put the drone
 * several thousand kilometres from the grid.
 *
 * `VITE_SURVEY_ORIGIN` (see `lib/config.ts`) is now the single source of truth, so
 * moving the survey to a real site is a config change rather than a code change.
 * The fallback is only reached when the variable is unset.
 */
const GRID_ORIGIN: LatLng = SURVEY_ORIGIN

/**
 * The survey block: 10 × 10 m, divided into 10 × 10 one-metre cells (A1–J10).
 *
 * The size is not a stylistic choice — it is the area the aircraft can actually be
 * flown over by hand, and the metre-most grid says so. The previous fixture was a
 * 320 × 240 m block, which is what made the map look permanently zoomed out: a
 * correct view of an eight-hectare block is necessarily an eight-hectare view, and
 * the drone and the mines are both a few pixels across in it.
 */
export const MISSION_GRID: MissionGrid = {
  origin: GRID_ORIGIN,
  cellSizeM: 1,
  cols: 10,
  rows: 10,
}

/** The block's ground extents, in metres. Used to project ground positions into frames. */
export const BLOCK_W_M = MISSION_GRID.cols * MISSION_GRID.cellSizeM
export const BLOCK_H_M = MISSION_GRID.rows * MISSION_GRID.cellSizeM

/**
 * How long the mission has been running at simulated "now". Seeds captured at or
 * before this mark are already on screen at load; later ones stream in live, so
 * the console has something to actually do while you look at it.
 *
 * The flight is manual, so the pace is the pilot's, not a planner's. A person
 * walking a 10 m block with a handheld transmitter covers it at roughly 1 m/s —
 * a ten-second pass per lane, about eleven lanes, so two minutes of flying in
 * total. 70 s puts the aircraft a little past halfway with the near lanes done and
 * the far ones still to walk.
 */
export const ELAPSED_AT_LOAD_S = 70

export const MISSION: Mission = {
  id: 'MSN-KMT-01',
  name: 'KMIT-01',
  site: 'KMIT campus, Narayanaguda, Hyderabad',
  status: 'in-progress',
  startedAt: isoAt(-ELAPSED_AT_LOAD_S),
  grid: MISSION_GRID,
  operator: 'A. RAO',
}

export const MISSION_CENTER: LatLng = gridCenter(MISSION.grid)
