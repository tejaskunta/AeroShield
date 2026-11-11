import type {
  Citation,
  CopilotMessage,
  Detection,
  FlightMode,
  GpsFixType,
  MissionReport,
  Telemetry,
} from '@/types'
import { COPILOT_CORPUS, REPORTS, UNGROUNDED_REPLY } from './mockData'

/**
 * The API seam.
 *
 * Every call the UI makes to the server lives here. As of the PRD 5.1 build,
 * all of them are wired to real endpoints:
 *
 *   detectUpload    POST /api/detect            (dev-only inference, unchanged)
 *   checkHealth     GET  /health                (unchanged)
 *   saveReview      PATCH /api/detections/{id}/review
 *   askCopilot      POST /api/copilot/query
 *   listReports     GET  /api/reports
 *   generateReport  POST /api/reports
 *   findMissionByName  GET /api/missions
 *   fetchLatestTelemetry GET /api/missions/{id}/telemetry/latest
 *
 * Each wired call keeps its old fixture as a fallback: if the backend is
 * unreachable or rejects us (no key, a simulated id that has no server row),
 * the function resolves with the fixture behaviour instead of throwing, and the
 * caller's honesty flag (`persisted: false`, the fixture text, the fixture list)
 * tells the UI it is not looking at server state. The classroom demo runs with
 * zero keys and zero backend; a broken fallback would break that promise.
 *
 * Auth: the wired routes need X-API-Key (backend/app/core/security.py). The
 * dashboard key is read + review scope, so it is safe in a browser build; the
 * ingest key belongs on the drone, never here. Set VITE_DASHBOARD_KEY in
 * frontend/.env.local — with it unset, every call below takes its fallback path.
 */

const BASE = '/api'

const DASHBOARD_KEY = (import.meta.env.VITE_DASHBOARD_KEY ?? '').trim()

/** Headers for a call to the backend; no key means no point calling at all. */
function authHeaders(json = false): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  if (DASHBOARD_KEY) h['X-API-Key'] = DASHBOARD_KEY
  return h
}

