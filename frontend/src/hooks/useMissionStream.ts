import { useEffect, useRef, useState } from 'react'
import type { Detection, LinkStatus, StreamState, Telemetry } from '@/types'
import {
  fetchLatestTelemetry,
  fetchTelemetryTrack,
  findMissionByName,
  isReachable,
  listDetections,
  missionSocketUrl,
  toDetection,
  toLatestTelemetry,
  type BackendDetectionRow,
  type BackendOutcome,
  type BackendTelemetryLatest,
} from '@/lib/api'
import { HAS_LIVE_MISSION, MISSION_NAME } from '@/lib/config'
import { plottablePath } from '@/lib/geo'
import { mergeDetections } from '@/lib/mergeDetections'
import { reviewOverrides } from '@/lib/reviewOverrides'
import { simulator, type MissionSnapshot } from '@/lib/simulation'
import type { LatLng } from '@/types'

/**
 * How often to ask the backend where the aircraft is, in milliseconds.
 *
 * Matches the drone's beacon rate (`--telemetry-hz 1.0`). Polling faster than the
 * aircraft reports would return the same row repeatedly and buy nothing; polling
 * slower would make the marker lag a walk that covers a 10 m block in a minute.
 */
const POLL_MS = 1000

/**
 * How long a frame stays "live" before the map admits it has gone quiet, in
 * seconds. Deliberately a few beacon intervals: one missed POST is a dropped
 * packet, not a lost link, and flapping the status to "offline" on a single
 * hiccup would teach an operator to ignore the indicator.
 */
const STALE_AFTER_S = 5

/**
 * Reconnect backoff for the mission socket, in milliseconds.
 *
 * Capped rather than exponential-to-infinity: a backend restart during a demo
 * must recover in a few seconds, not in a minute. A few retries at this rate and
 * the hook gives up on the socket and leaves the polling loop to it, so a socket
 * endpoint that does not exist at all cannot spin forever.
 */
const SOCKET_RETRY_MS = 2000
const SOCKET_MAX_ATTEMPTS = 5

/**
 * How often to re-read the flown track, in milliseconds.
 *
 * The track only grows, and it is drawn from history rather than from the live
 * frame, so re-reading it at the beacon rate would be ten times the traffic for a
 * polyline nobody can see move. Ten seconds keeps a growing tail on screen while
 * staying well inside the ingest budget.
 *
 * It is a REFRESH, not a subscription: the live frame already carries the newest
 * position, and it is appended to the track locally (see `appendToTrack`) so the
 * line does not lag a poll interval behind the marker. This exists to pick up
 * history this browser never saw - a dashboard opened mid-flight, or frames that
 * arrived while the tab was asleep.
 */
const TRACK_REFRESH_MS = 10_000

/** How many track frames to ask for. Ten minutes at 1 Hz; the backend clamps it. */
const TRACK_LIMIT = 600

/**
 * The first and last timestamps of the observed track.
 *
 * Kept beside the points rather than inside them because the polyline only ever
 * reads `lat`/`lon`, and threading a third field through every map layer to reach
 * one label would be a lot of surface for one number.
 */
interface TrackSpan {
  startedAt: string | null
  endedAt: string | null
}

/**
 * Flight duration implied by the observed track, in seconds.
 *
 * Returns 0 rather than null when the span is unusable, because every consumer
 * already treats 0 as "nothing to show" and a nullable here would push the same
 * `?? 0` into the analytics screen.
 *
 * The arithmetic is on the DRONE's timestamps (`captured_at`), not arrival times.
 * Arrival time is when the laptop heard about a frame, which during a spool replay
 * is all at once; the drone's own clock is the one the flight happened on, and
 * `telemetry.py` stores it for exactly this reason.
 */
