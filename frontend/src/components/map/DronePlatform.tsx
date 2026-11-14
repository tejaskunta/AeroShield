import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { Telemetry } from '@/types'
import { useMap } from './mapContext'
import { CONSOLE_HEX } from '@/lib/consoleInk'

/**
 * DronePlatform — the aircraft, and the ground it can see.
 *
 * Two marks, and they answer two different questions. The glyph says *where* the
 * drone is and *which way* it is facing; the disc says *what it is currently
 * covering*, derived from the camera's field of view. Those are separate facts and
 * an operator needs both — a drone hovering over unsurveyed ground looks identical
 * to one over surveyed ground without the disc.
 *
 * The footprint is the one number on this map that is an estimate rather than a
 * measurement (`altitudeM * 0.65`, the tangent half-angle of the camera's field of
 * view). It is drawn at low opacity for exactly that reason: it is a hint about
 * coverage, not a surveyed boundary.
 *
 * ── The aircraft mark is a `divIcon`, and that deletes a bug ───────────────────
 *
 * This used to be a DOM `OverlayView` wrapping an `<img>`, and the reason was
 * conditional: `google.maps.Marker` cannot rotate a raster icon, and a `Symbol` is a
 * vector path rather than a bitmap, so there was no supported way to draw a heading.
 * `OverlayView` worked but brought its own trap — it exposes both
 * `fromLatLngToDivPixel` and `fromLatLngToContainerPixel`, and they differ by exactly
 * the map's centre. Picking the container one displaced the aircraft by half the
 * pane (measured: 724x320 container, error precisely (362,160)) — a half-map offset
 * that reads as "the GPS is wrong" rather than as a drawing bug.
 *
 * A Leaflet `divIcon` is a real DOM node whose own `transform` is how Leaflet
 * positions it, so an inner element can carry the rotation independently and neither
 * problem exists. See `droneIcon`.
 *
 * Unlike the other layers, these two objects are created once and then *updated*.
 * Telemetry arrives several times a second and the drone is the one thing on screen
 * that moves continuously: tearing down and rebuilding its marker on every frame would
 * make it flicker, and would also reset any in-flight map animation.
 */
