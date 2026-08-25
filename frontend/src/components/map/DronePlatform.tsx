import { Circle, Marker } from 'react-leaflet'
import L from 'leaflet'
import type { Telemetry } from '@/types'
import { toTuple } from '@/lib/geo'

/**
 * DronePlatform — the aircraft on the map.
 *
 * Drawn as an oriented survey glyph rather than a photo-real quadcopter: a heading
 * arrow with a camera-footprint wedge, because the two things an operator needs
 * from this mark are *which way is it pointing* and *what is it currently seeing*.
 * The footprint wedge is what makes the coverage hatch legible as it accrues —
 * you can see the swath being laid down.
 */
export function DronePlatform({ telemetry }: { telemetry: Telemetry }) {
  const { position, headingDeg, altitudeM } = telemetry

  // Camera footprint radius from altitude, assuming a ~74° diagonal FOV.
  const footprintM = altitudeM * 0.65

  return (
    <>
      {/* Live camera footprint — the ground currently being imaged. */}
      <Circle
        center={toTuple(position)}
        radius={footprintM}
        pathOptions={{
          color: '#E8E4DA',
          weight: 1,
          opacity: 0.4,
          fillColor: '#E8E4DA',
          fillOpacity: 0.06,
          interactive: false,
        }}
      />
      <Marker
        position={toTuple(position)}
        icon={droneIcon(headingDeg)}
        // The aircraft sits above every overlay; it is the one thing that moves.
        zIndexOffset={1000}
        interactive={false}
      />
    </>
  )
}

/**
 * The glyph as a divIcon holding inline SVG.
 *
 * Rebuilt on each heading change, which is cheap at 2 Hz and keeps rotation in the
 * SVG rather than fighting Leaflet's marker transform.
 */
function droneIcon(headingDeg: number): L.DivIcon {
  const svg = `
    <svg width="34" height="34" viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg"
         style="transform: rotate(${headingDeg}deg); transform-origin: 50% 50%;">
      <!-- heading arrow -->
      <path d="M17 3 L24 26 L17 21 L10 26 Z"
            fill="#E8E4DA" stroke="#0E141A" stroke-width="1.2" stroke-linejoin="round"/>
      <!-- nose tick, so orientation is unambiguous at small size -->
      <path d="M17 3 L17 9" stroke="#0E141A" stroke-width="1.4"/>
    </svg>`

  return L.divIcon({
    html: svg,
    className: 'aeroshield-pin',
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}
