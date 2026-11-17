import type { LatLng } from '@/types'

/**
 * Runtime configuration.
 *
 * Every externally-supplied value the dashboard depends on is resolved here, once,
 * with its default and its failure mode spelled out. Components read from this
 * module rather than touching `import.meta.env` themselves, so there is exactly one
 * place to look when the map or the feed is not doing what someone expects — and
 * exactly one place to change when a deployment points somewhere else.
 *
 * These are build-time constants: Vite inlines `import.meta.env` at build time, so
 * changing one means restarting the dev server or rebuilding. That is why nothing
 * here is reactive.
 */

/** The browser bundle is public; these values are inlined into it verbatim. */
// Defaulted to an empty object because `import.meta.env` is a Vite construct: it does
// not exist when these modules are imported by plain Node, which is how the geo
// accuracy tests run. Without the fallback a test that only wants a survey origin
// dies on `Cannot read properties of undefined` before it asserts anything.
//
// Cast rather than annotated: `ImportMetaEnv` declares this app's keys individually
// and has no index signature, so it is not assignable to a `Record`. The cast keeps
// the reads below checked against the real declaration while still allowing the
// empty-object fallback that only Node can reach.
const env = (import.meta.env ?? {}) as ImportMetaEnv

// ---------------------------------------------------------------------------
// Live telemetry
// ---------------------------------------------------------------------------

/**
 * The backend mission whose telemetry this dashboard follows, by call-sign.
 *
 * Must match the `--mission-name` the drone was started with (`make run
 * MISSION=...`). The drone creates the mission on startup if it does not exist,
 * so the two only have to agree on the string — the dashboard then resolves it
 * to the backend's integer id by name.
 *
 * Empty by default. With it unset the dashboard never asks the backend for a
 * position and the simulator stays the only source of telemetry, which is what
 * keeps the zero-config classroom demo working exactly as before.
 */
export const MISSION_NAME: string = (env.VITE_MISSION_NAME ?? '').trim()

/** True when a mission is named, i.e. live telemetry can be attempted at all. */
export const HAS_LIVE_MISSION: boolean = MISSION_NAME.length > 0

// ---------------------------------------------------------------------------
// Basemap imagery
// ---------------------------------------------------------------------------

/**
 * Esri World Imagery tile endpoint.
 *
 * This replaces a licensed token rather than adding one. The console used to ask
 * Mapbox for deep-zoom imagery behind a `VITE_MAPBOX_TOKEN`, which meant a fresh clone
 * or a second laptop silently fell back to a coarser basemap and nobody could tell —
 * the reason `vite.config.ts` used to hard-fail a keyless production build. Esri's
 * World Imagery service is open, needs no key, and serves the whole globe, so the
 * same tiles are available on every machine from a clean clone.
 *
 * The placeholder order is `{z}/{y}/{x}` — row before column. Leaflet's own
 * convention is `{z}/{x}/{y}` and every other URL in this file follows it, so this
 * one is easy to get wrong: swap it and the map renders plausible-looking imagery of
 * somewhere else, which is far worse than a blank map because it looks fine.
 *
 * `{r}` is not used. Esri does not load-balance across subdomains, and inventing
 * `a.`/`b.`/`c.` hosts would only produce 404s.
 */
export const ESRI_WORLD_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

/**
 * Esri's native maximum. Tiles exist to z19; asking beyond that gets real tiles for
 * z19 drawn larger, which is exactly what `maxNativeZoom` in Leaflet does on purpose.
 * Recorded here so the basemap's `maxNativeZoom` and the notice in the UI cannot
 * disagree about the number.
 */
export const ESRI_MAX_NATIVE_ZOOM = 19

