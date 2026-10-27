import { useEffect, useRef } from 'react'
import type { LatLng } from '@/types'
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
 * Both are single `Polyline`s. A path of several hundred points is one object to the
 * Maps API, which is why neither needs point-level chunking.
 */

/**
 * The flown track.
 *
 * Bright and solid: this is the historical record, and on a mission in progress it is
 * the only evidence of where the aircraft has been.
 */
export function TrackLayer({ points }: { points: LatLng[] }) {
  const { map, maps } = useMap()
  const lineRef = useRef<google.maps.Polyline | null>(null)

  useEffect(() => {
    const line = new maps.Polyline({
      map,
      path: toPath(points),
      strokeColor: '#E8E4DA',
      strokeWeight: 1.5,
      strokeOpacity: 0.55,
      clickable: false,
      zIndex: 400,
    })

    lineRef.current = line
    return () => {
      line.setMap(null)
      lineRef.current = null
    }
  }, [map, maps, points])

  return null
}

/**
 * A planned path — the survey pattern, or any other line that represents intent.
 *
 * Faint and dashed, so it sits under the flown track without ever being mistaken for
 * it. `dashArray` has no direct Maps equivalent, so the dashes are expressed as an
 * icon sequence with a transparent base stroke, which is the supported way to get a
 * dashed line that also works as a hit target.
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
  const { map, maps } = useMap()

  /**
   * Dash glyph. Drawn as a horizontal stroke so Maps' icon placement, which orients
   * each icon along the line's direction, lays them end to end as dashes.
   */
  const dash: google.maps.Symbol = {
    path: 'M 0,0 L 3,0',
    strokeColor: color,
    strokeOpacity: 0.9,
    strokeWeight: 1,
    scale: 1,
  }

  useEffect(() => {
    const line = new maps.Polyline({
      map,
      path: toPath(points),
      // With dashes, the base stroke carries the gaps; with solid intent, the base
      // stroke *is* the line.
      strokeColor: color,
      strokeWeight: 1,
      strokeOpacity: dashed ? 0 : 0.9,
      clickable: false,
      ...(dashed ? { icons: [{ icon: dash, offset: '0', repeat: '8px' }] } : {}),
      zIndex: 410,
    })

    return () => line.setMap(null)
    // `dash` is rebuilt each render but is structurally identical, so including it
    // here would rebuild the line on every render for no visual change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, maps, points, color, dashed])

  return null
}

/**
 * Domain points to Maps positions.
 *
 * The domain model uses `lon` (matching the backend's detection records); the Maps
 * API uses `lng`. Converting here keeps that single spelling difference from leaking
 * into every layer — see the note in `geo.ts`, which is the only place that should
 * know about the clash.
 */
function toPath(points: LatLng[]): google.maps.LatLngLiteral[] {
  return points.map((p) => ({ lat: p.lat, lng: p.lon }))
}