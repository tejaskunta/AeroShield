import type {
  Detection,
  LatLng,
  MissionProgress,
  StreamState,
  Telemetry,
} from '@/types'
import {
  ALL_DETECTIONS,
  ELAPSED_AT_LOAD_S,
  INITIAL_DETECTIONS,
  MISSION,
  MISSION_EPOCH,
  PENDING_DETECTIONS,
  detectionDueAtS,
} from './mockData'
import { bearingDeg, cellAt, cellId, distanceM, offsetM } from './geo'

/**
 * MissionSimulator — the stand-in for the whole live backend.
 *
 * It moves a virtual aircraft over the survey block, emits telemetry on a tick,
 * releases the pending detections as their capture time arrives, and accrues
 * coverage. The UI subscribes to it exactly as it will later subscribe to a
 * Socket.IO stream — same event shapes, same cadence — so replacing this class is
 * the swap point and nothing downstream changes.
 *
 * The motion is deliberately NOT an autopilot. There is no planner and no uploaded
 * waypoint list: the aircraft is flown by hand over a small block, so the model is a
 * person walking a transmitter — straight lanes at walking pace, with a hand's width
 * of wander. Anything smoother or more precise than that would be modelling a
 * capability the aircraft does not have, and would make the track on screen a fiction
 * an operator might plan against.
 *
 * This is a foundation: none of the telemetry or detections are real.
 */

export interface MissionSnapshot {
  telemetry: Telemetry
  progress: MissionProgress
  /** Detections known so far, in capture order. */
  detections: Detection[]
  streamState: StreamState
}

type Listener = (snapshot: MissionSnapshot) => void
type DetectionListener = (detection: Detection) => void

/**
 * How fast the pilot walks the aircraft across the block, m/s. A person holding a
 * transmitter and watching the picture, not a cruise speed — the whole block is ten
 * metres across, so the aircraft is never more than a few seconds from the pilot's
 * feet and faster simply outruns the eye.
 */
const CRUISE_MS = 1.0
/** Telemetry cadence. 2 Hz looks live without thrashing React. */
const TICK_MS = 500
/** Spacing between swept lanes, metres. A little tighter than the cells so nothing slips between passes. */
const LANE_STEP_M = 1.2
/** Track points are kept once the aircraft has moved this far, which at this scale is a real trace. */
const TRACK_STEP_M = 0.35

/** Geometry of the hand-flown walk, derived from the grid so the two cannot drift apart. */
const LANE_SPAN_M = MISSION.grid.cols * MISSION.grid.cellSizeM
const BLOCK_DEPTH_M = MISSION.grid.rows * MISSION.grid.cellSizeM
/** Number of sweeps that fit across the block, inside a half-lane margin at each edge. */
const LANES = Math.max(2, Math.floor((BLOCK_DEPTH_M - LANE_STEP_M) / LANE_STEP_M) + 1)
/** One lane plus the step across to the next — the repeating unit of the walk. */
const WALK_PERIOD_M = LANE_SPAN_M + LANE_STEP_M
/** Total distance the walk covers, start to finish. Used only to size battery and progress. */
export const TOTAL_WALK_M = LANES * LANE_SPAN_M + (LANES - 1) * LANE_STEP_M

export class MissionSimulator {
  private listeners = new Set<Listener>()
  private detectionListeners = new Set<DetectionListener>()
  private timer: ReturnType<typeof setInterval> | null = null

  /** Mission-elapsed seconds. Starts partway in so there's history on screen. */
  private elapsedS = ELAPSED_AT_LOAD_S
  /** Metres flown along the walk so far. */
  private metresFlown = CRUISE_MS * ELAPSED_AT_LOAD_S

  private detections: Detection[] = [...INITIAL_DETECTIONS]
  private pending: Detection[] = [...PENDING_DETECTIONS]
  private coveredCells = new Set<string>()
  private track: LatLng[] = []
  private lastPosition: LatLng
  private streamState: StreamState = 'live'

  constructor() {
    // Seed position, track, and coverage from the walk already flown, so what is on
    // screen at load is consistent with the detections already on screen. Because the
    // walk is a pure function of distance, this is the same path the tick will
    // continue along — no separate fast-forward code to drift out of step.
    this.lastPosition = this.positionAtDistance(this.metresFlown)
    this.replayTrackTo(this.metresFlown)
  }

  // --- subscription --------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  /** Fires once per newly-emitted detection — drives the ping and the ticker. */
  onDetection(listener: DetectionListener): () => void {
    this.detectionListeners.add(listener)
    return () => this.detectionListeners.delete(listener)
  }

