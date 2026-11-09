import { useEffect, useRef, useState } from 'react'
import type { Detection, StreamState, Telemetry } from '@/types'
import {
  fetchLatestTelemetry,
  findMissionByName,
  listDetections,
  missionSocketUrl,
  toDetection,
  toLatestTelemetry,
  type BackendDetectionRow,
  type BackendTelemetryLatest,
} from '@/lib/api'
import { HAS_LIVE_MISSION, MISSION_NAME } from '@/lib/config'
import { simulator, type MissionSnapshot } from '@/lib/simulation'

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
 * WHAT IS REAL AND WHAT IS NOT, PER FIELD. Telemetry and detections are swapped.
 * Coverage, the flown track, and the review workflow stay simulated, because the
 * backend cannot yet answer for them: the drone uploads finds and positions but no
 * coverage grid. So a screenshot of this dashboard mid-flight shows a real
 * aircraft at a real coordinate, carrying real finds — over a synthetic block. The
 * per-detection `source` field says which is which, and the map draws it.
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
  const realDetections = useRef<Detection[]>([])

  /**
   * Overlay what is real onto one simulator frame.
   *
   * One function rather than four call sites doing their own spread, because every
   * one of those call sites has to remember to carry `realDetections` forward and
   * the first one to forget silently drops the drone's finds off the map.
   *
   * Detections are **appended and de-duplicated by id**, not substituted. The
   * simulator's seeded block stays so the keyless demo still has material to show;
   * a backend row with the same id would win the `seen` check only if it arrived
   * first, and real ids (`D-0491`) cannot collide with seeded ones (`D-0101`).
   */
  const compose = useRef((b: MissionSnapshot): MissionSnapshot => {
    const seen = new Set(b.detections.map((d) => d.id))
    const extra = realDetections.current.filter((d) => !seen.has(d.id))
    return {
      telemetry: realTelemetry.current ?? b.telemetry,
      progress: b.progress,
      streamState: realStreamState.current ?? b.streamState,
      detections: extra.length > 0 ? [...b.detections, ...extra] : b.detections,
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

    let socketAttempts = 0
    /** Set once reconnect attempts are exhausted; polling takes over for good. */
    let socketGaveUp = false
    let polling = false

    /** When we last managed to read a frame. Null until the first one. */
    let lastAt: number | null = null
    /** Consecutive polls that produced nothing — a mission we should re-resolve. */
    let misses = 0

    /** Publish a real position over the simulated frame, keeping everything else. */
    const apply = (telemetry: Telemetry, live: boolean): void => {
      const b = base.current
      if (!b) return
      lastAt = Date.now()
      realTelemetry.current = telemetry
      realStreamState.current = live ? 'live' : 'stalled'
      setSnapshot({ ...compose.current(b), telemetry, streamState: realStreamState.current })
    }

    /**
     * Admit the aircraft has gone quiet, if it has.
     *
     * Driven by wall time rather than by a failed read: a socket delivers nothing
     * when the drone stops beaconing, and it does not error when that happens. If
     * staleness were inferred from transport failures, a live-looking marker would
     * sit on a dead aircraft's last position indefinitely - which is the single
     * most misleading thing this dashboard could do.
     */
    const ageOutIfStale = (): void => {
      if (lastAt === null) return
      if (Date.now() - lastAt <= STALE_AFTER_S * 1000) return
      const b = base.current
      if (b) {
        realStreamState.current = 'stalled'
        // Use compose() so backend detections are merged, not dropped.
        setSnapshot({ ...compose.current(b), streamState: 'stalled' })
      }
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

    /** Resolve the mission by name, once. Null is normal before the first flight. */
    const resolveMission = async (): Promise<number | null> => {
      if (missionId !== null) return missionId
      missionId = await findMissionByName(MISSION_NAME)
      if (missionId !== null) void loadDetections(missionId)
      return missionId
    }

    // --- transport (b): polling -----------------------------------------

    const startPolling = (): void => {
      if (polling || cancelled) return
      polling = true

      const tick = async (): Promise<void> => {
        if (polling === false || cancelled) return
        const id = await resolveMission()
        if (cancelled || !polling) return
        if (id === null) {
          misses += 1
          return
        }

        const latest = await fetchLatestTelemetry(id)
        if (cancelled || !polling) return

        if (!latest) {
          misses += 1
          // The mission was deleted out from under us, or the backend restarted
          // onto a fresh database. Re-resolve rather than polling a dead id.
          if (misses % 10 === 0) missionId = null
          return
        }

        misses = 0
        // Trust the backend's own freshness verdict first, then our own: the
        // server knows when the row was written, we know when we last read one.
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
        // The socket sends the current position immediately on connect, so the
        // poll becomes redundant the moment the handshake completes. Stopping it
        // is what makes this a swap rather than a doubling of traffic.
        stopPolling()
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
          return
        }
        socketRetry = setTimeout(() => void openSocket(), SOCKET_RETRY_MS)
      }
    }

    // The watchdog ticks faster than the beacon so a frame aging out is noticed
    // promptly; it costs nothing because it reads no network.
    watchdog = setInterval(ageOutIfStale, POLL_MS)

    void openSocket()

    return () => {
      cancelled = true
      stopPolling()
      if (socketRetry !== undefined) clearTimeout(socketRetry)
      if (watchdog !== undefined) clearInterval(watchdog)
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
