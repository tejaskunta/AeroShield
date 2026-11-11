/**
 * AeroShield data contracts.
 *
 * This file is the single place the shapes are declared, and it is the artifact
 * to hand to backend work. Every screen reads these types; the simulator in
 * `lib/simulation.ts` produces them today and the FastAPI backend must produce
 * them later.
 *
 * Where a field mirrors something the backend already has, it is noted. Where a
 * field is new, the backend owes it — see the table at the end of the plan.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The one class the model predicts.
 *
 * There is exactly one: the aircraft flies `best_512x288.engine`, built with
 * `names: {0: landmine}` (`nc=1`, see `jetson/README.md` and
 * `docs/TRAINING_NOTES.md`). A detection is therefore a single question with a
 * confidence attached -- "is this a landmine, and how sure is the model?" -- and
 * not a choice between classes.
 *
 * This union used to carry three more members (`landmine_metal`,
 * `landmine_plastic`, `debris_negative`) inherited from the three-class dataset
 * design in `configs/data.yaml.example`. They were never predicted by anything
 * that flew. Worse, `lib/api.ts` coerced every unrecognised `class_name` to
 * `landmine_metal`, so the "metal-cased / plastic-cased" split shown on screen
 * was manufactured at the adapter, not measured by the model. Presenting an
 * invented distinction as model output is the one thing a tool like this must
 * never do, so the extra members are gone.
 *
 * Keeping the type as a union of one is deliberate rather than collapsing to a
 * bare `string`: a second class is a real possibility (the dataset design exists,
 * and a hard-negative class would genuinely help), and widening this union is the
 * correct, reviewable way to add one. Nothing may widen it implicitly.
 */
export type DetectionClass = 'landmine'

/** Human-facing labels. The UI never shows a raw class id to an operator. */
export const CLASS_LABELS: Record<DetectionClass, string> = {
  landmine: 'Landmine',
}

/**
 * Three-level risk scale. These names are also the Tailwind colour token names,
 * so `risk.ts` can map a level straight to a class without a second lookup.
 */
export type RiskLevel = 'hazard' | 'caution' | 'cleared'

/** Pixel bbox in the source frame. Mirrors `BoundingBox` in the backend schema. */
export interface BoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface LatLng {
  lat: number
  lon: number
}

/** Where a detection stands in the human review workflow. */
export type ReviewState = 'unreviewed' | 'confirmed' | 'dismissed' | 'flagged'

/**
 * Human-facing review labels, shared so a filter chip and a chart legend cannot
 * drift apart. `flagged` is phrased as work still outstanding rather than as a
 * completed decision, because reopening a detection means it needs attention again.
 */
export const REVIEW_LABELS: Record<ReviewState, string> = {
  unreviewed: 'Unreviewed',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  flagged: 'Flagged',
}

export interface ReviewRecord {
  state: ReviewState
  /** Required for `dismissed` and `flagged` — a decision without a reason is not auditable. */
  reason?: string
  reviewedAt?: string
  reviewedBy?: string
}

/**
 * How far the human review of a mission has got.
 *
 * The dashboard's only genuinely multi-valued axis now that the model is
 * single-class: every detection is either still someone's job or already decided.
 */
export interface ReviewProgress {
  counts: Record<ReviewState, number>
  total: number
  /** Confirmed plus dismissed -- the detections a person has actually ruled on. */
  decided: number
  /** Unreviewed plus flagged -- still needs attention, including reopened work. */
  remaining: number
  /** 0..100, rounded. Zero when there is nothing to review yet. */
  pctDecided: number
}

/**
 * A single model detection, geotagged.
 *
 * The backend today returns only `class`, `confidence`, and `bbox`
 * (see `backend/app/schemas/detection.py`). Everything else here is what the
 * target architecture adds: MAVLink geotagging, Grad-CAM artifacts, and review
 * state.
 */
