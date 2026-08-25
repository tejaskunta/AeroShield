import type { Detection, MissionReport } from '@/types'
import { COPILOT_CORPUS, REPORTS, UNGROUNDED_REPLY } from './mockData'
import type { CopilotMessage } from '@/types'

/**
 * The API seam.
 *
 * Every call the UI would make to the server lives here. Today almost all of them
 * return fixtures; `detectUpload` is the one that already has a real endpoint
 * (`POST /api/detect`). When the backend lands the rest, the bodies of these
 * functions change and nothing above them does.
 *
 * Each stub is marked with what the backend owes it.
 */

const BASE = '/api'

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
// Stubs — the backend owes these
// ---------------------------------------------------------------------------

/**
 * STUB. Backend owes: `PATCH /api/detections/{id}/review`.
 * Today the decision is held in the simulator's memory and is lost on reload.
 */
export async function saveReview(
  id: string,
  review: Detection['review'],
): Promise<{ persisted: boolean }> {
  void id
  void review
  return { persisted: false }
}

/**
 * STUB. Backend owes: `POST /api/copilot/query` backed by Chroma + an LLM.
 *
 * This matches against a small fixed corpus by keyword overlap. It is not
 * retrieval and not a model — the Copilot screen says so on the surface.
 */
export async function askCopilot(question: string): Promise<CopilotMessage> {
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

/** STUB. Backend owes: `GET /api/reports`. */
export async function listReports(): Promise<MissionReport[]> {
  return REPORTS
}

/**
 * STUB. Backend owes: `POST /api/reports` (WeasyPrint server-side).
 * The UI's export buttons build files client-side from fixture data instead.
 */
export async function generateReport(missionId: string): Promise<MissionReport> {
  const existing = REPORTS.find((r) => r.missionId === missionId)
  if (!existing) throw new ApiError(`No report fixture for mission ${missionId}.`)
  return { ...existing, generatedAt: new Date().toISOString(), status: 'draft' }
}
