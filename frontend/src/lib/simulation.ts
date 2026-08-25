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
import { bearingDeg, cellAt, cellId, distanceM, lerpLatLng } from './geo'

/**
 * MissionSimulator — the stand-in for the whole live backend.
 *
 * It advances a virtual drone along the planned survey path, emits telemetry on a
 * tick, releases the pending detections as their capture time arrives, and accrues
 * coverage. The UI subscribes to it exactly as it will later subscribe to a
 * Socket.IO stream — same event shapes, same cadence — so replacing this class is
 * the swap point and nothing downstream changes.
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
 * Ground speed of the virtual drone, m/s. A survey pace, not a transit pace —
 * imaging runs are flown slowly enough to keep motion blur down.
 *
 * This value and `ELAPSED_AT_LOAD_S` in mockData are coupled: elapsed time at load
 * must land partway along the path, or the drone starts parked at the far end with
 * the mission already over. `estimatedTotalTimeS()` is what relates them.
 */
const CRUISE_MS = 5.0
/** Telemetry cadence. 2 Hz looks live without thrashing React. */
const TICK_MS = 500

export class MissionSimulator {
  private listeners = new Set<Listener>()
  private detectionListeners = new Set<DetectionListener>()
  private timer: ReturnType<typeof setInterval> | null = null

  /** Mission-elapsed seconds. Starts partway in so there's history on screen. */
  private elapsedS = ELAPSED_AT_LOAD_S
  /** Distance travelled along the planned path, metres. */
  private distanceAlong = 0
  private readonly pathTotalM: number
  private readonly legLengths: number[]

  private detections: Detection[] = [...INITIAL_DETECTIONS]
  private pending: Detection[] = [...PENDING_DETECTIONS]
  private coveredCells = new Set<string>()
  private track: LatLng[] = []
  private lastPosition: LatLng
  private streamState: StreamState = 'live'

  constructor() {
    const path = MISSION.plannedPath
    this.legLengths = path.slice(1).map((p, i) => distanceM(path[i]!, p))
    this.pathTotalM = this.legLengths.reduce((a, b) => a + b, 0)

    // Fast-forward to the load point so initial position, track, and coverage
    // are consistent with the detections already on screen. Clamped: if the two
    // constants ever drift out of step, the drone parks at the end of the path
    // rather than running off it.
    this.distanceAlong = Math.min(
      this.pathTotalM,
      (ELAPSED_AT_LOAD_S / this.estimatedTotalTimeS()) * this.pathTotalM,
    )
    this.lastPosition = MISSION.plannedPath[0]!
    this.replayTrackTo(this.distanceAlong)
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

  private estimatedTotalTimeS(): number {
    return this.pathTotalM / CRUISE_MS
  }

  private tick(): void {
    const dt = TICK_MS / 1000
    this.elapsedS += dt
    this.distanceAlong = Math.min(this.pathTotalM, this.distanceAlong + CRUISE_MS * dt)

    const position = this.positionAt(this.distanceAlong)
    this.lastPosition = position

    // Extend the flight track, thinning to keep the polyline cheap.
    const last = this.track[this.track.length - 1]
    if (!last || distanceM(last, position) > 3) this.track.push(position)

    this.markCoverage(position)
    this.releaseDueDetections()

    // At the end of the path, hold station rather than looping.
    if (this.distanceAlong >= this.pathTotalM) this.streamState = 'live'

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
   * Mark the cell the drone is currently over as imaged.
   *
   * Only the cell underneath, not its neighbours. At 42 m altitude the footprint is
   * roughly 55 m across against 40 m cells, so the drone genuinely images the cell
   * it is in — but a neighbour only catches a fringe, and calling that "surveyed"
   * would inflate coverage past what was actually looked at. The lawnmower path
   * passes through every cell, so full coverage is still reachable, and coverage
   * percent now tracks flight progress instead of racing ahead of it.
   */
  private markCoverage(position: LatLng): void {
    const here = cellAt(MISSION.grid, position)
    if (!here) return
    this.coveredCells.add(cellId(here.col, here.row))
  }

  // --- path geometry -------------------------------------------------------

  private positionAt(distance: number): LatLng {
    let remaining = distance
    const path = MISSION.plannedPath
    for (let i = 0; i < this.legLengths.length; i++) {
      const leg = this.legLengths[i]!
      if (remaining <= leg || i === this.legLengths.length - 1) {
        const t = leg === 0 ? 0 : Math.min(1, remaining / leg)
        return lerpLatLng(path[i]!, path[i + 1]!, t)
      }
      remaining -= leg
    }
    return path[path.length - 1]!
  }

  private replayTrackTo(distance: number): void {
    // Seed the track and coverage as if the drone had already flown this far.
    const step = 8 // metres between sampled track points
    for (let d = 0; d <= distance; d += step) {
      const p = this.positionAt(d)
      this.track.push(p)
      this.markCoverage(p)
    }
  }

  private headingAt(distance: number): number {
    const ahead = this.positionAt(Math.min(this.pathTotalM, distance + 2))
    const behind = this.positionAt(Math.max(0, distance - 2))
    return bearingDeg(behind, ahead)
  }

  // --- snapshot assembly ---------------------------------------------------

  private buildTelemetry(): Telemetry {
    const position = this.lastPosition
    const heading = this.headingAt(this.distanceAlong)
    const progress = this.distanceAlong / this.pathTotalM
    // Battery drains roughly linearly from 100% at takeoff.
    const batteryPct = Math.max(8, Math.round(100 - progress * 62 - this.elapsedS * 0.004))
    return {
      timestamp: new Date(MISSION_EPOCH + (this.elapsedS - ELAPSED_AT_LOAD_S) * 1000).toISOString(),
      position,
      altitudeM: Number((41 + Math.sin(this.elapsedS / 40) * 1.4).toFixed(1)),
      groundSpeedMs: Number((CRUISE_MS + Math.sin(this.elapsedS / 7) * 0.3).toFixed(1)),
      headingDeg: Math.round(heading),
      batteryPct,
      batteryVolts: Number((22.2 * (0.86 + (batteryPct / 100) * 0.14)).toFixed(1)),
      satellites: 16 + (Math.floor(this.elapsedS / 13) % 3),
      gpsFix: '3d',
      linkPct: 92 + (Math.floor(this.elapsedS / 5) % 6),
      mode: 'AUTO',
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
