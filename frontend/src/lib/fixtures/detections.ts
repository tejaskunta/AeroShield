import type { Detection, LatLng } from '@/types'
import { M_PER_DEG_LAT, cellId, cellOrigin, mPerDegLon, offsetM } from '../geo'
import { mulberry32 } from '../rng'
import { BLOCK_H_M, BLOCK_W_M, ELAPSED_AT_LOAD_S, MISSION, MISSION_EPOCH, isoAt } from './mission'

/**
 * The seeded detection field.
 *
 * Two things make this more than a list of hazards: the hazard field has a real
 * cluster in it, and the arrival cadence is paced so the console has something to
 * do while you watch it. Both are explained at the point they are defined.
 */

/**
 * Detections are seeded at fixed grid cells so the risk heatmap has a stable,
 * believable hazard field to work against. Confidence and review state are chosen to
 * exercise every risk level.
 *
 * Cells are picked so the hazard field has a genuine cluster (C4/D4/E3) rather than
 * evenly scattered pins any straight line would miss.
 *
 * Capture times stay inside the two-minute manual flight described in `mission.ts`:
 * the last four sit just past `ELAPSED_AT_LOAD_S` and arrive every few seconds -- long
 * enough to orient before the first detection lands, short enough to observe without
 * waiting around.
 *
 * There is no class column. The model has one class, so a per-seed class field would
 * be a fiction the rest of the code would have to keep pretending about. What the
 * seeds do vary is confidence and review state, which together are the only things
 * that decide how a detection reads. The reviewed seeds are load-bearing and should
 * not be removed in a tidy-up: `confirmed` and `dismissed` are the only routes to a
 * hazard and a cleared pin respectively, so dropping them would leave the demo unable
 * to show two of its three states.
 */
interface Seed {
  col: number
  row: number
  confidence: number
  reviewed?: 'confirmed' | 'dismissed' | 'flagged'
  reason?: string
  /** Seconds after mission start this was captured. */
  atS: number
}

const SEEDS: Seed[] = [
  { col: 1, row: 0, confidence: 0.94, reviewed: 'confirmed', atS: 4 },
  { col: 2, row: 1, confidence: 0.88, atS: 7 },
  { col: 1, row: 1, confidence: 0.66, atS: 11 },
  { col: 3, row: 1, confidence: 0.71, atS: 15 },
  { col: 4, row: 2, confidence: 0.83, reviewed: 'confirmed', atS: 19 },
  { col: 5, row: 2, confidence: 0.52, atS: 23 },
  { col: 6, row: 2, confidence: 0.41, reviewed: 'dismissed', reason: 'Scrap metal, not ordnance', atS: 28 },
  { col: 5, row: 3, confidence: 0.79, atS: 34 },
  { col: 4, row: 3, confidence: 0.34, atS: 41 },
  { col: 3, row: 3, confidence: 0.91, reviewed: 'flagged', reason: 'Possible cluster, request second pass', atS: 48 },
  // --- these four arrive live, after load ---
  { col: 2, row: 4, confidence: 0.68, atS: 74 },
  { col: 6, row: 4, confidence: 0.86, atS: 79 },
  { col: 5, row: 5, confidence: 0.28, atS: 84 },
  { col: 3, row: 5, confidence: 0.77, atS: 89 },
]

/**
 * The frame the detector actually publishes. `bboxFor` places a box in this space,
 * and the camera picture-in-picture reads the same dimensions off the loaded image,
 * so the two agree. (This was 640×360 in practice while the fixture claimed
 * 1280×720, which put every synthetic box in the wrong place by a factor of two.)
 */
const FRAME_W = 640
const FRAME_H = 360

/**
 * A detector box for a target at a known ground position.
 *
 * The box is not free-floating decoration: where it sits in the frame is a claim
 * about where the target is, and the detection callout draws a leader line from that
 * claim to the pin on the map. So it is derived from the same ground position,
 * through the same projection the detection plate uses, and clamped inside the frame
 * — a box hanging off the edge is a box claiming a target the camera never saw.
 */
