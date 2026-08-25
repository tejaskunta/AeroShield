import type { LatLng, MissionGrid } from '@/types'

/**
 * Geodesy and coordinate formatting.
 *
 * Distances use a local flat-earth approximation rather than full geodesic maths.
 * Over a survey grid a few hundred metres across, the error is centimetres —
 * far below GPS noise — and it keeps the A* planner cheap enough to run on every
 * drag. Anything spanning more than a few kilometres would need real geodesics.
 */

const EARTH_RADIUS_M = 6_371_000
const DEG = Math.PI / 180

/** Metres per degree of latitude. Effectively constant. */
export const M_PER_DEG_LAT = (EARTH_RADIUS_M * DEG)

/** Metres per degree of longitude at a given latitude — shrinks toward the poles. */
export function mPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos(lat * DEG)
}

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * M_PER_DEG_LAT
  const dLon = (b.lon - a.lon) * mPerDegLon((a.lat + b.lat) / 2)
  return Math.hypot(dLat, dLon)
}

/** Initial bearing a → b, in compass degrees (0 = north, clockwise). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * M_PER_DEG_LAT
  const dLon = (b.lon - a.lon) * mPerDegLon((a.lat + b.lat) / 2)
  const deg = Math.atan2(dLon, dLat) / DEG
  return (deg + 360) % 360
}

/** Move a point by a metre offset. `east`/`north` are signed. */
export function offsetM(origin: LatLng, east: number, north: number): LatLng {
  return {
    lat: origin.lat + north / M_PER_DEG_LAT,
    lon: origin.lon + east / mPerDegLon(origin.lat),
  }
}

/** Linear interpolation between two points, `t` in 0..1. */
export function lerpLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }
}

/** Leaflet wants `[lat, lng]` tuples; our types use named fields. */
export function toTuple(p: LatLng): [number, number] {
  return [p.lat, p.lon]
}

// ---------------------------------------------------------------------------
// Coordinate formatting
// ---------------------------------------------------------------------------

/**
 * Decimal degrees with hemisphere suffix, e.g. `31.6127N`.
 *
 * Four decimals ≈ 11 m, which matches the system's real positional accuracy.
 * Printing more digits would imply a precision the geotagging does not have.
 */
export function formatLatLng(p: LatLng): string {
  const ns = p.lat >= 0 ? 'N' : 'S'
  const ew = p.lon >= 0 ? 'E' : 'W'
  return `${Math.abs(p.lat).toFixed(4)}${ns}  ${Math.abs(p.lon).toFixed(4)}${ew}`
}

/** Degrees-and-decimal-minutes, the format Mission Planner shows. */
export function formatLatLngDM(p: LatLng): string {
  const part = (v: number, pos: string, neg: string) => {
    const hemi = v >= 0 ? pos : neg
    const abs = Math.abs(v)
    const deg = Math.floor(abs)
    const min = (abs - deg) * 60
    return `${deg}°${min.toFixed(3)}'${hemi}`
  }
  return `${part(p.lat, 'N', 'S')} ${part(p.lon, 'E', 'W')}`
}

/** Distances read differently at different scales; pick the sensible unit. */
export function formatDistance(m: number): string {
  if (m < 1) return `${(m * 100).toFixed(0)} cm`
  if (m < 1000) return `${m.toFixed(0)} m`
  return `${(m / 1000).toFixed(2)} km`
}

export function formatArea(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2).toLocaleString()} m²`
  return `${(m2 / 10_000).toFixed(2)} ha`
}

/** `hh:mm:ss` — elapsed flight time, not a wall clock. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

/** Zulu time, as flight logs record it. */
export function formatZulu(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
}

/** Compass point for a heading — quicker to read than three digits at a glance. */
export function compassPoint(deg: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return points[Math.round(((deg % 360) / 22.5)) % 16] ?? 'N'
}

// ---------------------------------------------------------------------------
// Survey grid
// ---------------------------------------------------------------------------

/**
 * Grid references are spreadsheet-style: columns are letters west→east, rows are
 * numbers south→north, so `C4` is the third column, fourth row. This is how
 * survey cells get named on paper and over radio, which is the point — the UI
 * label and the spoken label must be the same string.
 */
export function cellId(col: number, row: number): string {
  return `${String.fromCharCode(65 + col)}${row + 1}`
}

export function parseCellId(id: string): { col: number; row: number } | null {
  const m = /^([A-Z])(\d+)$/.exec(id)
  if (!m || !m[1] || !m[2]) return null
  return { col: m[1].charCodeAt(0) - 65, row: Number(m[2]) - 1 }
}

/** South-west corner of a grid cell. */
export function cellOrigin(grid: MissionGrid, col: number, row: number): LatLng {
  return offsetM(grid.origin, col * grid.cellSizeM, row * grid.cellSizeM)
}

/** `[[swLat, swLon], [neLat, neLon]]` — a Leaflet rectangle for one cell. */
export function cellBounds(
  grid: MissionGrid,
  col: number,
  row: number,
): [[number, number], [number, number]] {
  const sw = cellOrigin(grid, col, row)
  const ne = offsetM(sw, grid.cellSizeM, grid.cellSizeM)
  return [[sw.lat, sw.lon], [ne.lat, ne.lon]]
}

/** Which cell a position falls in, or null if outside the grid. */
export function cellAt(grid: MissionGrid, p: LatLng): { col: number; row: number } | null {
  const north = (p.lat - grid.origin.lat) * M_PER_DEG_LAT
  const east = (p.lon - grid.origin.lon) * mPerDegLon(grid.origin.lat)
  const col = Math.floor(east / grid.cellSizeM)
  const row = Math.floor(north / grid.cellSizeM)
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return null
  return { col, row }
}

/** Centre of the whole grid — the map's initial view. */
export function gridCenter(grid: MissionGrid): LatLng {
  return offsetM(
    grid.origin,
    (grid.cols * grid.cellSizeM) / 2,
    (grid.rows * grid.cellSizeM) / 2,
  )
}

export function gridBounds(grid: MissionGrid): [[number, number], [number, number]] {
  const ne = offsetM(grid.origin, grid.cols * grid.cellSizeM, grid.rows * grid.cellSizeM)
  return [[grid.origin.lat, grid.origin.lon], [ne.lat, ne.lon]]
}
