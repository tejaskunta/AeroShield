import { useEffect, useRef } from 'react'
import type { Telemetry } from '@/types'
import { createDroneOverlay } from './DroneOverlay'
import type { DroneOverlayHandle } from './DroneOverlay'
import { useMap } from './mapContext'

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
 * ── The aircraft mark is a DOM overlay ─────────────────────────────────────────
 *
 * The drone is drawn from a raster PNG, and a raster `google.maps.Marker` icon cannot
 * be rotated — `Icon` has no rotation field. `Symbol` does have `rotation`, but a
 * symbol is a vector path, not a bitmap. So the aircraft is an `OverlayView` wrapping
 * an `<img>` and rotating it with CSS. See `DroneOverlay.ts`, which also explains why
 * that class has to be built lazily.
 *
 * Unlike the other layers, these two objects are created once and then *updated*.
 * Telemetry arrives several times a second and the drone is the one thing on screen
 * that moves continuously: tearing down and rebuilding its marker on every frame would
 * make it flicker, and would also reset any in-flight map animation.
 */
export function DronePlatform({ telemetry }: { telemetry: Telemetry }) {
  const { map, maps } = useMap()

  const overlayRef = useRef<DroneOverlayHandle | null>(null)
  const discRef = useRef<google.maps.Circle | null>(null)
  const frameRef = useRef<number | null>(null)

  // What the next frame should apply. Held in a ref so the scheduling effect can
  // depend on the numbers while the callback always reads the latest values — a
  // closure capturing `telemetry` here would paint one tick behind.
  const pendingRef = useRef({ lat: 0, lon: 0, altitudeM: 0, headingDeg: 0 })

  // Create once. The initial position comes from the first telemetry frame; every
  // later frame is applied by the effect below.
  useEffect(() => {
    const position = { lat: telemetry.position.lat, lng: telemetry.position.lon }

    const overlay = createDroneOverlay()
    overlay.setPosition({ lat: telemetry.position.lat, lon: telemetry.position.lon })
    overlay.setHeading(telemetry.headingDeg)
    // Above every detection pin. The drone is the one mark that must never be
    // hidden by the thing it is investigating.
    overlay.setMap(map)

    const disc = new maps.Circle({
      map,
      center: position,
      radius: footprintM(telemetry.altitudeM),
      strokeColor: '#E8E4DA',
      strokeWeight: 1,
      strokeOpacity: 0.4,
      fillColor: '#E8E4DA',
      fillOpacity: 0.06,
      clickable: false,
      zIndex: 900,
    })

    overlayRef.current = overlay
    discRef.current = disc

    pendingRef.current = {
      lat: telemetry.position.lat,
      lon: telemetry.position.lon,
      altitudeM: telemetry.altitudeM,
      headingDeg: telemetry.headingDeg,
    }

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      overlay.setMap(null)
      disc.setMap(null)
      overlayRef.current = null
      discRef.current = null
    }
    // Intentionally not dependant on the telemetry values: this effect owns the
    // objects' *existence*, the next one owns their state. Re-running it on every
    // frame would defeat the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, maps])

  // Follow the aircraft. Position, altitude and heading all move the same mark, so
  // they share one scheduled frame instead of each scheduling its own — within a
  // single tick the position and the heading both change, and there is no reason to
  // lay the aircraft out twice for one visible frame.
  useEffect(() => {
    pendingRef.current = {
      lat: telemetry.position.lat,
      lon: telemetry.position.lon,
      altitudeM: telemetry.altitudeM,
      headingDeg: telemetry.headingDeg,
    }

    // A frame is already queued; it will read the values just stored and paint them.
    if (frameRef.current !== null) return

    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null

      const overlay = overlayRef.current
      const disc = discRef.current
      if (!overlay || !disc) return

      const { lat, lon, altitudeM, headingDeg } = pendingRef.current

      overlay.setPosition({ lat, lon })
      overlay.setHeading(headingDeg)
      disc.setCenter({ lat, lng: lon })
      disc.setRadius(footprintM(altitudeM))
    })
  }, [
    telemetry.position.lat,
    telemetry.position.lon,
    telemetry.altitudeM,
    telemetry.headingDeg,
  ])

  return null
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