/** Shape the current backend actually returns, from `schemas/detection.py`. */
interface BackendDetectResponse {
  success: boolean
  filename: string
  count: number
  detections: Array<{
    class: string
    confidence: number
    bbox: { x1: number; y1: number; x2: number; y2: number }
  }>
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * REAL — hits `POST /api/detect`.
 *
 * The endpoint takes an image and returns detections without GPS, timestamp, or
 * review state, so the caller must supply the mission context. Used by the manual
 * upload flow in Detection Center.
 */
export async function detectUpload(file: File): Promise<BackendDetectResponse> {
  const body = new FormData()
  body.append('file', file)

  let response: Response
  try {
    response = await fetch(`${BASE}/detect`, { method: 'POST', body })
  } catch {
    throw new ApiError(
      'Cannot reach the detection service. Start the backend with: uvicorn app.main:app --reload',
    )
  }
  if (!response.ok) {
    throw new ApiError(`Detection service returned ${response.status}.`, response.status)
  }
  return (await response.json()) as BackendDetectResponse
}

/** REAL — `GET /health`. Used to show whether the backend is up at all. */
export async function checkHealth(): Promise<boolean> {
  try {
    const r = await fetch('/health')
    return r.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// id mapping between the UI's display ids and the backend's integer ids
// ---------------------------------------------------------------------------

/**
 * The UI addresses detections as `D-0147` (short enough to read over radio); the
 * backend stores an integer PK. Parse one back out, or null for anything that is
 * not a real detection id — simulated rows keep living in the simulator and their
 * review decisions keep living in memory, which is the honest state of things.
 */
function toIntId(id: string): number | null {
  const m = /^D-(\d+)$/.exec(id)
  return m ? Number(m[1]) : null
}

/** Coerce a nullable backend number to the number the report types expect. */
function num(v: number | null | undefined, fallback = 0): number {
  return v ?? fallback
}

// ---------------------------------------------------------------------------
// Review — PATCH /api/detections/{id}/review
// ---------------------------------------------------------------------------

/** What PATCH /review returns (`DetectionRead` in schemas/detection_io.py). */
interface BackendDetectionRead {
  id: number
  review_state: string
  review_reason: string | null
  reviewed_by: string | null
  reviewed_at: string | null
}

/**
 * REAL (fixture fallback) — `PATCH /api/detections/{id}/review`.
 *
 * reviewed_by/reviewed_at come back stamped by the server from the authenticated
 * principal, so the caller replaces its optimistic record with what the audit
 * trail actually says. A simulated id, a missing key, or a rejecting backend all
 * resolve { persisted: false } — the hook then keeps the in-memory decision and
 * marks it "not persisted", exactly as designed.
 */
export async function saveReview(
  id: string,
  review: Detection['review'],
): Promise<{ persisted: boolean; record?: Detection['review'] }> {
  const numericId = DASHBOARD_KEY ? toIntId(id) : null
  if (numericId === null) return { persisted: false }

  try {
    const r = await fetch(`${BASE}/detections/${numericId}/review`, {
      method: 'PATCH',
      headers: authHeaders(true),
      body: JSON.stringify({ state: review.state, reason: review.reason ?? null }),
    })
    if (!r.ok) return { persisted: false }
    const body = (await r.json()) as BackendDetectionRead
    return {
      persisted: true,
      record: {
        state: body.review_state as Detection['review']['state'],
        reason: body.review_reason ?? undefined,
        reviewedAt: body.reviewed_at ?? undefined,
        reviewedBy: body.reviewed_by ?? undefined,
      },
    }
  } catch {
    return { persisted: false }
  }
}

// ---------------------------------------------------------------------------
// Detections — GET /api/detections, GET /api/detections/{id}/image
// ---------------------------------------------------------------------------

/**
 * One row of `GET /api/detections` (`DetectionRead` in schemas/detection_io.py).
 *
 * Flat and snake_case because it is a database row. `class_name` is whatever the
 * aircraft actually sent. The engine is single-class (`names: {0: landmine}`), so
 * a current drone posts `"landmine"`; historic rows in the log may say
 * `landmine_metal` because an older adapter coerced them before upload.
 */
export interface BackendDetectionRow {
  id: number
  client_detection_id: string
  mission_id: number
  class_name: string
  class_id: number
  confidence: number
  bbox_x1: number
  bbox_y1: number
  bbox_x2: number
  bbox_y2: number
  latitude: number | null
  longitude: number | null
  altitude_m: number | null
  relative_altitude_m: number | null
  heading_deg: number | null
  gps_fix_type: number | null
  horizontal_error_m: number | null
  frame_width: number | null
  frame_height: number | null
  image_path: string | null
  gradcam_path: string | null
  review_state: string | null
  review_reason: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  model_version: string | null
  captured_at: string
}

interface BackendDetectionList {
  items: BackendDetectionRow[]
  total: number
  limit: number
  offset: number
}

/**
 * Backend row -> UI detection.
 *
 * NO CLASS TRANSLATION HAPPENS HERE. The previous version mapped `class_name`
 * through a lookup that fell back to `landmine_metal` for anything it did not
 * recognise, which meant a row the UI had never heard of was silently relabelled
 * as a specific munition case type. That is a safety-relevant claim invented by a
 * `default:` branch, so it is gone. The detector has one class, the UI has one
 * class, and the row's verbatim `class_name` is carried through as `classRaw` for
 * exports and audits rather than being reinterpreted.
 *
 * `frameUri` is deliberately left empty, because the bytes need an authenticated
 * fetch that must not block this list from rendering. An empty string means "no
 * image yet" and every consumer treats that as "draw the placeholder"; the actual
 * blob URL is looked up by `lib/detectionFrames.ts` against the detection id.
 *
 * Exported because the mission socket receives single rows in exactly this shape
 * (`{"type": "detection", "data": <DetectionRead>}`) and must map them the same
 * way. Two mappers for one wire shape is how a socket frame and a polled row end
 * up disagreeing about which field is the position.
 *
 * Rows with no GPS fix return null. A detection with `latitude: null` has no
 * position, and the UI's `Detection.position` is not optional because a pin with
 * no position is not a pin — so the honest place to handle that is at the seam.
 */
export function toDetection(r: BackendDetectionRow): Detection | null {
  if (r.latitude === null || r.longitude === null) return null

  const level = r.confidence
  return {
    id: `D-${String(r.id).padStart(4, '0')}`,
    missionId: String(r.mission_id),
    class: 'landmine',
    classRaw: r.class_name,
    confidence: level,
    bbox: { x1: r.bbox_x1, y1: r.bbox_y1, x2: r.bbox_x2, y2: r.bbox_y2 },
    position: { lat: r.latitude, lon: r.longitude },
    captureAltitudeM: r.relative_altitude_m ?? r.altitude_m ?? 0,
    positionErrorM: r.horizontal_error_m ?? 0,
    capturedAt: r.captured_at,
    // Frame dimensions matter even when there is no image yet: the bbox is in
    // these coordinates, and the map callout draws the box over the photo.
    frameWidth: r.frame_width ?? undefined,
    frameHeight: r.frame_height ?? undefined,
    // Grid cell is a *survey-block* reference and the real aircraft is not
    // flying the simulated block, so there is no honest cell to name. Empty is
    // the truthful value; the UI renders nothing rather than a fabricated `A1`.
    gridCell: '',
    frameUri: '',
    gradCamUri: null,
    review: {
      state: (r.review_state as Detection['review']['state']) ?? 'unreviewed',
      reason: r.review_reason ?? undefined,
      reviewedAt: r.reviewed_at ?? undefined,
      reviewedBy: r.reviewed_by ?? undefined,
    },
    source: 'backend',
  }
}

/**
 * REAL — `GET /api/detections?mission_id=`.
 *
 * Returns `[]` on any failure rather than throwing, matching the rest of this
 * file: the caller merges what it gets onto the simulator, so an empty list means
 * "nothing real to add", which is the same thing the keyless demo sees.
 *
 * Rows with no geotag are filtered out (see `toDetection`). They are still on the
 * server and still in the drone's log — they simply cannot be drawn on a map, and
 * the honest place to notice that is the backend, not a pin at (0, 0).
 */
export async function listDetections(missionId: number, limit = 500): Promise<Detection[]> {
  if (!DASHBOARD_KEY) return []
  try {
    const r = await fetch(`${BASE}/detections?mission_id=${missionId}&limit=${limit}`, {
      headers: authHeaders(),
    })
    if (!r.ok) return []
    const body = (await r.json()) as BackendDetectionList
    return body.items.map(toDetection).filter((d): d is Detection => d !== null)
  } catch {
    return []
  }
}

/**
 * REAL — `GET /api/detections/{id}/image` or `/{id}/gradcam`, as an object URL.
 *
 * An `<img src>` **cannot** send an `X-API-Key` header, and the image route is
 * behind `SCOPE_DETECTIONS_READ`, so the bytes have to be fetched with
 * `authHeaders()` and handed to the DOM as a blob URL. That is why this returns a
 * string to be assigned to `src` rather than a URL to be pasted into markup.
 *
 * The caller owns the URL and **must** call `URL.revokeObjectURL` when it is done;
 * these are JPEGs around 20 KB and a mission's worth of them held for the life of
 * the tab is a real leak. `lib/detectionFrames.ts` does that bookkeeping.
 *
 * Null means "no picture", which every consumer already has to handle for
 * simulated rows.
 */
export async function fetchDetectionImage(
  id: string,
  variant: 'frame' | 'gradcam' = 'frame',
): Promise<string | null> {
  const numericId = toIntId(id)
  if (!DASHBOARD_KEY || numericId === null) return null
  const path = variant === 'gradcam' ? 'gradcam' : 'image'
  try {
    const r = await fetch(`${BASE}/detections/${numericId}/${path}`, { headers: authHeaders() })
    if (!r.ok) return null
    const blob = await r.blob()
    if (blob.size === 0) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Copilot — POST /api/copilot/query
// ---------------------------------------------------------------------------

/** Mirrors schemas/copilot.py (Citation / CopilotAnswer). */
interface BackendCopilotAnswer {
  text: string
  citations: Citation[]
  grounded: boolean
  engine: string
}

/**
 * REAL (fixture fallback) — `POST /api/copilot/query`.
 *
 * The backend response mirrors CopilotMessage field for field; we only add the
 * id/role/at the chat transcript needs. If the backend is down or keyless, the
 * keyword-overlap corpus answers — and the screen's honesty label still applies,
 * because that path IS still a fixture. A copilot that looks more capable than it
 * is would be the most dangerous thing in this app.
 */
export async function askCopilot(question: string): Promise<CopilotMessage> {
  if (DASHBOARD_KEY) {
    try {
      const r = await fetch(`${BASE}/copilot/query`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ question }),
      })
      if (r.ok) {
        const a = (await r.json()) as BackendCopilotAnswer
        const at = new Date().toISOString()
        return {
          id: `m-${at}`,
          role: 'copilot',
          text: a.text,
          at,
          citations: a.citations,
          grounded: a.grounded,
        }
      }
    } catch {
      /* fall through to the fixture */
    }
  }
  return askCopilotFixture(question)
}

/** The original keyword-overlap stub, kept as the no-backend fallback. */
async function askCopilotFixture(question: string): Promise<CopilotMessage> {
  const q = question.toLowerCase()
  let best: (typeof COPILOT_CORPUS)[number] | null = null
  let bestHits = 0

  for (const entry of COPILOT_CORPUS) {
    const hits = entry.match.filter((term) => q.includes(term)).length
    if (hits > bestHits) {
      bestHits = hits
      best = entry
    }
  }

  // Small deliberate delay so the UI's pending state is visible and designed.
  await new Promise((r) => setTimeout(r, 420))

  const at = new Date().toISOString()
  if (!best || bestHits === 0) {
    return {
      id: `m-${at}`,
      role: 'copilot',
      text: UNGROUNDED_REPLY,
      at,
      grounded: false,
    }
  }
  return {
    id: `m-${at}`,
    role: 'copilot',
    text: best.answer,
    at,
    citations: best.citations,
    grounded: true,
  }
}

// ---------------------------------------------------------------------------
// Reports — GET/POST /api/reports
// ---------------------------------------------------------------------------

/** Mirrors schemas/report.py (`ReportRead`), snake_case. */
interface BackendReportRead {
  id: string
  mission_id: number
  mission_name: string
  site: string
  status: string
  generated_at: string
  generated_by: string
  summary: string
  engine: string
  renderer: string
  area_surveyed_m2: number | null
  coverage_pct: number | null
  flight_time_s: number | null
  tallies: {
    total: number
    confirmed: number
    dismissed: number
    flagged: number
    unreviewed: number
  }
  detection_ids: string[]
  pdf_url: string | null
}

/**
 * Backend -> frontend report. The two shapes differ in exactly two deliberate
 * ways: snake_case JSON vs camelCase UI (mapped here — this file is the one
 * transform layer), and mission_id being an int server-side but a string in the
 * UI. `engine`/`renderer` are not carried into MissionReport yet; the document
 * itself states them in its header, which is where the claim belongs.
 */
function toMissionReport(r: BackendReportRead): MissionReport {
  return {
    id: r.id,
    missionId: String(r.mission_id),
    missionName: r.mission_name,
    site: r.site,
    status: r.status === 'final' ? 'final' : 'draft',
    generatedAt: r.generated_at,
    generatedBy: r.generated_by,
    summary: r.summary,
    areaSurveyedM2: num(r.area_surveyed_m2),
    coveragePct: num(r.coverage_pct),
    flightTimeS: num(r.flight_time_s),
    tallies: { ...r.tallies },
    detectionIds: r.detection_ids,
  }
}

/**
 * REAL (fixture fallback) — `GET /api/reports`.
 *
 * An empty list from a live backend is a valid answer, not a failure: no
 * reports exist yet, and the screen shows its empty state. The fixture list
 * returns only when the call itself cannot be made (no key / server down).
 */
export async function listReports(): Promise<MissionReport[]> {
  if (!DASHBOARD_KEY) return REPORTS
  try {
    const r = await fetch(`${BASE}/reports`, { headers: authHeaders() })
    if (!r.ok) return REPORTS
    const body = (await r.json()) as BackendReportRead[]
    return body.map(toMissionReport)
  } catch {
    return REPORTS
  }
}

/**
 * REAL (fixture fallback) — `POST /api/reports`.
 *
 * The UI addresses missions by call-sign string (`MSN-KMT-01`); the backend wants
 * an integer id. A non-numeric missionId can only be the simulated mission, so
 * the fixture path handles it. The fresh report replaces the fixture entry with
 * the same id so the list stays coherent whichever path produced it.
 */
export async function generateReport(missionId: string): Promise<MissionReport> {
  const numericId = Number(missionId)
  if (DASHBOARD_KEY && Number.isInteger(numericId) && numericId > 0) {
    try {
      const r = await fetch(`${BASE}/reports`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ mission_id: numericId }),
      })
      if (r.ok) return toMissionReport((await r.json()) as BackendReportRead)
    } catch {
      /* fall through to the fixture */
    }
  }
  const existing = REPORTS.find((rep) => rep.missionId === missionId)
  if (!existing) throw new ApiError(`No report for mission ${missionId}.`)
  return { ...existing, generatedAt: new Date().toISOString(), status: 'draft' }
}