  start(): void {
    if (this.timer) return
    this.streamState = 'live'
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // --- simulation ----------------------------------------------------------

  private tick(): void {
    const dt = TICK_MS / 1000
    this.elapsedS += dt
    this.metresFlown = Math.min(TOTAL_WALK_M, this.metresFlown + CRUISE_MS * dt)

    const position = this.positionAtDistance(this.metresFlown)
    this.lastPosition = position

    // Extend the flight track, thinning to keep the polyline cheap. The threshold is
    // scale-coupled: at 1 m/s a 3 m gap would be a track point every six seconds, and
    // 3 m is nearly a third of this block, so the trace would skip whole lanes.
    const last = this.track[this.track.length - 1]
    if (!last || distanceM(last, position) > TRACK_STEP_M) this.track.push(position)

    this.markCoverage(position)
    this.releaseDueDetections()

    this.emit()
  }

  /** Emit any pending detections whose capture time has now elapsed. */
  private releaseDueDetections(): void {
    while (this.pending.length && detectionDueAtS(this.pending[0]!) <= this.elapsedS) {
      const d = this.pending.shift()!
      this.detections.push(d)
      this.detectionListeners.forEach((l) => l(d))
    }
  }

  /**
   * Mark the cell the aircraft is currently over as imaged.
   *
   * Only the cell underneath, not its neighbours. The aircraft is a few metres up
   * with a wide lens, so it sees well beyond one metre — but a neighbour only
   * catches a fringe, and calling a fringe "surveyed" would inflate coverage past
   * what was actually looked at. Every cell in a lane is marked as the lane is
   * walked, so coverage still tracks flight progress and full coverage is
   * reachable.
   */
  private markCoverage(position: LatLng): void {
    const here = cellAt(MISSION.grid, position)
    if (!here) return
    this.coveredCells.add(cellId(here.col, here.row))
  }

  // --- walk geometry -------------------------------------------------------

  /**
   * Where the aircraft is after `d` metres of the walk.
   *
   * Lanes are swept east–west alternately, stepping north at the end of each, and
   * the hand on the stick drifts a few centimetres either side of a true line. The
   * drift is the point: a perfectly straight trace would read as a programmed route,
   * and an operator comparing two surveys needs to see which waviness is the pilot
   * and which is real.
   */
  private positionAtDistance(d: number): LatLng {
    const walked = Math.max(0, Math.min(TOTAL_WALK_M, d))
    const lane = Math.floor(walked / WALK_PERIOD_M)
    const within = walked - lane * WALK_PERIOD_M
    const lastLane = Math.max(0, LANES - 1)

    let u: number
    let northM: number
    if (within <= LANE_SPAN_M) {
      const s = within / LANE_SPAN_M
      u = lane % 2 === 0 ? s : 1 - s
      northM = Math.min(lastLane, lane) * LANE_STEP_M
    } else {
      // In the step across to the next lane. Held at the end of the lane, easing
      // north, so the turn is one continuous movement instead of a jump.
      const tau = (within - LANE_SPAN_M) / LANE_STEP_M
      u = lane % 2 === 0 ? 1 : 0
      northM = Math.min(lastLane, lane + tau) * LANE_STEP_M
    }

    const driftE = Math.cos(walked / 2.3) * 0.08 + Math.sin(walked / 0.61) * 0.03
    const driftN = Math.sin(walked / 1.7) * 0.09
    return offsetM(MISSION.grid.origin, u * LANE_SPAN_M + driftE, northM + driftN)
  }

  private replayTrackTo(distance: number): void {
    // Seed the track and coverage as if the aircraft had already walked this far.
    for (let d = 0; d <= distance; d += TRACK_STEP_M) {
      const p = this.positionAtDistance(d)
      this.track.push(p)
      this.markCoverage(p)
    }
  }

  private headingAt(distance: number): number {
    const ahead = this.positionAtDistance(Math.min(TOTAL_WALK_M, distance + 0.25))
    const behind = this.positionAtDistance(Math.max(0, distance - 0.25))
    return bearingDeg(behind, ahead)
  }

  // --- snapshot assembly ---------------------------------------------------

  private buildTelemetry(): Telemetry {
    const position = this.lastPosition
    const heading = this.headingAt(this.metresFlown)
    const progress = Math.min(1, this.metresFlown / TOTAL_WALK_M)
    // Battery drains roughly linearly from 100% at takeoff.
    const batteryPct = Math.max(8, Math.round(100 - progress * 62 - this.elapsedS * 0.004))
    return {
      timestamp: new Date(MISSION_EPOCH + (this.elapsedS - ELAPSED_AT_LOAD_S) * 1000).toISOString(),
      position,
      altitudeM: Number((4 + Math.sin(this.elapsedS / 9) * 1.2).toFixed(1)),
      groundSpeedMs: Number((CRUISE_MS + Math.sin(this.elapsedS / 2.5) * 0.15).toFixed(1)),
      headingDeg: Math.round(heading),
      batteryPct,
      batteryVolts: Number((22.2 * (0.86 + (batteryPct / 100) * 0.14)).toFixed(1)),
      satellites: 16 + (Math.floor(this.elapsedS / 13) % 3),
      gpsFix: '3d',
      linkPct: 92 + (Math.floor(this.elapsedS / 5) % 6),
      // The aircraft is flown by hand over the block — there is no autopilot to be in.
      mode: 'MANUAL',
      armed: true,
    }
  }

  private buildProgress(): MissionProgress {
    const { grid } = MISSION
    const totalCells = grid.cols * grid.rows
    return {
      coveredCells: [...this.coveredCells],
      coveragePct: Math.round((this.coveredCells.size / totalCells) * 100),
      track: this.track,
      areaSurveyedM2: this.coveredCells.size * grid.cellSizeM * grid.cellSizeM,
      elapsedS: this.elapsedS,
      detectionCount: this.detections.length,
    }
  }

  private snapshot(): MissionSnapshot {
    return {
      telemetry: this.buildTelemetry(),
      progress: this.buildProgress(),
      detections: [...this.detections],
      streamState: this.streamState,
    }
  }

  private emit(): void {
    const snap = this.snapshot()
    this.listeners.forEach((l) => l(snap))
  }

  // --- review mutations (local only — no backend to persist to yet) --------

  /** Apply a review decision and re-emit. Mirrors a future PATCH endpoint. */
  reviewDetection(id: string, review: Detection['review']): void {
    const idx = this.detections.findIndex((d) => d.id === id)
    if (idx >= 0) {
      this.detections[idx] = { ...this.detections[idx]!, review }
      this.emit()
    }
  }
}

/** Every seeded detection, for screens that show the full mission (Analytics, Reports). */
export { ALL_DETECTIONS }

/** One shared instance — the app has a single live mission. */
export const simulator = new MissionSimulator()
