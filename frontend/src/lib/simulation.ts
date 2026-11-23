import type {
  Detection,
  FlightMode,
  LatLng,
  LinkStatus,
  MissionProgress,
  StreamState,
  Telemetry,
} from '@/types'
import { ALL_DETECTIONS, MISSION } from './mockData'
import { bearingDeg, cellAt, cellId, distanceM, lerpLatLng, offsetM } from './geo'
import { DEMO_MODE } from './config'
import { reviewOverrides } from './reviewOverrides'
import { SIM_FRAME_H, SIM_FRAME_W, captureSimFrame, clearSimFrames } from './simFrames'

/**
 * MissionSimulator — the stand-in for the whole live system.
 *
 * It flies one complete sortie over the survey block, end to end, the way the real
 * aircraft does it:
 *
 *   standby → preflight → takeoff → survey → rtl → landing → complete
 *
 * Detections are not released on a timer. Each seeded target is a buried object at
 * a fixed ground position, and it becomes a detection at the moment the aircraft
 * passes over it — so the camera feed, the map pin, the toast and the counters all
 * agree about when and where something was found.
 *
 * The UI subscribes to it exactly as it subscribes to the live backend — same event
 * shapes — so every screen (map, Detection Center, Analytics, Reports) is exercised
 * by the simulated flight. Nothing here is real: every detection carries
 * `source: 'simulated'` and the console says so.
 */

export type SimPhase = 'standby' | 'preflight' | 'takeoff' | 'survey' | 'rtl' | 'landing' | 'complete'

export const SIM_PHASES: readonly SimPhase[] = ['standby', 'preflight', 'takeoff', 'survey', 'rtl', 'landing', 'complete']

export const PHASE_LABELS: Record<SimPhase, string> = {
  standby: 'Standby',
  preflight: 'Pre-flight',
  takeoff: 'Take-off',
  survey: 'Survey',
  rtl: 'Return',
  landing: 'Landing',
  complete: 'Complete',
}

export interface PreflightCheck {
  id: string
  label: string
  detail: string
  done: boolean
}

/** Scenario state, carried on every snapshot so the UI can drive and display it. */
export interface SimState {
  phase: SimPhase
  paused: boolean
  speed: number
  /** 0..1 through the current phase. */
  phaseProgress: number
  /** 0..1 through the whole sortie, launch to touchdown. */
  missionProgress: number
  checks: PreflightCheck[]
  targetsTotal: number
  targetsFound: number
  /** Wall-clock ISO time of launch; null in standby. */
  launchedAt: string | null
  /** Wall-clock ISO time of touchdown; null until complete. */
  landedAt: string | null
  /** Operator-picked point the aircraft is flying to or holding over; null on the survey route. */
  guidedTarget: LatLng | null
  /** 'flying' en route to the guided point, 'holding' over it, null when not guided. */
  guided: 'flying' | 'holding' | null
}

export interface MissionSnapshot {
  telemetry: Telemetry
  progress: MissionProgress
  /** Detections known so far, in capture order. */
  detections: Detection[]
  streamState: StreamState
  /** Which transport is feeding this snapshot, and how healthy it is. */
  link: LinkStatus
  /** The simulated sortie's own state. */
  sim: SimState
}

type Listener = (snapshot: MissionSnapshot) => void
type DetectionListener = (detection: Detection) => void

const SIMULATED_LINK: LinkStatus = {
  source: 'simulator',
  transport: 'none',
  socketAttempts: 0,
  socketGaveUp: false,
  reachable: true,
}

/** Walking pace over the block, m/s: the aircraft is flown by hand. */
const CRUISE_MS = 1.0
/** Faster on the transit legs, which are not imaging. */
const TRANSIT_MS = 1.6
/** Survey altitude, metres AGL. */
const SURVEY_ALT_M = 4
/** Real-time tick. 2 Hz keeps React calm; the maps interpolate between ticks. */
const TICK_MS = 500
const LANE_STEP_M = 1.2
const TRACK_STEP_M = 0.3
/** A target is detected once the aircraft's nadir passes within this distance. */
const DETECT_RADIUS_M = 0.85

const PREFLIGHT_S = 6.5
const TAKEOFF_S = 4.5
const LANDING_S = 4.5