// ---------------------------------------------------------------------------
// Telemetry — GET /api/missions/{id}/telemetry/latest
// ---------------------------------------------------------------------------

/**
 * A telemetry frame as the backend stores it (`TelemetryRead` in
 * schemas/telemetry.py). Flat and snake_case, because it is a database row.
 */
interface BackendTelemetryRead {
  id: number
  mission_id: number | null
  latitude: number
  longitude: number
  altitude_m: number | null
  relative_altitude_m: number | null
  heading_deg: number | null
  ground_speed_ms: number | null
  gps_fix_type: number | null
  satellites_visible: number | null
  battery_pct: number | null
  battery_volts: number | null
  link_pct: number | null
  flight_mode: string | null
  armed: boolean | null
  captured_at: string
  created_at: string
}

/**
 * `TelemetryLatest` in schemas/telemetry.py.
 *
 * Exported because the mission socket sends this same object inside its frames -
 * the hook that consumes the socket types its frames with this, and uses the same
 * `toLatestTelemetry` mapper the polling call uses.
 */
export interface BackendTelemetryLatest {
  found: boolean
  mission_id: number
  mission_name: string | null
  telemetry: BackendTelemetryRead | null
  age_s: number | null
  live: boolean
}

/** `MissionListSummary` in schemas/mission.py, inside the `Page` envelope. */
interface BackendMissionSummary {
  id: number
  name: string
}

