import type {
  Citation,
  CopilotMessage,
  Detection,
  DetectionClass,
  LatLng,
  Mission,
  MissionGrid,
  MissionReport,
} from '@/types'
import { M_PER_DEG_LAT, cellId, cellOrigin, gridCenter, mPerDegLon, offsetM } from './geo'
import { SURVEY_ORIGIN } from './config'
import { mulberry32 } from './rng'

/**
 * Seeded mission fixtures.
 *
 * Everything here is deterministic: a fixed PRNG seed means the mission, its
 * grid, and its detections are identical on every load. That is deliberate —
 * a foundation you are designing against should not shuffle under you, and a
 * reproducible scene makes layout bugs reproducible too.
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

function isoAt(offsetSeconds: number): string {
  return new Date(MISSION_EPOCH + offsetSeconds * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// Mission + grid
// ---------------------------------------------------------------------------

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
 * flown over by hand, and the metremost grid says so. The previous fixture was a
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
const BLOCK_W_M = MISSION_GRID.cols * MISSION_GRID.cellSizeM
const BLOCK_H_M = MISSION_GRID.rows * MISSION_GRID.cellSizeM

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

// ---------------------------------------------------------------------------
// Detections
// ---------------------------------------------------------------------------

/**
 * Detections are seeded at fixed grid cells so the risk heatmap has a stable,
 * believable hazard field to work against. Confidence and class are chosen to
 * exercise every risk level and review state.
 *
 * Capture times stay inside the two-minute manual flight described above, so the
 * last four sit just past `ELAPSED_AT_LOAD_S` and arrive every few seconds — long
 * enough to orient before the first alert fires, short enough that the ping, the
 * ticker, and the alert banner are all observable without waiting around.
 *
 * Cells are picked so the hazard field has a genuine cluster (C4/D4/E3) rather than
 * evenly scattered pins any straight line would miss.
 */
interface Seed {
  col: number
  row: number
  cls: DetectionClass
  confidence: number
  reviewed?: 'confirmed' | 'dismissed' | 'flagged'
  reason?: string
  /** Seconds after mission start this was captured. */
  atS: number
}

/**
 * Capture times are spread across the flown portion of the mission, and the last
 * four sit just past `ELAPSED_AT_LOAD_S` so arrivals begin ~4 s after load and
 * then every ~5 s. That cadence is deliberate: long enough to orient before the
 * first alert fires, short enough that the ping, the ticker, and the alert banner
 * are all observable without waiting around.
 *
 * Cells are picked so the hazard field has a genuine cluster (C4/D4/E3) rather than
 * evenly scattered pins any straight line would miss.
 */
const SEEDS: Seed[] = [
  { col: 1, row: 0, cls: 'landmine_metal', confidence: 0.94, reviewed: 'confirmed', atS: 4 },
  { col: 2, row: 1, cls: 'landmine_metal', confidence: 0.88, atS: 7 },
  { col: 1, row: 1, cls: 'debris_negative', confidence: 0.66, atS: 11 },
  { col: 3, row: 1, cls: 'landmine_plastic', confidence: 0.71, atS: 15 },
  { col: 4, row: 2, cls: 'landmine_metal', confidence: 0.83, reviewed: 'confirmed', atS: 19 },
  { col: 5, row: 2, cls: 'landmine_plastic', confidence: 0.52, atS: 23 },
  { col: 6, row: 2, cls: 'debris_negative', confidence: 0.41, reviewed: 'dismissed', reason: 'Scrap metal, not ordnance', atS: 28 },
  { col: 5, row: 3, cls: 'landmine_metal', confidence: 0.79, atS: 34 },
  { col: 4, row: 3, cls: 'landmine_plastic', confidence: 0.34, atS: 41 },
  { col: 3, row: 3, cls: 'landmine_metal', confidence: 0.91, reviewed: 'flagged', reason: 'Possible cluster — request second pass', atS: 48 },
  // --- these four arrive live, after load ---
  { col: 2, row: 4, cls: 'landmine_plastic', confidence: 0.68, atS: 74 },
  { col: 6, row: 4, cls: 'landmine_metal', confidence: 0.86, atS: 79 },
  { col: 5, row: 5, cls: 'debris_negative', confidence: 0.28, atS: 84 },
  { col: 3, row: 5, cls: 'landmine_metal', confidence: 0.77, atS: 89 },
]

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
    class: seed.cls,
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
    gradCamUri: seed.cls === 'debris_negative' ? null : `placeholder:gradcam/${id}`,
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

// ---------------------------------------------------------------------------
// Safety copilot corpus
// ---------------------------------------------------------------------------

/**
 * A tiny fixed corpus keyed to the suggested questions. This is NOT retrieval and
 * NOT an LLM — it is canned Q&A so the screen's structure (answer + citations
 * rail + grounding) can be designed. The UI says as much.
 */
export interface CorpusEntry {
  match: string[]
  answer: string
  citations: Citation[]
}

export const SUGGESTED_QUERIES = [
  'What standoff distance for a suspected metal-cased mine?',
  'Can I trust a detection at 0.5 confidence?',
  'How should I mark a confirmed hazard for the ground team?',
  'What does a plastic-cased detection change about clearance?',
]