export function DronePlatform({ telemetry }: { telemetry: Telemetry }) {
  const { map } = useMap()

  const markerRef = useRef<L.Marker | null>(null)
  const discRef = useRef<L.Circle | null>(null)
  const frameRef = useRef<number | null>(null)

  // The latest thing the aircraft reported. Telemetry arrives at about 1 Hz, so
  // this changes in steps; `shownRef` is what is actually drawn, and eases toward
  // it every animation frame. Held in refs because the render loop must read the
  // newest values without being torn down and rebuilt on each packet.
  const pendingRef = useRef({ lat: 0, lon: 0, altitudeM: 0, headingDeg: 0 })
  const shownRef = useRef({ lat: 0, lon: 0, altitudeM: 0, headingDeg: 0 })
  const paintedHeadingRef = useRef<number | null>(null)
  // Timestamp of the previous easing frame, so the filter is integrated over real
  // elapsed time rather than assuming 60 Hz. A dropped frame or a backgrounded tab
  // then slows the approach instead of skipping part of it.
  const lastFrameRef = useRef(0)

  // Create once. The initial position comes from the first telemetry frame; every
  // later frame is applied by the effect below.
  useEffect(() => {
    const marker = L.marker([telemetry.position.lat, telemetry.position.lon], {
      icon: droneIcon(telemetry.headingDeg),
      // Above every detection pin. The drone is the one mark that must never be
      // hidden by the thing it is investigating. Detection pins reach 800.
      zIndexOffset: 900,
      interactive: false,
      keyboard: false,
      alt: 'Aircraft',
    }).addTo(map)

    /*
     * Kept, but quieter than it was (0.4 -> 0.22 stroke, 0.06 -> 0.04 fill).
     *
     * The ring answers a real question the marker cannot — how much ground a single
     * frame covers — and it does so in the same `paper` ink as the track, so it
     * belongs to the same visual family. At 0.4 it competed with the pins it is
     * supposed to sit behind; at 0.22 it is legible when looked for and ignorable
     * when not.
     */
    const disc = L.circle([telemetry.position.lat, telemetry.position.lon], {
      radius: footprintM(telemetry.altitudeM),
      color: CONSOLE_HEX.paper,
      weight: 1,
      opacity: 0.22,
      fillColor: CONSOLE_HEX.paper,
      fillOpacity: 0.04,
      interactive: false,
      pane: 'overlayPane',
    }).addTo(map)

    markerRef.current = marker
    discRef.current = disc

    pendingRef.current = {
      lat: telemetry.position.lat,
      lon: telemetry.position.lon,
      altitudeM: telemetry.altitudeM,
      headingDeg: telemetry.headingDeg,
    }
    // First frame: the aircraft starts *at* its first reported position rather than
    // easing in from the origin (0, 0) off the coast of Africa.
    shownRef.current = { ...pendingRef.current }
    paintedHeadingRef.current = null
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      marker.remove()
      disc.remove()
      markerRef.current = null
      discRef.current = null
    }
    // Intentionally not dependant on the telemetry values: this effect owns the
    // objects' *existence*, the next one owns their state. Re-running it on every
    // frame would defeat the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  /*
   * Follow the aircraft, smoothly.
   *
   * Telemetry arrives at roughly 1 Hz. Positioning the marker straight from each
   * packet made a walked traverse look like a series of jumps: the aircraft stands
   * still for a second, teleports one to two metres, stands still again. The
   * movement was real; the stutter was an artefact of drawing a continuous motion
   * from discrete samples.
   *
   * So the packets set a target and an animation loop eases the drawn position
   * toward it, which is a one-euro-style low-pass filter with a time constant rather
   * than a fixed per-frame factor. Two consequences worth being explicit about:
   *
   *  1. The drawn marker trails the reported position slightly - by design. It is
   *     converging on the truth, never inventing a place the aircraft did not go.
   *     The numeric readout keeps showing the last *reported* fix, so the number is
   *     never an interpolated guess. The two disagree by a fraction of a stride,
   *     which is honest; the alternative was a number that lied.
   *  2. A jump larger than `SNAP_M` is not eased. That is the first fix, a GPS
   *     reacquisition, or a mission switch - cases where sliding the marker across
   *     the map would show a traverse that never happened. Snapping is the truthful
   *     response to a discontinuity.
   *
   * The loop runs only while the marker is converging, so a stationary aircraft
   * costs nothing: once within `SETTLE_M` the frame is not re-queued until the next
   * packet arrives.
   */
  useEffect(() => {
    pendingRef.current = {
      lat: telemetry.position.lat,
      lon: telemetry.position.lon,
      altitudeM: telemetry.altitudeM,
      headingDeg: telemetry.headingDeg,
    }

    // A loop is already converging; it will pick up the new target next frame.
    if (frameRef.current !== null) return

    frameRef.current = requestAnimationFrame(step)
    // `step` is stable per render and reads only refs, so it is safe to omit: the
    // effect's purpose is to wake the loop when a new target lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    telemetry.position.lat,
    telemetry.position.lon,
    telemetry.altitudeM,
    telemetry.headingDeg,
  ])

  /**
   * One animation frame of easing. Re-queues itself until the drawn position
   * agrees with the target, then stops and waits to be woken by the next packet.
   */
  function step(now: number) {
    frameRef.current = null

    const marker = markerRef.current
    const disc = discRef.current
    if (!marker || !disc) return

    const target = pendingRef.current
    const shown = shownRef.current

    // Wrap-safe heading difference in (-180, 180]: the shortest way round, so
    // 350° -> 10° turns right by 20° rather than left by 340°.
    const dHeading = ((((target.headingDeg - shown.headingDeg) % 360) + 540) % 360) - 180
    const movedM = planarDistanceM(shown, target)

    if (movedM > SNAP_M || !Number.isFinite(movedM)) {
      // Discontinuity: adopt it outright rather than animating a traverse that
      // nobody measured.
      shown.lat = target.lat
      shown.lon = target.lon
    } else {
      const k = 1 - Math.exp(-(now - lastFrameRef.current) / SMOOTH_TAU_MS)

      shown.lat += (target.lat - shown.lat) * k
      shown.lon += (target.lon - shown.lon) * k
    }
    shown.headingDeg = normalizeHeading(shown.headingDeg + dHeading * 0.25)
    shown.altitudeM += (target.altitudeM - shown.altitudeM) * 0.25

    marker.setLatLng([shown.lat, shown.lon])
    disc.setLatLng([shown.lat, shown.lon])
    disc.setRadius(footprintM(shown.altitudeM))

    // Rebuilding a 40 px divIcon is only worth doing when the arrow would actually
    // look different; at 1 Hz telemetry that is a real saving over 60 rebuilds a
    // second.
    const painted = paintedHeadingRef.current
    if (painted === null || Math.abs(angleDelta(painted, shown.headingDeg)) > 0.5) {
      marker.setIcon(droneIcon(shown.headingDeg))
      paintedHeadingRef.current = shown.headingDeg
    }

    // Keep going while there is anything meaningful left to close.
    lastFrameRef.current = now
    if (planarDistanceM(shown, target) > SETTLE_M) {
      frameRef.current = requestAnimationFrame(step)
    }
  }

  return null
}

/** The aircraft mark's box, in px. Fixed — the drone is an instrument, not a pin. */
const DRONE_PX = 40

/**
 * Time constant of the position filter, in ms.
 *
 * One second is chosen to match the telemetry interval: the marker reaches about
 * 63% of the way to a new fix within one reporting period, so a walked traverse
 * reads as continuous motion rather than as a series of holds. Much shorter and the
 * old stepping returns; much longer and the aircraft visibly lags the ground it is
 * flying over.
 */
const SMOOTH_TAU_MS = 1000

/**
 * Beyond this, a new fix is a discontinuity rather than motion, and is snapped to.
 *
 * A walked survey moves a metre or two per report, so 25 m is far enough above real
 * motion to never trigger on a flight, and far enough below a map's width that it
 * catches the cases that matter: the first fix after mount, GPS reacquisition after
 * a dropout, and switching to a different mission entirely.
 */
const SNAP_M = 25

/** Below this the aircraft is allowed to stop animating and wait for the next fix. */
const SETTLE_M = 0.05

const M_PER_DEG_LAT = 111320

/** Metres between two lat/lon points, on a flat plane. Fine at ten-metre scale. */
function planarDistanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (b.lat - a.lat) * M_PER_DEG_LAT
  // Longitude shrinks by cos(latitude); at 17°N that is about 95%, but deriving it
  // rather than hard-coding keeps this correct if the block ever moves.
  const dLon = (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dLat, dLon)
}

