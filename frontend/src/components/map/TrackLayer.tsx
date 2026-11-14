import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { LatLng } from '@/types'
import { CONSOLE_HEX } from '@/lib/consoleInk'
import { useMap } from './mapContext'

/**
 * The two lines on the map that describe the flight.
 *
 * They are drawn differently on purpose, because they mean different things and
 * conflating them would be a safety problem:
 *
 *   TrackLayer  the flown track — what actually happened. Solid, bright.
 *   IntentLine  the planned path — what we meant to happen. Faint, dashed.
 *
 * An operator reading a coverage gap needs to know instantly whether the drone
 * *deviated* from the plan or the plan itself left a hole. Two visually distinct
 * lines are what makes that a glance rather than an investigation.
 *
 * Both are single polylines. A path of several hundred points is one object to
 * Leaflet, which is why neither needs point-level chunking.
 */

/**
 * The flown track.
 *
 * Bright and solid: this is the historical record, and on a mission in progress it is
 * the only evidence of where the aircraft has been.
 *
 * ── The dependency here is `points.length`, and it has to be ─────────────────────
 *
 * The simulator appends to its track array in place and hands out the *same*
 * reference every tick (`buildProgress()` returns `track: this.track`). So `points`
 * is identity-stable for the whole mission, and an effect depending on `[.., points]`
 * runs exactly once — the polyline was frozen at whatever the track was on mount and
 * never extended. That is why this reads `.length`: it is the only thing that
 * changes. The line is then extended in place with `setPath`, which is also the
 * cheaper operation, since a track that grows to hundreds of points stays one object.
 */
export function TrackLayer({ points }: { points: LatLng[] }) {
  const { map } = useMap()
  const lineRef = useRef<L.Polyline | null>(null)

  // Create once per map, not once per point.
  useEffect(() => {
    const line = L.polyline(toPath(points), {
      color: CONSOLE_HEX.paper,
      weight: 1.5,
      opacity: 0.55,
      interactive: false,
      // Above the coverage hatch, below the pins — see the note in
      // `MissionGridLayer` about Leaflet drawing in insertion order.
      pane: 'overlayPane',
    }).addTo(map)

    lineRef.current = line
    return () => {
      line.remove()
      lineRef.current = null
    }
    // `points` is deliberately absent: it is a mutated array, so its identity never
    // changes and including it would express a dependency that does not exist. The
    // path is kept current by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  // Extend as the aircraft flies.
  useEffect(() => {
    // `setLatLngs` is the direct replacement for `setPath`; it reuses the existing
    // SVG path element rather than creating a new one, so a track growing to
    // hundreds of points stays one object.
    lineRef.current?.setLatLngs(toPath(points))
    // `points.length` stands in for the array's contents, which is all that can
    // change — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length])

  return null
}

/**
 * A planned path — the survey pattern, or any other line that represents intent.
 *
 * Faint and dashed, so it sits under the flown track without ever being mistaken for
 * it. Leaflet has a real `dashArray`, so this is a stroke attribute rather than the
 * Maps workaround of synthesising dashes from an icon sequence — which also means
 * the dashes scale with the line weight instead of needing their own glyph.
 */
export function IntentLine({
  points,
  color,
  dashed = false,
}: {
  points: LatLng[]
  color: string
  dashed?: boolean
}) {
  const { map } = useMap()

  useEffect(() => {
    const line = L.polyline(toPath(points), {
      color,
      weight: 1,
      opacity: 0.9,
      // `dashArray` set means dashed; absent means solid. This replaces the Maps
      // pair of "transparent base stroke plus dash icons" with one attribute.
      ...(dashed ? { dashArray: '4 4' } : {}),
      interactive: false,
      pane: 'overlayPane',
    }).addTo(map)

    // Braced so the arrow returns nothing: `line.remove()` returns the layer, and an
    // effect destructor that returns a value is a type error, not a cleanup.
    return () => {
      line.remove()
    }
  }, [map, points, color, dashed])

  return null
}

/**
 * Domain points to Leaflet lat/lng tuples.
 *
 * The domain model uses `lon` (matching the backend's detection records); Leaflet
 * uses `lng`. Converting here keeps that single spelling difference from leaking
 * into every layer — see the note in `geo.ts`, which is the only place that should
 * know about the clash. `toLatLngTuples` exists because Leaflet is internally
 * inconsistent about whether it wants objects or arrays; polylines take either, but
 * this keeps one spelling across every layer.
 */
function toPath(points: LatLng[]): L.LatLngTuple[] {
  return points.map((p): L.LatLngTuple => [p.lat, p.lon])
}