interface BackendMissionPage {
  items: BackendMissionSummary[]
}

/**
 * The result of asking the backend a question, told apart by *why* there is no
 * answer.
 *
 * This type exists because a bare `T | null` collapses four genuinely different
 * situations into one, and the dashboard needs to act differently on each:
 *
 *   - `ok`          — the backend answered with data. Use it.
 *   - `absent`      — the backend answered, and the answer was "nothing there".
 *                     A mission that has not flown yet, or a fleet with no
 *                     mission by that name. Entirely normal, and the remedy is
 *                     to fly, not to debug.
 *   - `failed`      — the backend answered with an error status. It is running,
 *                     but something inside it is wrong: a query blew up, a
 *                     migration did not apply, the key was rejected. The remedy
 *                     is the backend's own logs.
 *   - `unreachable` — no response arrived at all. The backend is down, the proxy
 *                     is misconfigured, or this machine has lost the network. The
 *                     remedy is on this machine, and — critically — the aircraft
 *                     may be flying perfectly the whole time.
 *   - `disabled`    — this build has no API key, so nothing was attempted. The
 *                     simulator is the intended source and everything is working
 *                     as designed.
 *
 * The urgent case is `absent` versus `unreachable`. Returning null for both made
 * a stopped backend indistinguishable from a silent aircraft, and sent the
 * operator to inspect hardware that was fine.
 */