const LANE_SPAN_M = MISSION.grid.cols * MISSION.grid.cellSizeM
const BLOCK_DEPTH_M = MISSION.grid.rows * MISSION.grid.cellSizeM
/** Enough lanes that no point in the block is more than half a step from one. */
const LANES = Math.max(2, Math.ceil(BLOCK_DEPTH_M / LANE_STEP_M))
/** Lanes are centred in the block: first and last sit the same distance inside the edges. */
const LANE_INSET_M = Math.max(0, (BLOCK_DEPTH_M - (LANES - 1) * LANE_STEP_M) / 2)
const WALK_PERIOD_M = LANE_SPAN_M + LANE_STEP_M
const SERPENTINE_M = LANES * LANE_SPAN_M + (LANES - 1) * LANE_STEP_M
/** The last lane ends on the east side when there is an odd number of lanes. */
const LAST_LANE_EAST_M = (LANES - 1) % 2 === 0 ? LANE_SPAN_M : 0
/** The closing leg runs straight from the end of the last lane back to the start. */
const RETURN_M = Math.hypot(LAST_LANE_EAST_M, (LANES - 1) * LANE_STEP_M)
/** Total distance around the closed walk (kept for the geometry tests). */
export const TOTAL_WALK_M = SERPENTINE_M + RETURN_M

/** Where the pilot stands: just off the block's SW corner. */
export const HOME: LatLng = offsetM(MISSION.grid.origin, -1.6, -1.4)

/**
 * Where the aircraft is after `d` metres of the survey walk: east–west lanes swept
 * alternately, stepping north between them, with a hand's width of wander. Wraps,
 * so the walk is a closed loop.
 */
export function positionAtDistance(d: number): LatLng {
  const walked = ((d % TOTAL_WALK_M) + TOTAL_WALK_M) % TOTAL_WALK_M

  if (walked > SERPENTINE_M) {
    const tau = (walked - SERPENTINE_M) / RETURN_M
    const driftE = Math.cos(walked / 2.3) * 0.08 + Math.sin(walked / 0.61) * 0.03
    const driftN = Math.sin(walked / 1.7) * 0.09
    return offsetM(
      MISSION.grid.origin,
      (1 - tau) * LAST_LANE_EAST_M + driftE,
      LANE_INSET_M + (1 - tau) * (LANES - 1) * LANE_STEP_M + driftN,
    )
  }

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
    const tau = (within - LANE_SPAN_M) / LANE_STEP_M
    u = lane % 2 === 0 ? 1 : 0
    northM = Math.min(lastLane, lane + tau) * LANE_STEP_M
  }

  const driftE = Math.cos(walked / 2.3) * 0.08 + Math.sin(walked / 0.61) * 0.03
  const driftN = Math.sin(walked / 1.7) * 0.09
  return offsetM(MISSION.grid.origin, u * LANE_SPAN_M + driftE, LANE_INSET_M + northM + driftN)
}

export function headingAtDistance(d: number): number {
  return bearingDeg(positionAtDistance(d - 0.25), positionAtDistance(d + 0.25))
}

const SURVEY_START = positionAtDistance(0)
const SURVEY_END = positionAtDistance(SERPENTINE_M - 0.001)
const APPROACH_M = distanceM(HOME, SURVEY_START)
const RTL_M = distanceM(SURVEY_END, HOME)

/** Planned duration of each airborne phase, sim seconds — for overall progress. */
const SURVEY_S = APPROACH_M / TRANSIT_MS + SERPENTINE_M / CRUISE_MS
const RTL_S = RTL_M / TRANSIT_MS
const SORTIE_S = PREFLIGHT_S + TAKEOFF_S + SURVEY_S + RTL_S + LANDING_S

function freshChecks(): PreflightCheck[] {
  return [
    { id: 'gps', label: 'GPS lock', detail: '3D fix · 17 satellites', done: false },
    { id: 'link', label: 'Telemetry link', detail: '96 % · 38 ms', done: false },
    { id: 'battery', label: 'Battery', detail: '6S · 25.1 V · 100 %', done: false },
    { id: 'camera', label: 'Camera stream', detail: 'CSI 1280×720 @ 30 fps', done: false },
    { id: 'model', label: 'Detector engine', detail: 'YOLOv8 · TensorRT FP16', done: false },
    { id: 'fence', label: 'Geofence', detail: '10 × 10 m block armed', done: false },
  ]
}

