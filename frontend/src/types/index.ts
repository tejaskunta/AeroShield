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
 * Class ids in dataset order, from `configs/data.yaml.example`. The ordering is
 * baked into the YOLO weights, so this union must stay in step with `names:`
 * in that file — index 0 first.
 *
 * `debris_negative` is the hard-negative class: it is a *detection* the model
 * made, not a hazard. It exists so the UI can show what the model correctly
 * ruled out, which is how an operator builds trust in the confidence numbers.
 */
export type DetectionClass = 'landmine_metal' | 'landmine_plastic' | 'debris_negative'

export const DETECTION_CLASSES: DetectionClass[] = [
  'landmine_metal',
  'landmine_plastic',
  'debris_negative',
]

/** Human-facing labels. The UI never shows a raw class id to an operator. */
export const CLASS_LABELS: Record<DetectionClass, string> = {
  landmine_metal: 'Metal-cased',
  landmine_plastic: 'Plastic-cased',
  debris_negative: 'Debris (ruled out)',
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

export interface ReviewRecord {
  state: ReviewState
  /** Required for `dismissed` and `flagged` — a decision without a reason is not auditable. */
  reason?: string
  reviewedAt?: string
  reviewedBy?: string
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
  /** 0..1 model confidence. Never rounded before display — `risk.ts` formats it. */
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
  /** Source frame. Placeholder until the ML pipeline emits real crops. */
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
  batteryPct: number
  batteryVolts: number
  satellites: number
  gpsFix: GpsFixType
  /** Telemetry link quality, 0..100. */
  linkPct: number
  mode: FlightMode
  armed: boolean
}

/** Connection state of the telemetry stream itself, distinct from link quality. */
export type StreamState = 'connecting' | 'live' | 'stalled' | 'offline'

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

/**
 * The survey grid. A mission is flown as a lawnmower pattern over these cells,
 * and a cell is only 'covered' once the camera footprint has passed over it —
 * which is what the coverage hatch on the map draws.
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
  /** e.g. `KANDAHAR-04`. Uppercase in the UI, it is a call sign. */
  name: string
  site: string
  status: MissionStatus
  startedAt: string
  endedAt?: string
  grid: MissionGrid
  /** Waypoints as uploaded from Mission Planner. Read-only here by design. */
  plannedPath: LatLng[]
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
// Safe path planning
// ---------------------------------------------------------------------------

export interface Waypoint {
  position: LatLng
  /** `WP1`, or `START` / `GOAL` for the endpoints. */
  label: string
  /** Distance to the nearest hazard at this waypoint, metres. */
  clearanceM: number
}

/**
 * Output of the A* planner over the risk surface. Deterministic by design — the
 * same inputs must always give the same route, because an operator will re-run
 * it and needs to trust that it did not silently change.
 */
export interface PathPlan {
  from: LatLng
  to: LatLng
  waypoints: Waypoint[]
  distanceM: number
  /** Aggregate 0..1 route risk. Drives the risk badge. */
  routeRisk: number
  riskLevel: RiskLevel
  /** Tightest hazard clearance anywhere on the route — the number that matters. */
  minClearanceM: number
  computedAt: string
  /** False when no corridor exists at the required clearance. */
  feasible: boolean
  /** Why a route is infeasible, or what compromise was made. Shown verbatim. */
  note?: string
}

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

export interface ClassTally {
  class: DetectionClass
  label: string
  count: number
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
