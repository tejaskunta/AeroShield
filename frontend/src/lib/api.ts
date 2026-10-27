import type { Citation, CopilotMessage, Detection, MissionReport } from '@/types'
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