export type BackendOutcome<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'absent' }
  | { outcome: 'failed'; status: number }
  | { outcome: 'unreachable' }
  | { outcome: 'disabled' }

/**
 * True when a response proves the backend is running and answering.
 *
 * Excludes `unreachable` (nothing came back) and `disabled` (nothing was asked).
 * A `failed` outcome counts as reachable: a 500 is proof of life, just not of
 * health, and the two need different advice.
 */
export function isReachable(outcome: BackendOutcome<unknown>): boolean {
  return outcome.outcome === 'ok' || outcome.outcome === 'absent' || outcome.outcome === 'failed'
}

/**
 * The aircraft's latest known position, once it has been mapped into the UI's
 * vocabulary.
 */
export interface LatestTelemetry {
  missionId: number
  missionName: string | null
  telemetry: Telemetry
  /** Seconds since the aircraft last reported. Null when the backend did not say. */
  ageS: number | null
  /** True when the frame fell inside the backend's freshness window. */
  live: boolean
}

/**
 * ArduPilot's numeric `gps_fix_type` (MAVLink `GPS_FIX_TYPE`) to the UI's name.
 *
 * The backend stores the number because that is what the flight controller
 * sends; the UI shows the name because "3d" tells an operator whether they can
 * trust a geotag and "3" does not. Anything unrecognised resolves to `no-fix`,
 * which is the safe direction to be wrong in: claiming a better fix than the
 * data supports is what would put a detection in the wrong place.
 */