function bboxFor(position: LatLng, confidence: number, rnd: () => number) {
  const { grid } = MISSION
  const east = (position.lon - grid.origin.lon) * mPerDegLon(grid.origin.lat)
  const north = (position.lat - grid.origin.lat) * M_PER_DEG_LAT
  const u = Math.min(1, Math.max(0, east / BLOCK_W_M))
  const v = Math.min(1, Math.max(0, north / BLOCK_H_M))

  // The block fills the frame's long axis, so one metre of ground is BLOCK_W_M/FRAME_W
  // pixels. A more confident hit gets a tighter box.
  const gsd = BLOCK_W_M / FRAME_W
  const w = Math.min(FRAME_W * 0.22, (1.6 - confidence * 0.7) / gsd)
  const h = w * (0.7 + rnd() * 0.35)

  const x1 = Math.min(FRAME_W - w - 1, Math.max(1, u * FRAME_W - w / 2))
  const y1 = Math.min(FRAME_H - h - 1, Math.max(1, (1 - v) * FRAME_H - h / 2))
  return {
    x1: Math.round(x1),
    y1: Math.round(y1),
    x2: Math.round(x1 + w),
    y2: Math.round(y1 + h),
  }
}

function makeDetection(seed: Seed, index: number, rnd: () => number): Detection {
  const { grid } = MISSION
  // Jitter within the cell so pins don't all sit dead-centre.
  const jitterE = (0.3 + rnd() * 0.4) * grid.cellSizeM
  const jitterN = (0.3 + rnd() * 0.4) * grid.cellSizeM
  const sw = cellOrigin(grid, seed.col, seed.row)
  const position = offsetM(sw, jitterE, jitterN)
  // A manual survey of a 10 m block is flown low — the camera needs the resolution
  // and the pilot needs to see the aircraft. A few metres AGL, not forty.
  const altitude = 4 + rnd() * 2

  const id = `D-${String(index + 101).padStart(4, '0')}`
  return {
    id,
    missionId: MISSION.id,
    class: 'landmine',
    confidence: seed.confidence,
    bbox: bboxFor(position, seed.confidence, rnd),
    position,
    captureAltitudeM: Number(altitude.toFixed(1)),
    // Position error scales with altitude and shrinks with confidence. The budget is
    // deliberately sub-metre: at this scale a 2.5 m CEP would be a quarter of the
    // whole block, and an uncertainty ring wider than the survey tells an operator
    // nothing except that the survey is pointless.
    positionErrorM: Number((0.3 + altitude * 0.05 + (1 - seed.confidence) * 0.5).toFixed(2)),
    capturedAt: isoAt(seed.atS - ELAPSED_AT_LOAD_S),
    gridCell: cellId(seed.col, seed.row),
    frameUri: `placeholder:frame/${id}`,
    gradCamUri: `placeholder:gradcam/${id}`,
    review: seed.reviewed
      ? {
          state: seed.reviewed,
          reason: seed.reason,
          reviewedAt: isoAt(seed.atS - ELAPSED_AT_LOAD_S + 120),
          reviewedBy: MISSION.operator,
        }
      : { state: 'unreviewed' },
    source: 'simulated',
  }
}

/**
 * Recover a detection's mission-elapsed capture time, in seconds.
 *
 * `MISSION_EPOCH` is the instant of simulated "now" at load, and capture timestamps
 * are written relative to it (negative for anything already past), so adding the
 * load offset back gives the original mission-elapsed seconds. The simulator
 * compares this against its own elapsed clock to decide when to emit.
 */
const seedAtOf = (d: Detection): number =>
  (Date.parse(d.capturedAt) - MISSION_EPOCH) / 1000 + ELAPSED_AT_LOAD_S

/** All seeded detections, sorted by capture time. Deterministic. */
export const ALL_DETECTIONS: Detection[] = (() => {
  const rnd = mulberry32(0x0af5_1e0d)
  return SEEDS.map((s, i) => makeDetection(s, i, rnd)).sort(
    (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
  )
})()

/**
 * Detections already on screen at load — everything captured at or before the
 * simulated "now". The four later seeds stream in as the simulator advances.
 */
export const INITIAL_DETECTIONS: Detection[] = ALL_DETECTIONS.filter(
  (d) => seedAtOf(d) <= ELAPSED_AT_LOAD_S,
)

/** Detections the simulator will emit, in order, once their capture time arrives. */
export const PENDING_DETECTIONS: Detection[] = ALL_DETECTIONS.filter(
  (d) => seedAtOf(d) > ELAPSED_AT_LOAD_S,
)

/** Mission-elapsed seconds at which a pending detection should fire. */
export function detectionDueAtS(d: Detection): number {
  return seedAtOf(d)
}
