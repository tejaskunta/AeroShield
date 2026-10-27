import { useEffect, useRef } from 'react'
import type { Telemetry } from '@/types'
import { droneSymbol } from './markerGlyphs'
import { useMap } from './mapContext'
import { useZoomScale } from './useMapHooks'

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
 * ── Port note ────────────────────────────────────────────────────────────────────
 *
 * In Leaflet the heading was applied as an inline CSS transform on an SVG inside a
 * `divIcon`, and rotating a DOM element about its own centre is fiddly enough that it
 * was the classic source of off-by-a-few-pixels marker skew. Maps `Symbol` has a
 * native `rotation`, measured clockwise from north — the same convention compass
 * headings already use — so the whole transform dance disappears.
 *
 * Unlike the other layers, these two objects are created once and then *updated*.
 * Telemetry arrives several times a second and the drone is the one thing on screen
 * that moves continuously: tearing down and rebuilding its marker on every frame would
 * make it flicker, and would also reset any in-flight map animation.
 */
export function DronePlatform({ telemetry }: { telemetry: Telemetry }) {
  const { map, maps } = useMap()
  const scale = useZoomScale()

  const markerRef = useRef<google.maps.Marker | null>(null)
  const discRef = useRef<google.maps.Circle | null>(null)

  // Create once. The initial position comes from the first telemetry frame; every
  // later frame is applied by the effect below.
  useEffect(() => {
    const position = { lat: telemetry.position.lat, lng: telemetry.position.lon }

    const marker = new maps.Marker({
      map,
      position,
      icon: droneSymbol(telemetry.headingDeg, scale),
      // Above every detection pin. The drone is the one mark that must never be
      // hidden by the thing it is investigating.
      zIndex: 1000,
      clickable: false,
      title: 'Drone',
    })

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

    markerRef.current = marker
    discRef.current = disc

    return () => {
      google.maps.event.clearInstanceListeners(marker)
      marker.setMap(null)
      disc.setMap(null)
      markerRef.current = null
      discRef.current = null
    }
    // Intentionally not dependant on the telemetry values: this effect owns the
    // objects' *existence*, the next one owns their state. Re-running it on every
    // frame would defeat the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, maps])

  // Follow the aircraft. Position, heading and the footprint disc all move together.
  useEffect(() => {
    const marker = markerRef.current
    const disc = discRef.current
    if (!marker || !disc) return

    const position = { lat: telemetry.position.lat, lng: telemetry.position.lon }
    marker.setPosition(position)
    disc.setCenter(position)
    disc.setRadius(footprintM(telemetry.altitudeM))
  }, [telemetry.position.lat, telemetry.position.lon, telemetry.altitudeM])

  // Heading, separately — so a change in heading does not also touch geometry that
  // has not moved.
  useEffect(() => {
    const marker = markerRef.current
    if (!marker) return
    marker.setIcon(droneSymbol(telemetry.headingDeg, scale))
  }, [telemetry.headingDeg, scale])

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