export interface Detection {
  /** Operator-facing id, e.g. `D-0147`. Short enough to read over radio. */
  id: string
  missionId: string
  class: DetectionClass
  /**
   * The `class_name` the aircraft actually sent, verbatim.
   *
   * `class` above is the display vocabulary (one value); this is the wire value,
   * preserved so an export or an audit records what the detector said rather than
   * what the UI rendered. Historic rows on the aircraft say `landmine_metal`
   * because an older adapter coerced them, and rewriting that to `landmine` on the
   * way out would quietly doctor the record. Absent on simulated rows, which have
   * no wire value to preserve.
   */
  classRaw?: string
  /** 0..1 model confidence. Never rounded before display -- `risk.ts` formats it. */
  confidence: number
  bbox: BoundingBox
  /** Geotagged position, projected from drone pose at capture time. */
  position: LatLng
  /** Drone altitude above ground at capture — drives the projection error estimate. */
  captureAltitudeM: number
  /** Estimated horizontal position error in metres (GPS + attitude + terrain). */
  positionErrorM: number
  capturedAt: string
  /** Survey grid reference, e.g. `C4`. How detections get talked about in the field. */
  gridCell: string
  /**
   * Pixel size of the source frame.
   *
   * `bbox` is in these coordinates. Without them a real photo cannot be
   * annotated: a box drawn from raw pixel values onto a scaled `<img>` lands in
   * the wrong place. Optional because a simulated detection has no source frame —
   * `PlaceholderFrame` invents its own geometry.
   */
  frameWidth?: number
  frameHeight?: number
  /**
   * Source frame. Placeholder until the ML pipeline emits real crops.
   *
   * Empty string means "no real image". Real rows start empty and are filled by
   * the frame store (`lib/detectionFrames.ts`) with an object URL, because the
   * image route needs an `X-API-Key` header that an `<img>` cannot send.
   */
  frameUri: string
  /** Grad-CAM heatmap over the same frame, or null if not yet computed. */
  gradCamUri: string | null
  review: ReviewRecord
  /**
   * Provenance. The UI must visibly mark anything that is not `backend`, so a
   * simulated detection can never be mistaken for a real one.
   */
  source: 'simulated' | 'backend'
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** GPS fix quality, as ArduPilot reports it. Below `3d`, geotagging is unreliable. */
export type GpsFixType = 'no-fix' | '2d' | '3d' | 'rtk'

/** ArduPilot flight modes relevant to a survey mission. */
export type FlightMode = 'AUTO' | 'GUIDED' | 'LOITER' | 'RTL' | 'MANUAL'

/** One telemetry frame. Arrives on a tick — ~2 Hz is plenty for a dashboard. */
export interface Telemetry {
  timestamp: string
  position: LatLng
  /** Above ground level, metres. */
  altitudeM: number
  groundSpeedMs: number
  /** 0..359, compass degrees. Drives the drone glyph rotation. */
  headingDeg: number
  /**
   * `null` when the aircraft did not report it.
   *
   * A dust-off flight with no MAVLink link sends no battery frame, and the ingest
   * schema stores that as NULL rather than 0. Coercing NULL to 0 (which is what a
   * plain `num()` did) made the panel assert "0 %" and "0.0 V" — a flat battery
   * on a healthy aircraft, which is worse than admitting the value is unknown.
   */
  batteryPct: number | null
  batteryVolts: number | null
  satellites: number
  gpsFix: GpsFixType
  /** Telemetry link quality, 0..100, or `null` when the aircraft did not report it. */
  linkPct: number | null
  mode: FlightMode
  armed: boolean
}

/**
 * Connection state of the telemetry stream itself, distinct from link quality.
 *
 * The four members are four different things an operator must be able to tell
 * apart, because each one implies a different action:
 *
 *   - `connecting`  — asked, no answer yet. Wait.
 *   - `live`        — a frame arrived recently. Normal.
 *   - `stalled`     — we can reach the backend, and it says the aircraft is not
 *                     reporting. The radio link or the aircraft is the problem.
 *   - `unreachable` — we cannot reach the backend at all. The aircraft may well
 *                     be flying and reporting perfectly; the *dashboard* is the
 *                     thing that is broken. Remedy is on this machine.
 *
 * `stalled` and `unreachable` were the same value once. That was wrong in the
 * expensive direction: a stale pin plus "Stream stalled" sent an operator to
 * inspect the aircraft when the actual fault was a stopped backend. Splitting
 * them costs one enum member and saves that wild goose chase.
 *
 * There is deliberately no `offline`. A keyless build still receives telemetry,
 * from the simulator, so its stream is `live` — and the "Simulated" chip in the
 * status rail is what says so. A fifth member meaning "not configured" would be
 * a fourth way to draw the same dot.
 */
export type StreamState = 'connecting' | 'live' | 'stalled' | 'unreachable'

/**
 * How the dashboard is currently getting its telemetry, and how well that is
 * going. Rendered by the status rail so a degradation is visible rather than
 * merely survivable.
 *
 * Deliberately separate from `StreamState`. `StreamState` answers "is the data
 * current?", which is the question the map needs answered. `LinkStatus` answers
 * "which path is the data taking, and is it healthy?", which is the question a
 * person debugging a demo needs answered. A socket that fell back to polling is
 * fully `live` and still worth showing, because polling is genuinely worse
 * (latency, and a request a second against the drone's ingest budget) and
 * silently accepting the regression is how it becomes permanent.
 */
export interface LinkStatus {
  /** Where telemetry is coming from. */
  source: 'simulator' | 'backend'
  /** Which backend transport is carrying it. `none` before the first attempt. */
  transport: 'socket' | 'polling' | 'none'
  /** Reconnect attempts since the last successful handshake. 0 when healthy. */
  socketAttempts: number
  /** True once retries are exhausted and polling has taken over for good. */
  socketGaveUp: boolean
  /**
   * Network-level reachability of the backend.
   *
   * False means the request never got a response at all — not that it got a
   * 4xx or a 5xx, which are answers. This is the field that distinguishes "the
   * aircraft went quiet" from "this laptop lost the network".
   */
  reachable: boolean
}

/**
 * The link status before the first snapshot arrives.
 *
 * Browsers paint the shell on the first frame, before any effect has run, so
 * `AppShell` has to render the rail with no snapshot in hand. `connecting` is the
 * honest claim at that moment: something has been attempted and nothing is known
 * yet. Reporting `live` there would be a claim the app has not earned, and
 * reporting `offline` would flash a fault on every single page load.
 */
export const CONNECTING_LINK: LinkStatus = {
  source: 'simulator',
  transport: 'none',
  socketAttempts: 0,
  socketGaveUp: false,
  reachable: false,
}

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

/**
 * The survey grid, in metres. The aircraft is flown over these cells by hand, and a
 * cell is only 'covered' once the camera footprint has passed over it — which is
 * what the coverage hatch on the map draws.
 */
export interface MissionGrid {
  /** South-west corner of the grid. */
  origin: LatLng
  /** Cell edge length in metres. Survey convention, not a display detail. */
  cellSizeM: number
  cols: number
  rows: number
}

export type MissionStatus = 'planned' | 'in-progress' | 'complete' | 'aborted'

export interface Mission {
  id: string
  /** e.g. `KMIT-01`. Uppercase in the UI, it is a call sign. */
  name: string
  site: string
  status: MissionStatus
  startedAt: string
  endedAt?: string
  grid: MissionGrid
  /**
   * No planned path, deliberately. The aircraft has no autopilot and no uploaded
   * route: the block is small enough that a person walks it with a transmitter, and
   * a planner that produced a route for it would be describing a capability the
   * aircraft does not have. The flown track is the only path in the data model, and
   * it is observed rather than commanded.
   */
  operator: string
}

/** Coverage and progress, derived from telemetry as the mission runs. */
export interface MissionProgress {
  /** Grid cell ids (`"B3"`) whose footprint has been imaged. */
  coveredCells: string[]
  coveragePct: number
  /** Trail of positions flown so far, for the flight-path polyline. */
  track: LatLng[]
  areaSurveyedM2: number
  elapsedS: number
  detectionCount: number
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------
// Safety copilot
// ---------------------------------------------------------------------------

/**
 * A retrieved source behind a copilot answer. In this domain an ungrounded
 * answer is dangerous, so citations are a first-class part of the response, not
 * a footnote — the UI gives them their own rail.
 */
export interface Citation {
  id: string
  /** e.g. `IMAS 09.10`. The standard or manual. */
  document: string
  /** Clause or section reference within the document. */
  clause: string
  page: number
  excerpt: string
  /** Retrieval score 0..1. Shown so a weak match is visible as weak. */
  relevance: number
}

export interface CopilotMessage {
  id: string
  role: 'operator' | 'copilot'
  text: string
  at: string
  citations?: Citation[]
  /**
   * False when the answer has no supporting sources. The UI must say so rather
   * than presenting an unsupported answer with the same authority as a cited one.
   */
  grounded: boolean
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface MissionReport {
  id: string
  missionId: string
  missionName: string
  site: string
  status: 'draft' | 'final'
  generatedAt: string
  generatedBy: string
  summary: string
  areaSurveyedM2: number
  coveragePct: number
  flightTimeS: number
  /** Detection tallies by review state — the headline numbers of the report. */
  tallies: {
    total: number
    confirmed: number
    dismissed: number
    flagged: number
    unreviewed: number
  }
  /** Detection ids included in the register table. */
  detectionIds: string[]
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** One bucket of the mission timeline. */
export interface TimeBucket {
  /** Minutes since mission start — a mission-relative axis reads better than clocks. */
  minute: number
  detections: number
  confirmed: number
  coveragePct: number
}

/** One bar of the confidence histogram. */
export interface ConfidenceBucket {
  /** Lower edge of the bin, e.g. 0.6 for the 0.60–0.69 bin. */
  binStart: number
  count: number
  level: RiskLevel
}

/** A cell of the risk-density heatmap, addressed by grid reference. */
export interface RiskCell {
  cellId: string
  col: number
  row: number
  /** 0..1 density — detections weighted by confidence. */
  density: number
  detections: number
}
