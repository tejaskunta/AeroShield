import L from 'leaflet'
import {
  ESRI_ATTRIBUTION,
  ESRI_LABELS_URL,
  ESRI_MAX_NATIVE_ZOOM,
  ESRI_WORLD_IMAGERY_URL,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
} from '@/lib/config'
import { seamlessTileLayer } from './seamlessTiles'

/**
 * Basemap definitions — the one place tile URLs and their licensing live.
 *
 * ── Why Esri World Imagery ────────────────────────────────────────────────────
 *
 * It is keyless, open, and served to zoom 19 with real ground detail. That matters
 * here for a specific, already-observed reason: the console's previous imagery came
 * from Mapbox behind a `VITE_MAPBOX_TOKEN` that lived in a gitignored `.env.local`.
 * A fresh clone and a second laptop therefore silently served a coarser basemap, and
 * two people on the same commit described maps differing by a factor of four in
 * ground scale with nothing on screen to explain it. The build guard that grew out of
 * that (`assertImageryToken`) is now gone along with the token, because there is
 * nothing left to be missing.
 *
 * ── `{z}/{y}/{x}` is not a typo ──────────────────────────────────────────────
 *
 * Esri's ArcGIS REST tile scheme puts the **row before the column**: `{z}/{y}/{x}`.
 * Leaflet's own convention is `{z}/{x}/{y}`. Getting this backwards does not fail —
 * it renders a perfectly plausible aerial photograph of somewhere else entirely,
 * which is far worse than a blank map because it looks correct. The ordering is
 * pinned by a unit test for exactly that reason.
 *
 * ── Hybrid is two layers, not a styled one ───────────────────────────────────
 *
 * ArcGIS serves imagery and cartographic labels as separate services, so "hybrid"
 * here is genuinely imagery plus a reference layer. That is also why the two imagery
 * modes are visibly different — with a single styled layer they were not, and the
 * Hybrid control appeared to do nothing at all.
 */

export type Basemap = 'satellite' | 'hybrid' | 'roadmap'

/** Operator-facing names. Short, because they sit inside a three-up switch. */
export const BASEMAP_LABELS: Record<Basemap, string> = {
  hybrid: 'Hybrid',
  satellite: 'Satellite',
  roadmap: 'Street',
}

/**
 * The highest zoom at which any tile service here has real pixels.
 *
 * Both Esri World Imagery and OSM stop at 19. Above that Leaflet upscales the
 * deepest tile, which is the right behaviour — the alternative is a blank view at
 * exactly the moment the operator has zoomed in to look closely.
 */
export const NATIVE_TILE_ZOOM = ESRI_MAX_NATIVE_ZOOM

/**
 * The tiles for a basemap, in draw order (first is bottom).
 *
 * Returned as an array rather than a single layer because Hybrid needs two. Callers
 * group them so one add/remove disposes of all of them.
 */
export function basemapTileLayers(basemap: Basemap, maxZoom: number): L.GridLayer[] {
  /*
   * Seamless canvas tiles (seamlessTiles.ts) rather than L.tileLayer: past the
   * imagery's native zoom, Leaflet's CSS-stretched <img> tiles showed a pale seam
   * along every tile edge on a real GPU. These are drawn at the map's own zoom.
   */
  const common = {
    maxZoom,
    nativeZoom: NATIVE_TILE_ZOOM,
    // Load during the pan, not after: this map follows a moving aircraft.
    updateWhenIdle: false,
    // Two tiles of buffer, so a small pan reveals downloaded imagery, not a gap.
    keepBuffer: 2,
  }

  if (basemap === 'roadmap') {
    return [
      seamlessTileLayer({
        ...common,
        url: OSM_TILE_URL,
        subdomains: 'abc',
        attribution: OSM_ATTRIBUTION,
        // Dimmed street canvas, so hazard red stays the most saturated thing on screen.
        className: 'aeroshield-tiles-street',
      }),
    ]
  }

  const imagery = seamlessTileLayer({
    ...common,
    url: ESRI_WORLD_IMAGERY_URL,
    attribution: ESRI_ATTRIBUTION,
    // A mild haze correction (index.css); Esri's photo over this block is washed out.
    className: 'aeroshield-tiles-imagery',
    sharpen: 0.85,
  })

  if (basemap === 'satellite') return [imagery]

  // Hybrid: imagery, then Esri's reference labels (same product, same credit).
  const labels = seamlessTileLayer({ ...common, url: ESRI_LABELS_URL, opacity: 0.9 })
  return [imagery, labels]
}

/**
 * The attribution a basemap obliges the page to show.
 *
 * Kept beside the layers because the obligation and the tiles are the same fact. Esri
 * asks for the credit wherever World Imagery is drawn, and OSM's ODbL asks for both
 * the credit and a link — the `attributionControl` renders both, so this string is
 * consumed rather than merely decorative.
 */
export function basemapAttribution(basemap: Basemap): string {
  return basemap === 'roadmap' ? OSM_ATTRIBUTION : ESRI_ATTRIBUTION
}

/** How deep a basemap's imagery is real (the readout's "capped zN"). Esri and OSM both stop at 19. */
export function basemapNativeDepth(_basemap: Basemap): number {
  return NATIVE_TILE_ZOOM
}