/**
 * The placeholder order Esri's tile endpoint uses, as a value rather than a comment.
 *
 * `{z}/{y}/{x}` — row before column, which is not what Leaflet's own
 * `{z}/{x}/{y}` convention leads anyone to expect. Swapping it does not fail: Esri
 * returns a tile from elsewhere in the pyramid, the map renders a perfectly
 * plausible aerial photograph of somewhere that is not the survey block, and every
 * position read off it is silently displaced. A comment cannot be tested; this can,
 * and `imagery.test.ts` does exactly that.
 *
 * It lives in this module, not in `MapRoot`, because `MapRoot` is a `.tsx` file and
 * Node's type-stripping test runner cannot load `.tsx` — a constant only a component
 * can reach is a constant no test can pin.
 */
export const IMAGERY_URL_ORDER: 'zyx' = 'zyx'

/**
 * Esri's reference layer — place names, boundaries, roads — drawn over imagery.
 *
 * Same ArcGIS tile scheme as the imagery itself, so the two stay registered to each
 * other without any client-side alignment. Served transparently, which is why it can
 * simply be stacked. It lives here rather than beside the basemap definitions because
 * `basemaps.ts` imports Leaflet, and a URL that a test needs to compare against the
 * imagery URL should not drag a DOM library into the test process.
 */
export const ESRI_LABELS_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'

/**
 * Standard OpenStreetMap raster tiles, for the street basemap.
 *
 * The tile usage policy requires a real `Referer` and forbids bulk downloading, both
 * of which a browser map satisfies naturally. `{s}` is substituted from Leaflet's
 * `subdomains`, which spreads requests over the three hosts OSM documents.
 */
export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * Why the satellite base stays Esri, measured at the survey origin (Nov 2026),
 * deepest zoom with real pixels:
 *
 *   Esri World Imagery         z19   (z20+ is one identical placeholder tile)
 *   Esri Clarity + Wayback     z19   (z20+ 404, across every sampled release)
 *   Bing aerial                z19   (z20+ answers `X-VE-Tile-Info: no-tile`)
 *   Google satellite           z20   (paid Map Tiles API; billing not available)
 *
 * Esri is keyless and free, and no provider is real past z20 here anyway:
 * commercial satellites stop near 30 cm/px. Detail at z21-23 comes from the drone
 * photo overlay (`DroneImageryLayer.tsx`).
 */

/** Attribution strings. Both are licence requirements, not decoration. */
export const ESRI_ATTRIBUTION = 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
export const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// ---------------------------------------------------------------------------
// Live camera feed
// ---------------------------------------------------------------------------

/**
 * Jetson MJPEG endpoint.
 *
 * `jetson/stream.py` serves `multipart/x-mixed-replace` on :8080, which an `<img>`
 * consumes directly — no fetch, no blob handling, no CORS preflight. Two viable
 * values, and the choice is about which host can reach the Jetson:
 *
 *   /jetson/stream                     same-origin; the dev server proxies it
 *   http://<jetson-ip>:8080/stream     browser talks to the Jetson directly
 *
 * The proxied path is the default because the direct one does not work in
 * Chromium. A cross-origin `multipart/x-mixed-replace` subresource is opaque to
 * the browser, and Opaque Response Blocking rejects it as `ERR_BLOCKED_BY_ORB`
 * even though the request itself succeeds — the feed never paints, and the
 * failure looks like the camera being offline. Routing through the dev server
 * makes the request same-origin and sidesteps ORB entirely.
 *
 * A production deployment has no Vite proxy, so it must either reverse-proxy the
 * same path or set this variable to a direct URL and accept the ORB limitation.
 *
 * An explicitly empty string disables the feed rather than silently falling back to
 * the default — that is the difference between "no camera in this deployment" and
 * "someone forgot to configure it", and those want different-looking screens.
 */
const DEFAULT_STREAM_URL = '/jetson/stream'
const rawStreamUrl = env.VITE_JETSON_STREAM_URL
export const JETSON_STREAM_URL: string =
  rawStreamUrl === undefined ? DEFAULT_STREAM_URL : rawStreamUrl.trim()

/** True when a feed is configured at all. Drives whether the PiP is mounted. */
export const HAS_JETSON_STREAM: boolean = JETSON_STREAM_URL.length > 0