function deriveElapsed(span: TrackSpan): number {
  if (!span.startedAt || !span.endedAt) return 0
  const start = Date.parse(span.startedAt)
  const end = Date.parse(span.endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0
  return Math.round((end - start) / 1000)
}

/** A frame from `/api/ws/missions/{id}`. See `backend/app/services/broadcast.py`. */
interface SocketFrame {
  type: 'telemetry' | 'detection' | 'ping'
  data: unknown
}

/**
 * Subscribe to the live mission.
 *
 * This hook is the swap point named in the plan: consumers subscribe to a single
 * `MissionSnapshot` shape and neither know nor care which source produced it.
 *
 * TWO SOURCES, IN THAT ORDER:
 *
 *   1. The backend, when `VITE_MISSION_NAME` names a mission that exists and the
 *      aircraft has reported. Position then comes from the real GPS.
 *   2. The in-process `MissionSimulator`, otherwise.
 *
 * The backend side itself has TWO TRANSPORTS, tried in this order:
 *
 *   a. `/api/ws/missions/{id}` — a socket, which is told when a frame arrives.
 *   b. `GET .../telemetry/latest` — polling at 1 Hz, if the socket will not stay up.
 *
 * The socket is preferred because it is the difference between learning about a
 * new position in milliseconds and in up to a second, and because one open socket
 * costs nothing while ten open tabs polling cost ten requests a second against the
 * drone's own ingest budget. Polling is kept, not deprecated, because a push
 * transport that is silently unavailable (a proxy missing `ws: true`, a backend
 * that rolled over mid-demo) must degrade to "a bit more latent" rather than to
 * "no aircraft on the map". Both transports emit the same JSON and both go
 * through `toLatestTelemetry`, so the adapter underneath is not observable.
 *
 * ONE WATCHDOG FOR BOTH. Staleness is judged from the arrival time of the last
 * frame, not from the transport's own opinion of itself: a socket that is
 * connected but silent is exactly the "radio link is down" case, and it would
 * otherwise keep a stale marker looking live forever.
 *
 * WHAT IS REAL AND WHAT IS NOT, PER FIELD. Telemetry, detections, and the flown
 * track are real when a live mission is configured. Coverage and the review
 * workflow's seed rows stay simulated, because the backend cannot answer for them:
 * the drone uploads finds and positions but no coverage grid. So a screenshot of
 * this dashboard mid-flight shows a real aircraft at a real coordinate, carrying
 * real finds, along the path it actually flew - over a synthetic block.
 * The per-detection `source` field says which is which, and the map draws it.
 *
 * THE TRACK IS EVIDENCE, NOT DECORATION. `progress.track` is the one field whose
 * whole value is that it is a record of what happened, so it is the field that must
 * never be invented when a real one is available. It is seeded from
 * `GET .../telemetry` (history, oldest first) and extended locally as live frames
 * arrive, so the line is behind the marker by at most one frame instead of by one
 * poll. When the backend cannot answer - keyless demo, no mission yet - the
 * simulator's `progress.track` is used unchanged and the map is exactly what it was
 * before this existed. The choice is per-snapshot, not per-field, so the dashboard
 * never draws a synthetic line and a real marker at the same time.
 *
 * DETECTIONS ARE ADDED, NOT SUBSTITUTED. The simulator keeps releasing its seeded
 * block; the backend's rows are merged in alongside them and de-duplicated by id.
 * That is deliberate: the keyless demo has no backend and no rows, so removing the
 * seeded list would empty the Detection Center on the one machine that is being
 * demonstrated. When there is no backend, `listDetections` returns `[]` and
 * nothing here runs at all.
 *
 * The honest consequence: with a live aircraft the marker leaves the drawn block,
 * because the block is 10 x 10 m and the real walk is not. That is the correct
 * thing to draw. A position snapped onto the grid to look tidy would be a
 * fabricated position, and the whole point of telemetry is that it is observed.
 *
 * `onDetection` fires once per newly-arrived detection, separate from the snapshot
 * stream, so a component can trigger a one-shot effect (ping ripple, ticker push)
 * without diffing detection arrays on every tick.
 */
export function useMissionStream(onDetection?: (d: Detection) => void): MissionSnapshot | null {
  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null)
  const cb = useRef(onDetection)
  cb.current = onDetection

  // The simulator's latest snapshot. Held in a ref as well as state so the poll
  // below can merge onto the newest one without re-subscribing to the simulator
  // every time a detection lands.
  const base = useRef<MissionSnapshot | null>(null)

  /**
   * The real aircraft's contributions, held apart from the simulator's.
   *
   * These must survive the simulator re-emitting twice a second, so they cannot
   * live inside its snapshot. They are also each independently optional: a
   * backend may have detections but no position yet (the drone posts finds before
   * its first GPS fix), and a position but no finds.
   */
  const realTelemetry = useRef<Telemetry | null>(null)
  const realStreamState = useRef<StreamState | null>(null)
  const realLink = useRef<LinkStatus | null>(null)
  const realDetections = useRef<Detection[]>([])

  /**
   * The flown track, as observed. Empty until the backend answers.
   *
   * Held in a ref for the same reason as the fields above: the simulator re-emits
   * twice a second and must not be able to reset it. An empty array is the honest
   * "nothing observed yet" value and is what makes the fallback to the simulator's
   * track safe - see `compose`.
   */
  const realTrack = useRef<LatLng[]>([])

  /** The observed track's first and last timestamps, for elapsed-time derivation. */
  const realTrackMeta = useRef<TrackSpan>({ startedAt: null, endedAt: null })

  /**
   * Append one live position to the observed track.
   *
   * Called on every live frame so the polyline ends at the marker rather than at
   * the last history refresh. Points are not de-duplicated: a stationary aircraft
   * reports the same position repeatedly and a repeated vertex is harmless in a
   * polyline, while the dedupe test ("has it moved more than X metres?") would be a
   * second, subtly different thinning rule competing with the backend's.
   *
   * The track is not capped here. The backend bounds what it returns and this only
   * ever adds the frames that arrived since, which is at most the length of the
   * session; a six-minute flight at 1 Hz is a 360-vertex polyline.
   */
  const appendToTrack = useRef((p: LatLng, at: string | null): void => {
    if (!plottablePath([p]).length) return
    realTrack.current = [...realTrack.current, p]
    if (!at) return
    // A live frame is normally the newest point, so it moves the end of the span.
    // The start is set by history - but if this browser saw the first frame of the
    // flight itself, that frame IS the start, and leaving it null would date the
    // whole mission to whenever the history call happened to return.
    //
    // The end only ever moves FORWARD. A spool replay uploads old positions after
    // newer ones, so the arrival order is not the flight order; taking the last
    // arrival would shorten the flight every time a backlog drained and could make
    // `endedAt < startedAt`, which `deriveElapsed` would read as zero.
    const span = realTrackMeta.current
    const end = span.endedAt
    const advanced = end === null || Date.parse(at) > Date.parse(end)
    realTrackMeta.current = {
      startedAt: span.startedAt ?? at,
      endedAt: advanced ? at : end,
    }
  })

  /**
   * Overlay what is real onto one simulator frame.
   *
   * One function rather than four call sites doing their own spread, because every
   * one of those call sites has to remember to carry `realDetections` forward and
   * the first one to forget silently drops the drone's finds off the map.
   *
   * Detections are **replaced, not appended**, once a live mission is configured.
   * The simulator's seeded block is a keyless-demo fallback: its rows are invented
   * fixtures whose frames are `placeholder:frame/...`, and three carry a pre-baked
   * review verdict. Mixing those into a live feed would put synthetic landmines
   * beside real ones with nothing on screen to tell them apart — and because they
   * were appended first they were also what a reviewer saw at the top of the
   * contact sheet. `mergeDetections` owns that decision and its tests.
   *
   * De-duplication of the *real* rows happens at admission (`addDetection`), not
   * here: the same row legitimately arrives twice (initial load, socket snapshot,
   * reconnect replay) and is filtered by id there.
   */
  const compose = useRef((b: MissionSnapshot): MissionSnapshot => {
    // Which track to draw is decided ONCE, here, and the answer applies to the
    // whole snapshot.
    //
    // The rule is "a real track, once there is one, replaces the simulated one
    // entirely" - not "append the real points to the simulated ones". Mixing them
    // would draw a synthetic walk from the survey origin joined to the aircraft's
    // actual position by a straight line across however far apart they are, and
    // that line is a flight path the aircraft never flew. A one-way swap also means
    // the moment the first frame is observed the map stops drawing fiction, which
    // is the property that matters: a partial track is honest, a blended one is not.
    //
    // `coveredCells` and the detections count stay from the simulator even while
    // the track is real, because the backend has no answer for them. `elapsedS` is
    // the exception: it is derivable from the track itself (last frame time minus
    // first), and leaving it on the simulator clock would date a real flight to the
    // fixture epoch - which is the bug that made the analytics timeline show a
    // six-minute mission for a forty-second walk. See `deriveElapsed`.
    const track = realTrack.current.length > 0 ? realTrack.current : b.progress.track
    const elapsedS = realTrack.current.length > 1 ? deriveElapsed(realTrackMeta.current) : b.progress.elapsedS
    return {
      telemetry: realTelemetry.current ?? b.telemetry,
      progress: { ...b.progress, track, elapsedS },
      streamState: realStreamState.current ?? b.streamState,
      // Review decisions are overlaid last, after the merge, because neither feed
      // owns them: the simulator only knows its seeds, and the backend re-sends
      // its rows with whatever review it had at write time. Applying them here
      // means a decision survives every subsequent tick from either source.
      detections: reviewOverrides.apply(
        mergeDetections(b.detections, realDetections.current, HAS_LIVE_MISSION),
      ),
      // Once the backend has said anything at all, its link status wins: the
      // simulator's own status is a constant that would otherwise mask a dead
      // socket forever.
      link: realLink.current ?? b.link,
    }
  })

  useEffect(() => {
    const unsub = simulator.subscribe((s) => {
      base.current = s
      setSnapshot(compose.current(s))
    })
    const unsubDet = simulator.onDetection((d) => cb.current?.(d))
    simulator.start()
    return () => {
      unsub()
      unsubDet()
      // The simulator is a shared singleton; leave it running so navigating
      // between screens doesn't reset the mission. It is stopped only on unload.
    }
  }, [])

  useEffect(() => {
    if (!HAS_LIVE_MISSION) return

    let cancelled = false
    let missionId: number | null = null

    // Transport handles. Exactly one of the socket / poll timer is active at a
    // time; the watchdog runs for both, because silence means the same thing
    // whichever way we were expecting to hear.
    let socket: WebSocket | null = null
    let socketRetry: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setInterval> | undefined
    let trackTimer: ReturnType<typeof setInterval> | undefined

    let socketAttempts = 0
    /** Set once reconnect attempts are exhausted; polling takes over for good. */
    let socketGaveUp = false
    let polling = false

    /**
     * Whether the backend has ever proved it is running.
     *
     * Starts false and flips on the first response that is not `unreachable`.
     * One-way on purpose: a single dropped request must not repaint a healthy
     * console as broken, and the state that matters is whether we have ever had
     * a conversation, not whether the last packet got through.
     */
    let reachable = false
    /** Set when a probe fails at the network level. Cleared by the next success. */
    let lastProbeUnreachable = false

    /** When we last managed to read a frame. Null until the first one. */
    let lastAt: number | null = null

    /**
     * What the stream indicator should say right now.
     *
     * Two independent facts decide it and they can disagree, so they are resolved
     * in one place rather than at each call site: whether a frame has ever been
     * read, and whether the last probe reached the backend at all.
     *
     * A cold load with the API down is the case that forced this out. Nothing has
     * ever arrived, so the age check never fires, `realStreamState` stays null and
     * `compose` falls through to the simulator's own state - which is the constant
     * 'live'. The rail therefore read "Stream live" for a console that had never
     * spoken to anything. The simulator's constant is a fixture for the keyless
     * demo, not evidence, and it must not be allowed to answer this question.
     */
    const deriveStreamState = (): StreamState => {
      if (lastAt !== null && Date.now() - lastAt <= STALE_AFTER_S * 1000) {
        // Fresh: `apply` has already judged the frame itself.
        return realStreamState.current ?? 'stalled'
      }
      // Nothing inside the freshness window. Which word is right depends on
      // whether the backend is answering: "stalled" blames the aircraft and
      // "unreachable" blames this machine, and picking the wrong one sends
      // someone to the wrong end of the radio link.
      if (lastProbeUnreachable) return 'unreachable'
      // Heard from nothing at all yet, and the probes are getting through: we are
      // still asking. Reporting 'stalled' here would accuse an aircraft on the
      // bench of being silent when the console has only just been opened.
      return lastAt === null ? 'connecting' : 'stalled'
    }

    /** The transport currently carrying telemetry. */
    let transport: LinkStatus['transport'] = 'none'

    /**
     * Publish the current transport view.
     *
     * Called from every place that changes transport, reachability, or attempt
     * count, so the status rail never has to infer any of it. Cheap: one spread
     * over the newest simulator frame and a single setState, at most a few times
     * a second and usually far less.
     */
    const publishLink = (): void => {
      realLink.current = {
        source: realTelemetry.current ? 'backend' : 'simulator',
        transport,
        socketAttempts,
        socketGaveUp,
        reachable,
      }
      const b = base.current
      if (b) setSnapshot(compose.current(b))
    }

    /**
     * Record one probe result, then republish if it changed anything.
     *
     * The status is derived from the probe rather than set directly so there is
     * exactly one place that decides what an outcome means, and the socket and the
     * poll cannot drift apart in how they interpret the same failure.
     *
     * The `changed` test covers two independent things. Reachability is monotonic
     * (see `reachable`), so it only fires once. The second term catches a move
     * between `unreachable` and a backend that answered with an error, because
     * those two need different words on screen even though neither is healthy.
     */
    const noteOutcome = (outcome: BackendOutcome<unknown>): void => {
      const nowReachable = isReachable(outcome)
      const nowUnreachable = outcome.outcome === 'unreachable'
      const changed = nowReachable !== reachable || nowUnreachable !== lastProbeUnreachable
      reachable = reachable || nowReachable
      lastProbeUnreachable = nowUnreachable
      if (changed) publishLink()
    }

    /** Consecutive polls that produced nothing — a mission we should re-resolve. */
    let misses = 0

    /** Publish a real position over the simulated frame, keeping everything else. */
    const apply = (telemetry: Telemetry, live: boolean): void => {
      const b = base.current
      if (!b) return
      lastAt = Date.now()
      realTelemetry.current = telemetry
      realStreamState.current = live ? 'live' : 'stalled'
      // The newest observed position joins the observed track here rather than in
      // the history refresh, so the line and the marker end at the same place.
      appendToTrack.current(telemetry.position, telemetry.timestamp)
      const link: LinkStatus = {
        source: 'backend',
        transport,
        socketAttempts,
        socketGaveUp,
        reachable: true,
      }
      realLink.current = link
      setSnapshot({ ...compose.current(b), telemetry, streamState: realStreamState.current, link })
    }

    /**
     * Admit the aircraft has gone quiet, if it has.
     *
     * Driven by wall time rather than by a failed read: a socket delivers nothing
     * when the drone stops beaconing, and it does not error when that happens. If
     * staleness were inferred from transport failures, a live-looking marker would
     * sit on a dead aircraft's last position indefinitely - which is the single
     * most misleading thing this dashboard could do.
     *
     * The message is re-evaluated on every tick rather than only when a probe
     * fails, so it can also recover by itself: if the backend comes back while the
     * aircraft is still quiet, the wording moves from "unreachable" to "stalled"
     * without anyone reloading the page.
     */
    const ageOutIfStale = (): void => {
      const b = base.current
      if (!b) return
      // Runs even when `lastAt` is null, which is what lets a cold load that never
      // heard anything admit the backend is unreachable instead of trusting the
      // simulator's constant. See `deriveStreamState`.
      const state = deriveStreamState()
      if (state === realStreamState.current) return
      realStreamState.current = state
      realLink.current = {
        source: realTelemetry.current ? 'backend' : 'simulator',
        transport,
        socketAttempts,
        socketGaveUp,
        reachable,
      }
      // Use compose() so backend detections are merged, not dropped.
      setSnapshot({ ...compose.current(b), streamState: state })
    }

    /**
     * Admit one detection the backend reported.
     *
     * De-duplicated by id because the same row can arrive twice by design: once in
     * the initial `listDetections` load, again as a socket frame if it landed while
     * that request was in flight, and again on every reconnect (the socket's first
     * frame is a snapshot, and a frame after a gap replays what was missed). An
     * unguarded append here would show the same find three times and make the count
     * on the rail a lie.
     *
     * Firing `onDetection` only for genuinely new ids is what keeps that callback's
     * contract — "once per newly-arrived detection" — true when the socket is
     * catching up.
     */
    const addDetection = (d: Detection): void => {
      if (realDetections.current.some((x) => x.id === d.id)) return
      realDetections.current = [...realDetections.current, d]
      // A detection arrival means the link is alive — reset the staleness timer.
      lastAt = Date.now()
      const b = base.current
      if (b) setSnapshot(compose.current(b))
      cb.current?.(d)
    }

    /**
     * Load the detections already on the server.
     *
     * Without this a dashboard opened mid-mission shows only what arrives from now
     * on — an empty Detection Center while the aircraft has in fact recorded finds,
     * which reads as "nothing found" rather than "not loaded". Run once per mount,
     * off the mission id rather than a name, and after the resolve so a missing
     * mission (before the first flight) costs no request.
     */
    const loadDetections = async (id: number): Promise<void> => {
      const rows = await listDetections(id)
      if (cancelled || rows.length === 0) return
      const seen = new Set(realDetections.current.map((x) => x.id))
      const fresh = rows.filter((d) => !seen.has(d.id))
      if (fresh.length === 0) return
      realDetections.current = [...realDetections.current, ...fresh]
      const b = base.current
      if (b) setSnapshot(compose.current(b))
    }

    /** Resolve the mission by name, once. Absent is normal before the first flight. */
    const resolveMission = async (): Promise<number | null> => {
      if (missionId !== null) return missionId
      const result = await findMissionByName(MISSION_NAME)
      noteOutcome(result)
      if (result.outcome === 'ok') {
        missionId = result.value
        void loadDetections(missionId)
        void loadTrack(missionId)
        return missionId
      }
      return null
    }

    /**
     * Load the flown track, then keep it fresh.
     *
     * Runs once when the mission resolves and again on a timer, because the track
     * is history rather than a live value: a browser opened mid-flight has none of
     * it, and a tab that was backgrounded missed everything that arrived while the
     * timer was throttled.
     *
     * Deliberately does NOT touch the link status. The track is a convenience drawn
     * from rows that already exist; if this one call fails the aircraft is not
     * necessarily silent and reporting it as such would send the operator after the
     * wrong thing. `fetchLatestTelemetry` owns that verdict.
     */
    const loadTrack = async (id: number): Promise<void> => {
      const result = await fetchTelemetryTrack(id, TRACK_LIMIT)
      if (cancelled || result.outcome !== 'ok') return
      // The history is authoritative for everything it covers, so it REPLACES the
      // local accumulation instead of being appended to it. Appending would double
      // every point that arrived both live and in history.
      realTrack.current = plottablePath(result.value.points)
      realTrackMeta.current = {
        startedAt: result.value.startedAt,
        endedAt: result.value.endedAt,
      }
      const b = base.current
      if (b) setSnapshot(compose.current(b))
    }

    /**
     * Seed the track immediately on mount, without waiting for the first timer tick.
     *
     * The timer alone would leave a dashboard opened mid-flight with an empty map
     * for ten seconds while the socket was already drawing a live marker - the
     * exact moment someone opens it, because nothing is happening yet.
     */
    const loadTrackForCurrentMission = async (): Promise<void> => {
      const id = await resolveMission()
      if (cancelled || id === null) return
      await loadTrack(id)
    }

    /** Poll the track on its own slow cadence, for the life of this subscription. */
    const startTrackRefresh = (): void => {
      const tick = async (): Promise<void> => {
        if (cancelled) return
        const id = await resolveMission()
        if (cancelled || id === null) return
        await loadTrack(id)
      }
      trackTimer = setInterval(() => void tick(), TRACK_REFRESH_MS)
    }

    // --- transport (b): polling -----------------------------------------

    const startPolling = (): void => {
      if (polling || cancelled) return
      polling = true
      transport = 'polling'
      publishLink()

      const tick = async (): Promise<void> => {
        if (polling === false || cancelled) return
        const id = await resolveMission()
        if (cancelled || !polling) return
        if (id === null) {
          misses += 1
          return
        }

        const result = await fetchLatestTelemetry(id)
        noteOutcome(result)
        if (cancelled || !polling) return

        if (result.outcome !== 'ok') {
          misses += 1
          // The mission was deleted out from under us, or the backend restarted
          // onto a fresh database. Re-resolve rather than polling a dead id.
          // `absent` is the only outcome that means the id may be wrong; a
          // network failure says nothing about the mission's existence, so
          // re-resolving on it would spend the next tick on the same failure.
          if (result.outcome === 'absent' && misses % 10 === 0) missionId = null
          return
        }

        misses = 0
        // Trust the backend's own freshness verdict first, then our own: the
        // server knows when the row was written, we know when we last read one.
        const latest = result.value
        const ageS = latest.ageS
        const fresh = latest.live && (ageS === null || ageS <= STALE_AFTER_S)
        apply(latest.telemetry, fresh)
      }

      const loop = async (): Promise<void> => {
        await tick()
        if (cancelled || !polling) return
        pollTimer = setTimeout(loop, POLL_MS)
      }

      void loop()
    }

    const stopPolling = (): void => {
      polling = false
      if (pollTimer !== undefined) {
        clearTimeout(pollTimer)
        pollTimer = undefined
      }
    }

    // --- transport (a): the socket --------------------------------------

    /**
     * Handle one frame from the socket.
     *
     * Three frame types, dispatched by the envelope's own `type` rather than by
     * sniffing the payload: `telemetry`, `detection`, `ping`.
     *
     * `detection` reuses `toDetection`, the same mapper the polling list route
     * goes through. Two mappers for one wire shape is how a socket frame and a
     * polled row end up disagreeing about which field is the position. It returns
     * null for a row with no fix, and that null is kept rather than coerced: a
     * detection with no coordinate cannot be drawn on a map, and inventing one
     * would put a find at a place the aircraft never was. The image still exists
     * server-side, so nothing is lost — it simply is not plottable.
     *
     * `ping` exists to keep the connection open and carries no state by design.
     * Acting on it would turn a keep-alive into a fake position update.
     */
    const onFrame = (event: MessageEvent<string>): void => {
      if (cancelled) return
      let frame: SocketFrame
      try {
        frame = JSON.parse(event.data) as SocketFrame
      } catch {
        return // A frame we cannot parse is a frame we ignore, not a crash.
      }
      if (frame.type === 'detection') {
        const d = toDetection(frame.data as BackendDetectionRow)
        if (d) addDetection(d)
        return
      }
      if (frame.type !== 'telemetry') return

      const latest = toLatestTelemetry(frame.data as BackendTelemetryLatest)
      if (!latest) return // found=false: no position yet, keep what we have.

      const ageS = latest.ageS
      const fresh = latest.live && (ageS === null || ageS <= STALE_AFTER_S)
      apply(latest.telemetry, fresh)
    }

    const openSocket = async (): Promise<void> => {
      if (cancelled || socketGaveUp) return

      const id = await resolveMission()
      if (cancelled || socketGaveUp) return
      if (id === null) {
        // No mission yet, so there is nothing to subscribe to. Polling keeps
        // retrying the lookup and will start the socket's job if it succeeds.
        socketRetry = setTimeout(() => void openSocket(), SOCKET_RETRY_MS)
        return
      }

      const url = missionSocketUrl(id)
      if (url === null) {
        socketGaveUp = true
        startPolling()
        return
      }

      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch {
        socketGaveUp = true
        startPolling()
        return
      }
      socket = ws

      ws.onopen = (): void => {
        if (cancelled) {
          ws.close()
          return
        }
        socketAttempts = 0
        // A completed handshake is the strongest reachability proof available:
        // the backend accepted an Upgrade and is holding the connection open.
        reachable = true
        lastProbeUnreachable = false
        // The socket sends the current position immediately on connect, so the
        // poll becomes redundant the moment the handshake completes. Stopping it
        // is what makes this a swap rather than a doubling of traffic.
        stopPolling()
        transport = 'socket'
        publishLink()
      }

      ws.onmessage = onFrame

      ws.onerror = (): void => {
        // No detail is available: the browser withholds the reason for a failed
        // handshake, so there is nothing useful to log or branch on. `onclose`
        // follows and does the actual recovery.
      }

      ws.onclose = (): void => {
        socket = null
        if (cancelled || socketGaveUp) return

        socketAttempts += 1
        // Polling covers the gap whether or not another attempt is coming: a
        // reconnect takes seconds, and a marker that freezes for those seconds
        // looks like a crash.
        startPolling()

        if (socketAttempts >= SOCKET_MAX_ATTEMPTS) {
          socketGaveUp = true
          publishLink()
          return
        }
        publishLink()
        socketRetry = setTimeout(() => void openSocket(), SOCKET_RETRY_MS)
      }
    }

    // The watchdog ticks faster than the beacon so a frame aging out is noticed
    // promptly; it costs nothing because it reads no network.
    watchdog = setInterval(ageOutIfStale, POLL_MS)

    // Both transports benefit from the track, and neither owns it, so it is
    // started once for the subscription rather than per transport. It is also the
    // only path that fills in history this browser did not witness.
    void loadTrackForCurrentMission()
    startTrackRefresh()

    void openSocket()

    return () => {
      cancelled = true
      stopPolling()
      if (socketRetry !== undefined) clearTimeout(socketRetry)
      if (watchdog !== undefined) clearInterval(watchdog)
      if (trackTimer !== undefined) clearInterval(trackTimer)
      if (socket) {
        // Detach first: closing fires `onclose`, and the recovery path there must
        // not schedule a reconnect for a hook that is unmounting.
        socket.onclose = null
        socket.onerror = null
        socket.onmessage = null
        socket.close()
        socket = null
      }
    }
  }, [])

  return snapshot
}