export class MissionSimulator {
  private listeners = new Set<Listener>()
  private detectionListeners = new Set<DetectionListener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private silent = false

  // --- scenario state ---
  private phase: SimPhase = 'standby'
  private phaseS = 0
  private paused = false
  private speed = 1
  private checks: PreflightCheck[] = freshChecks()
  private launchedWall: number | null = null
  private landedWall: number | null = null
  /** Sim seconds since launch. Drives the mission clock. */
  private elapsedS = 0
  /** Wall-clock anchor for timestamps: sim time is mapped onto real time. */
  private wallAnchor = Date.now()

  // --- vehicle state ---
  private position: LatLng = HOME
  private altM = 0
  private headingDeg = 25
  private groundSpeed = 0
  private battery = 100
  private surveyM = 0
  private legM = 0
  /** Guided mode: the point the operator clicked. Overrides the survey route while set. */
  private guidedTarget: LatLng | null = null
  /** Rejoining the survey route after guided mode: where the leg started, and metres flown. */
  private rejoinFrom: LatLng | null = null
  private rejoinM = 0

  // --- products ---
  private detections: Detection[] = []
  private pending: Detection[] = [...ALL_DETECTIONS]
  private removed = new Set<string>()
  private coveredCells = new Set<string>()
  private track: LatLng[] = []