/**
 * Where the Jetson itself lives, as a bare origin.
 *
 * Needed because the escape hatch below is a *top-level navigation to the Jetson*,
 * and a relative URL cannot express that. When the stream is already configured as
 * an absolute URL its origin is reused, so a deployment that points straight at the
 * aircraft needs only the one variable. Otherwise this comes from
 * `VITE_JETSON_DIRECT_ORIGIN`, which exists purely to keep the link working when the
 * in-app feed is proxied.
 *
 * The default is this laptop's loopback, not the aircraft's LAN address, because
 * the feed reaches the laptop through `scripts/tunnel.ps1` (`ssh -L 8080`). On a
 * phone hotspot the drone's address is whatever the DHCP lease says that day, so
 * a hardcoded LAN IP is wrong more often than right. Loopback is right whenever
 * the tunnel is up, and `scripts/dev_mjpeg.py` serves the same port for
 * rehearsals.
 */
const DEFAULT_DIRECT_ORIGIN = 'http://127.0.0.1:8080'
const rawDirectOrigin = env.VITE_JETSON_DIRECT_ORIGIN

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    // Relative — not a URL, so it carries no origin of its own.
    return undefined
  }
}

export const JETSON_DIRECT_ORIGIN: string = (
  originOf(JETSON_STREAM_URL) ??
  (rawDirectOrigin === undefined ? DEFAULT_DIRECT_ORIGIN : rawDirectOrigin.trim())
).replace(/\/+$/, '')

/**
 * The Jetson's other stream.py route: a full HTML page wrapping the same feed.
 * Offered as an "open in new tab" escape hatch — if the in-app `<img>` fails for
 * browser-specific reasons, this almost always still works.
 *
 * Deliberately the direct origin and not the proxied path, even when the feed
 * itself is proxied: the page's own markup references an absolute `/stream`, which
 * only resolves on the Jetson. Loading it through the dev server would proxy the
 * HTML but leave its `<img>` pointing at the dev server, which serves no such route.
 * A top-level navigation is also not subject to the ORB rule that blocks the
 * in-page feed, so the direct URL is both correct and safe here.
 */
export const JETSON_STREAM_PAGE_URL: string = `${JETSON_DIRECT_ORIGIN}/`

// ---------------------------------------------------------------------------
// Survey origin
// ---------------------------------------------------------------------------

/**
 * Survey grid SW corner, as `"lat,lon"`.
 *
 * This is the south-west corner of the 10 m × 10 m block the aircraft flies by hand
 * on the KMIT campus in Narayanaguda, Hyderabad — Keshav Memorial Institute of
 * Technology, off Narayanaguda Road (OpenStreetMap way 357130888). The block is the
 * whole of the flyable area, so this corner is where the pilot stands.
 *
 * It has to agree with where the aircraft actually reports GPS. The grid and the
 * drone are laid out in the same local tangent plane, so if the origin is a fixture
 * in one hemisphere and the GPS is in another, the drone lands thousands of
 * kilometres off the grid. Fitting the map to both then means zooming out until the
 * entire survey block is a few pixels wide — which is exactly why the drone could
 * not be seen.
 *
 * Note the precision. Four decimal places is ~11 m of latitude, which is wider than
 * this entire block; rounding the origin to the usual display precision would put
 * the grid off the campus. Six places are deliberate.
 *
 * `--sim-origin` in `jetson/live_detect.py` must be set to the same point or the
 * telemetry will place the aircraft somewhere else. See `.env.example`.
 */
const DEFAULT_SURVEY_ORIGIN: LatLng = { lat: 17.396947, lon: 78.490706 }

