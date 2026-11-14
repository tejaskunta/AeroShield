import L from 'leaflet'
import {
  ESRI_ATTRIBUTION,
  ESRI_LABELS_URL,
  ESRI_MAX_NATIVE_ZOOM,
  ESRI_WORLD_IMAGERY_URL,
  OSM_ATTRIBUTION,
  OSM_TILE_URL,
} from '@/lib/config'

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
export function basemapTileLayers(basemap: Basemap, maxZoom: number): L.TileLayer[] {
  const common = {
    maxZoom,
    /**
     * Leaflet's own `maxZoom` is where it stops *fetching*; this is where the tiles
     * stop being *real*. Above it the deepest tile is scaled up, so the map keeps
     * working past the imagery's resolution instead of going blank.
     */
    maxNativeZoom: NATIVE_TILE_ZOOM,
    /**
     * Load tiles during the pan rather than only once it settles.
     *
     * Leaflet defaults this to `true` on touch, which is right for a phone on a slow
     * connection and wrong here: this map follows a moving aircraft, and a view that
     * fills in only after the operator stops dragging reads as a stutter.
     */
    updateWhenIdle: false,
    /**
     * Keep two tiles of buffer beyond the viewport, so a small pan reveals content
     * that is already downloaded instead of a grey gap.
     */
    keepBuffer: 2,
    /**
     * Do not request `@2x` tiles.
     *
     * Esri's World Imagery has no retina variant at these levels, so `detectRetina`
     * would quadruple the request count for no sharpness gain and push the operator
     * into upscaled mush sooner.
     */
    detectRetina: false,
  } as const

  if (basemap === 'roadmap') {
    return [
      L.tileLayer(OSM_TILE_URL, {
        ...common,
        subdomains: 'abc',
        attribution: OSM_ATTRIBUTION,
        /**
         * The dimmed street treatment, as CSS on the tile pane rather than as a
         * fog-of-war overlay on top of it.
         *
         * This is the honest replacement for the old Maps `STREET_STYLES`: a filter
         * on the raster keeps place labels visible only at the size they were drawn,
         * so there is no risk of the geometry styling that previously flattened the
         * satellite imagery being applied here by accident. Hazard red has to be the
         * most saturated thing on this map, and a filtered street canvas is how it
         * stays that way.
         */
        className: 'aeroshield-tiles-street',
      }),
    ]
  }

  const imagery = L.tileLayer(ESRI_WORLD_IMAGERY_URL, {
    ...common,
    attribution: ESRI_ATTRIBUTION,
  })

  if (basemap === 'satellite') return [imagery]

  // Hybrid: imagery, then the reference labels above it. Labels carry no attribution
  // of their own — they are the same Esri product, already credited by the imagery.
  const labels = L.tileLayer(ESRI_LABELS_URL, {
    ...common,
    opacity: 0.9,
  })

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