const GPS_FIX_BY_CODE: Record<number, GpsFixType> = {
  0: 'no-fix',
  1: 'no-fix',
  2: '2d',
  3: '3d',
  4: '3d',
  5: '3d',
  6: 'rtk',
}

/**
 * ArduPilot mode names to the four the dashboard renders.
 *
 * The UI's union is deliberately small; the flight controller's is not. Modes
 * that are not in the union (ALT_HOLD, POSHOLD, STABILIZE, ...) all mean the same
 * thing to this dashboard — a human is on the sticks — so they resolve to MANUAL
 * rather than being invented as new members. The aircraft has no autopilot, so
 * every mode it actually flies is MANUAL or one of the assisted hold modes.
 */
const FLIGHT_MODE_BY_NAME: Record<string, FlightMode> = {
  AUTO: 'AUTO',
  GUIDED: 'GUIDED',
  LOITER: 'LOITER',
  RTL: 'RTL',
  MANUAL: 'MANUAL',
}

/** Map one backend row into the frame the dashboard renders. */
function toTelemetry(t: BackendTelemetryRead): Telemetry {
  return {
    timestamp: t.captured_at,
    position: { lat: t.latitude, lon: t.longitude },
    // relative_altitude is height above the arming point, which is the closest
    // thing to the ground the aircraft has; altitude_m is above mean sea level
    // and would read as tens of metres on a site near sea level.
    altitudeM: num(t.relative_altitude_m ?? t.altitude_m),
    groundSpeedMs: num(t.ground_speed_ms),
    headingDeg: num(t.heading_deg),
    // Passed through as null instead of defaulting to 0: a NULL column means the
    // aircraft never sent that frame, and rendering it as 0% / 0V states a fact
    // the drone never asserted. The panel renders null as "not reported".
    batteryPct: t.battery_pct ?? null,
    batteryVolts: t.battery_volts ?? null,
    satellites: num(t.satellites_visible),
    gpsFix: GPS_FIX_BY_CODE[t.gps_fix_type ?? 0] ?? 'no-fix',
    linkPct: t.link_pct ?? null,
    mode: FLIGHT_MODE_BY_NAME[(t.flight_mode ?? '').toUpperCase()] ?? 'MANUAL',
    armed: t.armed ?? false,
  }
}

/**
 * Resolve a mission call-sign (e.g. `KMIT-01`) to the backend's integer id.
 *
 * The dashboard addresses missions by name, because that is what a pilot reads
 * out and what the drone passes to `--mission-name`; the backend keys them by
 * integer. Newest first, so a repeated call-sign resolves to the live one.
 *
 * Returns an OUTCOME, not a nullable id, because "there is no mission by this
 * name yet" and "I could not ask" are the two cases the dashboard must not
 * confuse: the first means fly the aircraft, the second means fix this laptop.
 * Before the first flight the first is the normal, expected answer.
 */