/** Fold any angle into [0, 360). */
function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Smallest signed turn from `a` to `b`, in (-180, 180]. */
function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180
}

/**
 * The aircraft glyph: an arrow that turns to show heading.
 *
 * Drawn as SVG inside a `divIcon` rather than as the PNG `public/assets/drone.png`
 * the OverlayView used. Three reasons, and the third is the one that matters:
 *
 *  1. Rotation is a `transform` on the inner `<g>`, not a CSS transform on the outer
 *     box, so the anchor Leaflet computed stays correct. Composing
 *     `translate(-50%,-50%) rotate(θ)` in one transform list — which is what the
 *     OverlayView did — shifts the mark by up to half its width as it turns.
 *  2. It inherits the console's ink rather than carrying its own palette, so the
 *     aircraft stays legible against both imagery modes and the street canvas.
 *  3. The PNG could fail to load, and the OverlayView's fallback was a clipped
 *     `div`-based triangle whose shape had to be kept in step with the image by hand.
 *     One authoring source cannot disagree with itself.
 *
 * `headingDeg` of null-or-NaN draws the dot without a heading rather than pointing
 * confidently north — a Pixhawk that has not fused a yaw yet reports 0, and 0 is
 * indistinguishable from "facing north" once it reaches the screen.
 */
export function droneIcon(headingDeg: number | null): L.DivIcon {
  const heading = Number.isFinite(headingDeg) ? (headingDeg as number) : null
  const half = DRONE_PX / 2

  /*
   * No cardinal ticks.
   *
   * There used to be four short lines at N/E/S/W, "so which way is up survives
   * even when the arrow is mid-rotation". The reasoning was sound but the premise
   * was wrong: the arrow is drawn inside a `rotate(${heading})` group, so the
   * arrowhead always points along the heading in screen space — it already says
   * which way the aircraft is facing, at every moment, with no second opinion. The
   * ticks added no information the arrow did not carry.
   *
   * What they did add was four near-white strokes (`paper` at 0.25-0.5 opacity)
   * radiating from the aircraft across ground whose whole purpose is to be
   * inspected for visual indicators. They read as artefacts on the imagery, and
   * being unconditioned — this component renders on `telemetry` alone, with no
   * layer toggle — there was no way for an operator to turn them off.
   */
  const mark =
    heading === null
      ? `<circle r="4" fill="${CONSOLE_HEX.paper}" stroke="${CONSOLE_HEX.inkDeep}" stroke-width="1.5" />`
      : `<g transform="rotate(${heading})">
           <path d="M 0,-11 L 7,8 L 0,4 L -7,8 Z"
                 fill="${CONSOLE_HEX.paper}" stroke="${CONSOLE_HEX.inkDeep}" stroke-width="1.5"
                 stroke-linejoin="round" />
         </g>`

  return L.divIcon({
    className: 'aeroshield-drone-icon',
    html:
      `<svg viewBox="-20 -20 40 40" width="${DRONE_PX}" height="${DRONE_PX}" ` +
      `xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${mark}</svg>`,
    iconSize: [DRONE_PX, DRONE_PX],
    iconAnchor: [half, half],
  })
}

/**
 * Ground area currently under the camera.
 *
 * The camera looks down at a known field of view, so the swath width grows linearly
 * with altitude — this is the tangent of the half-angle, and 0.65 corresponds to a
 * ~66° field of view. Kept as a named function rather than inlined because the
 * constant is an assumption about hardware and should be findable when the actual
 * camera is known.
 */
function footprintM(altitudeM: number): number {
  return Math.max(0, altitudeM * 0.65)
}