  // --- subscription --------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  onDetection(listener: DetectionListener): () => void {
    this.detectionListeners.add(listener)
    return () => this.detectionListeners.delete(listener)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(TICK_MS / 1000), TICK_MS)
    // Outside demo mode the simulator is only a fallback picture behind the live
    // feed, so it flies on its own rather than waiting at the pad for a click.
    if (!DEMO_MODE && this.phase === 'standby') this.launch()
    else if (DEMO_MODE && this.phase === 'standby' && typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search)
      if (q.get('autoplay') === '1') this.launch()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // --- scenario controls ---------------------------------------------------

  /** Begin the sortie: pre-flight checks, then take-off. No-op unless on the pad. */
  launch(): void {
    if (this.phase !== 'standby' && this.phase !== 'complete') return
    if (this.phase === 'complete') this.resetState()
    this.launchedWall = Date.now()
    this.wallAnchor = Date.now()
    this.enter('preflight')
    this.paused = false
    this.emit()
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.emit()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.emit()
  }

  togglePause(): void {
    if (this.paused) this.resume()
    else this.pause()
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.25, Math.min(16, speed))
    this.emit()
  }

  /**
   * Guided mode: fly to a point and hold over it, detector running. From the pad this
   * launches first; from a return leg it turns back. The survey route resumes with
   * resumeSurvey().
   */
  goTo(p: LatLng): void {
    if (this.phase === 'landing') return
    this.guidedTarget = p
    this.rejoinFrom = null
    if (this.phase === 'standby' || this.phase === 'complete') this.launch()
    else if (this.phase === 'rtl') {
      this.legM = 0
      this.enter('survey')
    }
    this.emit()
  }

  /** Leave guided mode and fly back onto the survey route where it was left off. */
  resumeSurvey(): void {
    if (!this.guidedTarget) return
    this.guidedTarget = null
    if (this.phase === 'survey') {
      this.rejoinFrom = this.position
      this.rejoinM = 0
    }
    this.emit()
  }

  /** Abort the survey and fly home now. */
  returnHome(): void {
    if (this.phase !== 'survey' && this.phase !== 'takeoff') return
    this.guidedTarget = null
    this.rejoinFrom = null
    this.legM = 0
    this.enter('rtl')
    this.emit()
  }

  /** Fly the remainder of the sortie instantly. Detections still arrive, quietly. */
  skipToEnd(): void {
    if (this.phase === 'standby') this.launch()
    // A guided hold never ends on its own; drop it so the sortie can finish.
    this.guidedTarget = null
    this.rejoinFrom = null
    this.silent = true
    let guard = 0
    while (this.phase !== 'complete' && guard++ < 20000) this.advance(0.25)
    this.silent = false
    this.emit()
  }

  /** Back to the pad with an empty mission. */
  reset(): void {
    this.resetState()
    this.emit()
  }

  private resetState(): void {
    reviewOverrides.clear()
    clearSimFrames()
    this.phase = 'standby'
    this.phaseS = 0
    this.paused = false
    this.checks = freshChecks()
    this.launchedWall = null
    this.landedWall = null
    this.elapsedS = 0
    this.wallAnchor = Date.now()
    this.position = HOME
    this.altM = 0
    this.headingDeg = 25
    this.groundSpeed = 0
    this.battery = 100
    this.surveyM = 0
    this.legM = 0
    this.guidedTarget = null
    this.rejoinFrom = null
    this.rejoinM = 0
    this.detections = []
    this.pending = [...ALL_DETECTIONS]
    this.removed.clear()
    this.coveredCells.clear()
    this.track = []
  }

  private enter(phase: SimPhase): void {
    this.phase = phase
    this.phaseS = 0
  }

  // --- simulation ----------------------------------------------------------

  private tick(realDt: number): void {
    if (this.paused || this.phase === 'standby' || this.phase === 'complete') {
      // Still emit at a slow cadence so clocks and link readouts stay alive.
      this.emit()
      return
    }
    // Large speed-ups are sub-stepped so a fast pass cannot jump over a target.
    let dt = realDt * this.speed
    while (dt > 0) {
      const step = Math.min(0.25, dt)
      this.advance(step)
      dt -= step
    }
    this.emit()
  }

  private advance(dt: number): void {
    if (this.phase === 'standby' || this.phase === 'complete') return
    this.phaseS += dt
    this.elapsedS += dt
    const prev = this.position

    switch (this.phase) {
      case 'preflight': {
        const n = Math.min(this.checks.length, Math.floor((this.phaseS / PREFLIGHT_S) * (this.checks.length + 0.6)))
        this.checks = this.checks.map((c, i) => (i < n && !c.done ? { ...c, done: true } : c))
        if (this.phaseS >= PREFLIGHT_S) {
          this.checks = this.checks.map((c) => (c.done ? c : { ...c, done: true }))
          this.enter('takeoff')
        }
        break
      }
      case 'takeoff': {
        const t = Math.min(1, this.phaseS / TAKEOFF_S)
        // Ease-out climb: fast off the ground, settling onto survey height.
        this.altM = SURVEY_ALT_M * (1 - Math.pow(1 - t, 2.2))
        this.headingDeg = this.turnToward(bearingDeg(HOME, SURVEY_START), dt)
        this.battery -= dt * 0.32
        if (t >= 1) {
          this.legM = 0
          this.enter('survey')
        }
        break
      }
      case 'survey': {
        this.altM = SURVEY_ALT_M + Math.sin(this.elapsedS / 7) * 0.25
        this.battery -= dt * 0.26
        if (this.guidedTarget) {
          // Guided: straight at the picked point, faster over long distances, then hold.
          const target = this.guidedTarget
          const remaining = distanceM(this.position, target)
          if (remaining > 0.02) {
            const step = Math.max(TRANSIT_MS, Math.min(15, remaining * 0.6)) * dt
            this.headingDeg = this.turnToward(bearingDeg(this.position, target), dt)
            this.position = remaining <= step ? target : lerpLatLng(this.position, target, step / remaining)
          }
          this.markCoverage(this.position)
          this.detectTargets()
        } else if (this.rejoinFrom) {
          // Back from guided mode: fly to where the survey route was left, then carry on.
          const from = this.rejoinFrom
          const to = positionAtDistance(Math.min(this.surveyM, SERPENTINE_M - 0.001))
          const total = Math.max(0.01, distanceM(from, to))
          const speed = Math.max(TRANSIT_MS, Math.min(15, (total - this.rejoinM) * 0.6))
          this.rejoinM = Math.min(total, this.rejoinM + speed * dt)
          this.position = lerpLatLng(from, to, this.rejoinM / total)
          this.headingDeg = this.turnToward(bearingDeg(from, to), dt)
          this.detectTargets()
          if (this.rejoinM >= total) {
            this.rejoinFrom = null
            this.legM = APPROACH_M
          }
        } else if (this.legM < APPROACH_M) {
          // Approach leg from the pad to the first lane.
          this.legM = Math.min(APPROACH_M, this.legM + TRANSIT_MS * dt)
          this.position = lerpLatLng(HOME, SURVEY_START, APPROACH_M > 0 ? this.legM / APPROACH_M : 1)
          this.headingDeg = this.turnToward(bearingDeg(HOME, SURVEY_START), dt)
        } else {
          this.surveyM = Math.min(SERPENTINE_M, this.surveyM + CRUISE_MS * dt)
          this.position = positionAtDistance(Math.min(this.surveyM, SERPENTINE_M - 0.001))
          this.headingDeg = this.turnToward(headingAtDistance(Math.min(this.surveyM, SERPENTINE_M - 0.3)), dt, 360)
          this.markCoverage(this.position)
          this.detectTargets()
          if (this.surveyM >= SERPENTINE_M) {
            this.legM = 0
            this.enter('rtl')
          }
        }
        break
      }
      case 'rtl': {
        if (this.legM === 0) this.rtlFrom = this.position
        const from = this.rtlFrom ?? this.position
        const total = Math.max(0.01, distanceM(from, HOME))
        this.legM = Math.min(total, this.legM + TRANSIT_MS * dt)
        this.position = lerpLatLng(from, HOME, this.legM / total)
        this.altM += (SURVEY_ALT_M - this.altM) * Math.min(1, dt * 2)
        this.headingDeg = this.turnToward(bearingDeg(from, HOME), dt)
        this.battery -= dt * 0.24
        if (this.legM >= total) this.enter('landing')
        break
      }
      case 'landing': {
        const t = Math.min(1, this.phaseS / LANDING_S)
        this.altM = SURVEY_ALT_M * Math.pow(1 - t, 1.6)
        this.battery -= dt * 0.18
        if (t >= 1) {
          this.altM = 0
          this.landedWall = this.wallAt(this.elapsedS)
          this.enter('complete')
        }
        break
      }
    }

    this.groundSpeed = dt > 0 ? distanceM(prev, this.position) / dt : 0
    if (this.altM > 0.15) {
      const last = this.track[this.track.length - 1]
      if (!last || distanceM(last, this.position) > TRACK_STEP_M) this.track.push(this.position)
    }
  }

  private rtlFrom: LatLng | null = null

  /** Yaw toward a bearing at a finite rate, the short way round. */
  private turnToward(target: number, dt: number, rateDegS = 140): number {
    const d = ((((target - this.headingDeg) % 360) + 540) % 360) - 180
    const max = rateDegS * dt
    const step = Math.abs(d) <= max ? d : Math.sign(d) * max
    return (this.headingDeg + step + 360) % 360
  }

  /** Release every target the aircraft is now directly over. */
  private detectTargets(): void {
    if (!this.pending.length) return
    const still: Detection[] = []
    for (const target of this.pending) {
      if (distanceM(target.position, this.position) > DETECT_RADIUS_M) {
        still.push(target)
        continue
      }
      if (this.removed.has(target.id)) continue
      // Render the frame the camera saw at this instant; its box is the target's
      // true projection into it.
      const bbox = captureSimFrame(target.id, target.position, {
        position: this.position,
        altM: this.altM,
        headingDeg: this.headingDeg,
      })
      const d: Detection = {
        ...target,
        capturedAt: new Date(this.wallAt(this.elapsedS)).toISOString(),
        captureAltitudeM: Number(this.altM.toFixed(1)),
        review: { state: 'unreviewed' },
        ...(bbox ? { bbox, frameWidth: SIM_FRAME_W, frameHeight: SIM_FRAME_H, frameUri: `sim:frame/${target.id}`, gradCamUri: `sim:gradcam/${target.id}` } : {}),
      }
      this.detections = [...this.detections, d]
      if (!this.silent) this.detectionListeners.forEach((l) => l(d))
    }
    this.pending = still
  }

  /**
   * Mark the cells the camera has imaged at nadir: the strip half a lane either side
   * of the track. Wider than that would credit fringes the lens barely saw.
   */
  private markCoverage(position: LatLng): void {
    for (const dn of [-LANE_STEP_M / 2, 0, LANE_STEP_M / 2]) {
      const here = cellAt(MISSION.grid, offsetM(position, 0, dn))
      if (here) this.coveredCells.add(cellId(here.col, here.row))
    }
  }

  /** Map a sim-elapsed instant onto wall time. */
  private wallAt(simS: number): number {
    return (this.launchedWall ?? this.wallAnchor) + simS * 1000
  }

  // --- snapshot assembly ---------------------------------------------------

  private flightMode(): FlightMode {
    switch (this.phase) {
      case 'takeoff':
        return 'GUIDED'
      case 'survey':
        return this.guidedTarget ? 'GUIDED' : 'MANUAL'
      case 'rtl':
      case 'landing':
        return 'RTL'
      default:
        return 'LOITER'
    }
  }

  private buildTelemetry(): Telemetry {
    const armed = this.phase === 'takeoff' || this.phase === 'survey' || this.phase === 'rtl' || this.phase === 'landing'
    const batteryPct = Math.max(8, Math.round(this.battery))
    const t = this.elapsedS
    return {
      timestamp: new Date(this.phase === 'standby' ? Date.now() : this.wallAt(t)).toISOString(),
      position: this.position,
      altitudeM: Number(this.altM.toFixed(2)),
      groundSpeedMs: Number(this.groundSpeed.toFixed(1)),
      headingDeg: Math.round(this.headingDeg),
      batteryPct,
      batteryVolts: Number((25.2 * (0.82 + (batteryPct / 100) * 0.18)).toFixed(1)),
      satellites: this.phase === 'standby' ? 14 : 16 + (Math.floor(t / 13) % 3),
      gpsFix: '3d',
      linkPct: 92 + (Math.floor(t / 5) % 6),
      mode: this.flightMode(),
      armed,
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

  private buildSim(): SimState {
    const phaseDur: Partial<Record<SimPhase, number>> = {
      preflight: PREFLIGHT_S,
      takeoff: TAKEOFF_S,
      survey: SURVEY_S,
      rtl: RTL_S,
      landing: LANDING_S,
    }
    let phaseProgress = 0
    if (this.phase === 'complete') phaseProgress = 1
    else if (this.phase === 'survey') {
      phaseProgress = Math.min(1, (this.legM / TRANSIT_MS + this.surveyM / CRUISE_MS) / SURVEY_S)
    } else if (phaseDur[this.phase]) phaseProgress = Math.min(1, this.phaseS / phaseDur[this.phase]!)
    const missionProgress =
      this.phase === 'standby' ? 0 : this.phase === 'complete' ? 1 : Math.min(0.999, this.elapsedS / SORTIE_S)
    return {
      phase: this.phase,
      paused: this.paused,
      speed: this.speed,
      phaseProgress,
      missionProgress,
      checks: this.checks,
      targetsTotal: ALL_DETECTIONS.length,
      targetsFound: this.detections.length,
      launchedAt: this.launchedWall ? new Date(this.launchedWall).toISOString() : null,
      landedAt: this.landedWall ? new Date(this.landedWall).toISOString() : null,
      guidedTarget: this.guidedTarget,
      guided: !this.guidedTarget
        ? null
        : this.phase === 'survey' && distanceM(this.position, this.guidedTarget) <= 0.02
          ? 'holding'
          : 'flying',
    }
  }

  snapshot(): MissionSnapshot {
    return {
      telemetry: this.buildTelemetry(),
      progress: this.buildProgress(),
      detections: [...this.detections],
      streamState: 'live',
      link: SIMULATED_LINK,
      sim: this.buildSim(),
    }
  }

  private emit(): void {
    const snap = this.snapshot()
    this.listeners.forEach((l) => l(snap))
  }

  // --- local mutations ----------------------------------------------------

  /** Apply a review decision and re-emit. Seeded rows have no server copy. */
  reviewDetection(id: string, review: Detection['review']): void {
    const idx = this.detections.findIndex((d) => d.id === id)
    if (idx >= 0) {
      this.detections = this.detections.map((d, i) => (i === idx ? { ...d, review } : d))
      this.emit()
    }
  }

  /** Drop a row for the rest of the session; it will not be re-detected. */
  removeDetection(id: string): void {
    this.removed.add(id)
    const before = this.detections.length
    this.detections = this.detections.filter((d) => d.id !== id)
    if (this.detections.length !== before) this.emit()
  }
}

/** Every seeded target, for screens that describe the full mission. */
export { ALL_DETECTIONS }

/** Approximate sortie length in sim seconds, for the demo panel. */
export const SORTIE_SECONDS = SORTIE_S

/** One shared instance — the app has a single live mission. */
export const simulator = new MissionSimulator()
