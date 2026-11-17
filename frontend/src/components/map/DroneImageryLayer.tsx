import { useEffect, useState } from 'react'
import L from 'leaflet'
import { useMap } from './mapContext'

/**
 * DroneImageryLayer — the one source of real detail at zoom 21-23.
 *
 * No satellite or aerial provider has real pixels past z20 over the survey block
 * (measured; see the provider table in lib/config.ts). Commercial satellites stop
 * near 30 cm/px. z22 is 3.6 cm/px and z23 1.8 cm/px, which only a camera a few tens
 * of metres up can deliver. So the block's sharp imagery is a photo the drone takes
 * itself, straight down, pinned to the map by `scripts/georef_overlay.py` from
 * markers placed on the block's four corners.
 *
 * The script writes two files the dev server serves as static assets:
 *
 *   public/overlay/block.json   { image, bounds: [[s,w],[n,e]], capturedAt, cmPerPx, rmsErrorCm }
 *   public/overlay/block.webp   the photo, warped north-up to exactly those bounds
 *
 * With no photo made yet the JSON 404s and this draws nothing and says nothing: the
 * satellite basemap is the map, as before.
 *
 * Drawn in its own pane between the tiles (200) and the vector overlays (400), so
 * the grid, coverage, track, pins and drone all stay on top of the photo.
 */
export interface DroneOverlayMeta {
  image: string
  bounds: [[number, number], [number, number]]
  capturedAt: string
  cmPerPx: number
  /** Null when only the four corners were marked: an exact fit, so unchecked. */
  rmsErrorCm: number | null
}

const OVERLAY_BASE = '/overlay/'
const PANE = 'aeroshield-drone-imagery'

function isMeta(x: unknown): x is DroneOverlayMeta {
  const m = x as DroneOverlayMeta
  return (
    !!m &&
    typeof m.image === 'string' &&
    Array.isArray(m.bounds) &&
    m.bounds.length === 2 &&
    m.bounds.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite)) &&
    typeof m.capturedAt === 'string'
  )
}

/** The photo's metadata, or null when none has been made. Read once per mount. */
export function useDroneOverlay(): DroneOverlayMeta | null {
  const [meta, setMeta] = useState<DroneOverlayMeta | null>(null)
  useEffect(() => {
    let live = true
    fetch(`${OVERLAY_BASE}block.json`, { cache: 'no-store' })
      // Content type, not just status: the dev server answers an unknown path with
      // the app's index.html and a 200, so `ok` alone would hand HTML to the parser.
      .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? r.json() : null))
      .then((j: unknown) => {
        if (live && isMeta(j)) setMeta(j)
      })
      // Absent is the normal state until a photo is made — not worth a console line.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return meta
}

/** "Drone photo · 18 Nov 10:42", in the operator's local time. */
export function droneOverlayLabel(meta: DroneOverlayMeta): string {
  const t = new Date(meta.capturedAt)
  if (Number.isNaN(t.getTime())) return 'Drone photo'
  const date = t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const time = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `Drone photo · ${date} ${time}`
}

export function DroneImageryLayer({ meta }: { meta: DroneOverlayMeta }) {
  const { map } = useMap()

  useEffect(() => {
    if (!map.getPane(PANE)) {
      const pane = map.createPane(PANE)
      pane.style.zIndex = '250'
      pane.style.pointerEvents = 'none'
    }
    // capturedAt as a cache key: a re-made photo replaces the file in place, and the
    // browser would otherwise keep showing the old one.
    const url = `${OVERLAY_BASE}${meta.image}?v=${encodeURIComponent(meta.capturedAt)}`
    const layer = L.imageOverlay(url, meta.bounds, { pane: PANE, interactive: false })
    layer.addTo(map)
    return () => {
      layer.remove()
    }
  }, [map, meta])

  return null
}
