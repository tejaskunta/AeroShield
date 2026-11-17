import type { LatLng } from '@/types'
import { offsetM } from './geo'

/**
 * The patch of ground the drone's camera sees, straight down.
 *
 * Same optics as `jetson/geo.py`, which geotags every detection: the CSI camera's
 * 62.2° horizontal field of view on a 16:9 frame, nadir-pointing, the top of the
 * frame toward the nose. So the footprint drawn on the map is exactly the area a
 * detection's pixel can be placed in — the map and the geotagging agree by
 * construction.
 *
 * A flat-ground approximation: at a few metres over a ten-metre block, terrain
 * relief is far below the GPS's own 2-3 m error.
 */
export const CAMERA_HFOV_DEG = 62.2
export const CAMERA_ASPECT = 16 / 9

export function cameraVfovDeg(hfovDeg = CAMERA_HFOV_DEG, aspect = CAMERA_ASPECT): number {
  const h = (hfovDeg * Math.PI) / 360
  return (2 * Math.atan(Math.tan(h) / aspect) * 180) / Math.PI
}

/** Ground half-extents in metres: across the frame (right) and along it (forward). */
export function footprintHalfExtents(altitudeM: number, hfovDeg = CAMERA_HFOV_DEG, aspect = CAMERA_ASPECT) {
  const alt = Math.max(0, altitudeM)
  const halfAcross = alt * Math.tan((hfovDeg * Math.PI) / 360)
  const halfAlong = alt * Math.tan((cameraVfovDeg(hfovDeg, aspect) * Math.PI) / 360)
  return { halfAcross, halfAlong }
}

/**
 * The four ground corners, clockwise from front-left, for a drone at `position`,
 * `altitudeM` above the ground, nose at `headingDeg` (0 = north, clockwise).
 */
export function cameraFootprint(position: LatLng, altitudeM: number, headingDeg: number): LatLng[] {
  const { halfAcross, halfAlong } = footprintHalfExtents(altitudeM)
  const h = (headingDeg * Math.PI) / 180
  // Forward and right unit vectors in (east, north).
  const fwd = { e: Math.sin(h), n: Math.cos(h) }
  const right = { e: Math.cos(h), n: -Math.sin(h) }
  const corner = (a: number, r: number) =>
    offsetM(position, fwd.e * a + right.e * r, fwd.n * a + right.n * r)
  return [
    corner(halfAlong, -halfAcross), // front-left
    corner(halfAlong, halfAcross), // front-right
    corner(-halfAlong, halfAcross), // back-right
    corner(-halfAlong, -halfAcross), // back-left
  ]
}