export async function findMissionByName(name: string): Promise<BackendOutcome<number>> {
  if (!DASHBOARD_KEY || !name) return { outcome: 'disabled' }
  try {
    const r = await fetch(`${BASE}/missions`, { headers: authHeaders() })
    if (!r.ok) return { outcome: 'failed', status: r.status }
    const page = (await r.json()) as BackendMissionPage
    const hit = page.items.find((m) => m.name === name)
    return hit ? { outcome: 'ok', value: hit.id } : { outcome: 'absent' }
  } catch {
    // The fetch itself rejected: DNS, refused connection, no network. Nothing
    // answered, which is a different fault from a 500.
    return { outcome: 'unreachable' }
  }
}

/**
 * Map a backend `TelemetryLatest` envelope into the UI's vocabulary.
 *
 * ONE MAPPER, TWO TRANSPORTS. The polling call and the live socket both receive
 * this exact JSON, so both go through this function. Two copies of this mapping
 * would eventually disagree (one learning about a new field first), and the
 * symptom would be a dashboard whose altitude is right over the socket and wrong
 * over the fallback - a bug nobody would think to look for.
 *
 * Returns null when `found` is false or the frame is absent: "this mission has no
 * telemetry yet" is a normal state at the start of a flight, and the caller's
 * job is to keep showing whatever it was showing rather than to render a zero.
 */
export function toLatestTelemetry(body: BackendTelemetryLatest): LatestTelemetry | null {
  if (!body.found || !body.telemetry) return null
  return {
    missionId: body.mission_id,
    missionName: body.mission_name,
    telemetry: toTelemetry(body.telemetry),
    ageS: body.age_s ?? null,
    live: body.live,
  }
}

/**
 * The mission socket for a given id, or null when this build cannot open one.
 *
 * Built from `window.location` rather than hard-coded, so it inherits the page's
 * scheme and host: served over https (or through a tunnel) it becomes `wss://`
 * automatically, because a `ws://` socket opened from an https page is blocked by
 * the browser and would fail with a console error that says nothing about the
 * real cause. The path stays relative (`/api/...`) for the same reason every
 * other call does - the dev server proxies it, and the browser never needs to
 * know the backend's port.
 *
 * The key rides in the query string because the `WebSocket` constructor offers no
 * way to set a header. See `backend/app/api/ws.py` for the full reasoning.
 */
export function missionSocketUrl(missionId: number): string | null {
  if (!DASHBOARD_KEY || !Number.isInteger(missionId) || missionId <= 0) return null
  if (typeof window === 'undefined' || !window.location) return null

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const key = encodeURIComponent(DASHBOARD_KEY)
  return `${scheme}//${window.location.host}${BASE}/ws/missions/${missionId}?key=${key}`
}

/**
 * REAL (simulator fallback) — `GET /api/missions/{id}/telemetry/latest`.
 *
 * This is the call that puts the real aircraft on the map. Never throws; the
 * caller keeps the simulator in every non-`ok` case, so a keyless classroom demo
 * looks exactly as it did before this function existed.
 *
 * Returns an outcome rather than `LatestTelemetry | null` for one reason: a null
 * cannot say whether the aircraft has not reported yet (`absent` — normal, and
 * the fix is to arm it) or whether the request never reached anyone
 * (`unreachable` — the fix is on this machine, while the aircraft may be flying
 * fine). Those two produce the same empty map and call for opposite actions.
 *
 * This stays even though `useMissionStream` prefers the socket: it is the
 * fallback for a socket that cannot connect (a proxy without `ws: true`, a
 * backend restart, a flaky link) and the source of the first position before the
 * socket has opened. A push transport does not remove the need to be able to ask.
 */
export async function fetchLatestTelemetry(
  missionId: number,
): Promise<BackendOutcome<LatestTelemetry>> {
  if (!DASHBOARD_KEY || !Number.isInteger(missionId) || missionId <= 0) {
    return { outcome: 'disabled' }
  }
  try {
    const r = await fetch(`${BASE}/missions/${missionId}/telemetry/latest`, {
      headers: authHeaders(),
    })
    if (!r.ok) return { outcome: 'failed', status: r.status }
    const parsed = toLatestTelemetry((await r.json()) as BackendTelemetryLatest)
    // A 200 with `found: false` is the backend telling us the mission exists but
    // no frame has arrived. That is an answer, so it is `absent`, not a failure.
    return parsed ? { outcome: 'ok', value: parsed } : { outcome: 'absent' }
  } catch {
    return { outcome: 'unreachable' }
  }
}