function parseLatLon(raw: string | undefined, fallback: LatLng): LatLng {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (!trimmed) return fallback

  const parts = trimmed.split(',')
  const lat = Number(parts[0])
  const lon = Number(parts[1])
  if (
    parts.length !== 2 ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    // Loud and specific, then carry on with the default. A malformed origin would
    // otherwise show up only as a map that is mysteriously centred on the wrong
    // place, which is a far worse debugging experience than one console warning.
    console.warn(
      `[aeroshield] VITE_SURVEY_ORIGIN="${raw}" is not "lat,lon" within range; ` +
        `falling back to ${fallback.lat},${fallback.lon}.`,
    )
    return fallback
  }
  return { lat, lon }
}

export const SURVEY_ORIGIN: LatLng = parseLatLon(env.VITE_SURVEY_ORIGIN, DEFAULT_SURVEY_ORIGIN)

/** True when the configured origin differs from the built-in default. */
export const HAS_CUSTOM_SURVEY_ORIGIN: boolean =
  SURVEY_ORIGIN.lat !== DEFAULT_SURVEY_ORIGIN.lat || SURVEY_ORIGIN.lon !== DEFAULT_SURVEY_ORIGIN.lon

/**
 * The ground scale a live mission map has to reach to be worth looking at, in pixels
 * per metre.
 *
 * Twelve. At this latitude that is about zoom 21.5, so it sits between two zoom
 * levels and is deliberately not tied to either: it is a statement about what an
 * operator can read, not about any provider's tiling. The survey block is ten metres
 * across, so twelve px/m draws it 120 px wide and a one-metre cell twelve pixels
 * wide — the point at which a cell is an object rather than a smudge and the
 * aircraft's sub-metre movement between frames is visible.
 *
 * Below roughly seven px/m the whole block is under seventy pixels and a real flight
 * reads as jitter, which is the failure this constant exists to catch. The map is
 * held to it by `useViewReadiness` — see `components/map/useMapHooks.ts`.
 */
export const MIN_LIVE_MAP_PX_PER_METRE = 12

/**
 * Padding around a map fit, in pixels.
 *
 * Shared between the fit itself, the readiness check that judges it, and the
 * development-time readout, so the three cannot drift apart. Smaller than it looks
 * like it should be: the search for a zoom level is integral, so a few pixels of
 * padding here can cost an entire level, which halves the scale of everything drawn
 * on the map.
 */
export const FIT_PADDING_PX = 8

/**
 * The map's zoom ceiling, and the reason it is a shared constant rather than a
 * number local to the map component.
 *
 * Satellite imagery over this survey block is native to zoom 19 (Esri) or 20
 * (Google), roughly 30 and 15 cm per pixel at this latitude, and no provider goes
 * deeper here (measured: Esri, its Wayback archive, Bing and Google all stop by
 * z20). Past that a basemap is the deepest tile drawn larger. The map nevertheless
 * goes to 23, about 1.8 cm per pixel, because the drone photo overlay
 * (`DroneImageryLayer.tsx`) carries real detail at that scale over the block, and a
 * drone-sized object is only a recognisable shape at 22-23. Over the satellite
 * base alone, 22-23 is a magnifier, not new detail, and the readout says so.
 *
 * It lives here because the diagnostic reads it. A pane tall enough to frame the
 * ten-metre block at the fit's own padding *can afford* zoom 23 in the pure
 * arithmetic, and the map then sits one level below it — at 22, correctly, because
 * that is the ceiling. Anything judging the view by comparing the affordable zoom
 * against the actual one has to know the ceiling exists, or a pan with plenty of
 * room looks exactly like a pane that has been given less than it asked for: the
 * same off-by-one, reported as a fault, at the one moment everything is working.
 */
export const MAX_LIVE_MAP_ZOOM = 23

/**
 * The highest zoom any *automatic* fit may choose — below the operator's ceiling.
 *
 * `fitBounds` with no `maxZoom` of its own uses the map's, so raising
 * `MAX_LIVE_MAP_ZOOM` to 23 would silently change the framed view the console opens
 * on. The framing was tuned at 22 and is kept there deliberately: the operator zooms
 * to 23 by hand when they want to, and the map never jumps there on its own.
 */
export const FIT_MAX_ZOOM = 22