export const COPILOT_CORPUS: CorpusEntry[] = [
  {
    match: ['standoff', 'distance', 'metal', 'suspected'],
    answer:
      'Treat the detection position as the centre of a hazard area, not a point. For a suspected metal-cased anti-personnel mine, hold the ground team outside a 25 m radius until the area is verified, and approach only along a lane cleared from a known-safe start. AeroShield gives you a position estimate with a few metres of error, so the standoff must absorb that error — never walk to the pin.',
    citations: [
      { id: 'c1', document: 'IMAS 09.10', clause: '7.2 Marking of hazards', page: 14, excerpt: 'A hazardous area shall be treated as extending beyond the located item to account for positional uncertainty and the possibility of additional items.', relevance: 0.91 },
      { id: 'c2', document: 'IMAS 10.20', clause: '5.4 Safety distances', page: 9, excerpt: 'Minimum safety distances shall be established on the basis of the greatest credible threat and maintained until the area is confirmed clear.', relevance: 0.78 },
    ],
  },
  {
    match: ['trust', '0.5', 'confidence', 'low'],
    answer:
      'No — a 0.5-confidence detection is not a clearance decision either way. AeroShield treats anything below 0.75 as unverified: it is filed and shown, but it does not confirm a hazard, and it certainly does not clear the ground. A low-confidence hit is a reason for a human to look at the frame and the Grad-CAM, not a reason to dismiss it. Confidence is a triage signal, not a verdict.',
    citations: [
      { id: 'c3', document: 'AeroShield Ops Note', clause: '3.1 Confidence bands', page: 3, excerpt: 'Detections below the review threshold are retained for human adjudication and never auto-dismissed; the model reports likelihood, not ground truth.', relevance: 0.86 },
    ],
  },
  {
    match: ['mark', 'confirmed', 'hazard', 'ground team', 'ground'],
    answer:
      'Mark it to the recognised convention so anyone arriving reads it the same way: red marker on the hazard side, white on the cleared side, with the hazard boundary defined generously around the confirmed position. Record the grid reference and the confirmed coordinate in the mission log, and hand the ground team the coordinate plus the standoff, not just a pin on a screen.',
    citations: [
      { id: 'c4', document: 'IMAS 08.40', clause: '6.1 Marking systems', page: 11, excerpt: 'Marking shall use red to indicate the hazardous side and white the safe side, and shall be intelligible to all personnel who may enter the area.', relevance: 0.94 },
      { id: 'c5', document: 'IMAS 09.10', clause: '7.2 Marking of hazards', page: 14, excerpt: 'The marking of a hazardous area shall be recorded and reported through the information management system.', relevance: 0.72 },
    ],
  },
  {
    match: ['plastic', 'clearance', 'change', 'cased'],
    answer:
      'A plastic-cased detection matters most for what comes after AeroShield: minimal-metal mines defeat metal detectors, so the ground clearance method may need to change (prodding, dual-sensor, or GPR rather than metal detector alone). It does not change your immediate action — you still stand off and mark — but flag the case type in the report so the clearance team plans for a low-metal target.',
    citations: [
      { id: 'c6', document: 'IMAS 09.10', clause: '4.3 Detection methods', page: 8, excerpt: 'Where minimum-metal items are suspected, detection and clearance drills shall not rely solely on metal detection.', relevance: 0.89 },
    ],
  },
]

/** Answer shown when nothing in the corpus matches — grounded: false. */
export const UNGROUNDED_REPLY =
  'I don\'t have a sourced answer for that in the loaded standards set. Rather than guess — which is dangerous in this domain — treat this as unanswered and consult your technical field manual or EOD lead. (This copilot is a foundation running on a small fixed corpus, not live retrieval.)'

export const COPILOT_INTRO: CopilotMessage = {
  id: 'intro',
  role: 'copilot',
  text: 'Safety copilot ready. I answer from the loaded demining standards and cite every source. I support decisions — I do not authorise clearance. Ask a field question, or pick one below.',
  at: isoAt(0),
  grounded: true,
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const REPORTS: MissionReport[] = [
  {
    id: 'RPT-KMT-01',
    missionId: MISSION.id,
    missionName: MISSION.name,
    site: MISSION.site,
    status: 'draft',
    generatedAt: isoAt(0),
    generatedBy: MISSION.operator,
    // Deliberately states no coverage or tally figures. The Reports screen
    // recomputes those from live mission state, so a number written here would
    // drift out of step with the sheet it sits on within seconds.
    summary:
      'Interim report, KMIT campus block survey in progress. Detections to date are listed in the register below with their review state at time of generation. The near lanes have been walked; the far lanes are still to fly. Two metal-cased detections confirmed and one flagged for a second pass — none released, all pending ground verification.',
    areaSurveyedM2: BLOCK_W_M * BLOCK_H_M * 0.62,
    coveragePct: 62,
    flightTimeS: ELAPSED_AT_LOAD_S,
    tallies: { total: 10, confirmed: 2, dismissed: 1, flagged: 1, unreviewed: 6 },
    detectionIds: ALL_DETECTIONS.map((d) => d.id),
  },
  {
    id: 'RPT-KMT-00',
    missionId: 'MSN-KMT-00',
    missionName: 'KMIT-00',
    site: 'KMIT campus, Narayanaguda, Hyderabad',
    status: 'final',
    generatedAt: isoAt(-86_400),
    generatedBy: 'A. RAO',
    summary:
      'Complete survey of the KMIT campus block. 9 detections filed, 3 confirmed hazards handed to the ground team and marked to IMAS convention. No outstanding lanes. Survey only — no land released.',
    areaSurveyedM2: BLOCK_W_M * BLOCK_H_M,
    coveragePct: 100,
    flightTimeS: 124,
    tallies: { total: 9, confirmed: 3, dismissed: 4, flagged: 0, unreviewed: 2 },
    detectionIds: [],
  },
]
