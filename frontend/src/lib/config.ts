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

/**
 * Google Maps JavaScript API key.
 *
 * Required for the map. Public by construction — it ships to the browser, so it
 * must be referrer-restricted in Google Cloud rather than kept secret here. Never
 * put a server-side or ingest key in this variable.
 */
export const GOOGLE_MAPS_API_KEY: string = (env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim()

/** True when a Maps key is present. The map shows an explicit notice when not. */
export const HAS_GOOGLE_MAPS_KEY: boolean = GOOGLE_MAPS_API_KEY.length > 0

/**
 * Optional Map ID for cloud-styled maps. Without one the map uses the built-in
 * `satellite` / `hybrid` / `roadmap` types, which is the normal case.
 */
export const GOOGLE_MAPS_MAP_ID: string | undefined =
  (env.VITE_GOOGLE_MAPS_MAP_ID ?? '').trim() || undefined

// ---------------------------------------------------------------------------
// Imagery provider
// ---------------------------------------------------------------------------

/**
 * Mapbox access token, for when Google's imagery runs out of zoom.
 *
 * This exists because of a measured ceiling, not a preference. Google's built-in
 * `satellite` and `hybrid` types stop at zoom 20 at the survey block however they are
 * asked — see `RASTER_MAX_ZOOM` below for the readings — while Mapbox serves real
 * tiles all the way to 22. That is a factor of four in ground scale, and it is the
 * whole difference between the satellite view matching the street view and being
 * unreadable next to it.
 *
 * Same secrecy rules as the Google key: a public token that ships to the browser, so
 * restrict it by URL in the Mapbox account rather than treating it as a secret. A
 * token here is optional — with none set, the imagery basemaps fall back to Google's
 * built-in types and behave exactly as they did before this existed.
 */
export const MAPBOX_TOKEN: string = (env.VITE_MAPBOX_TOKEN ?? '').trim()

/** True when a Mapbox token is present, i.e. the deep-zoom imagery path is usable. */
export const HAS_MAPBOX_TOKEN: boolean = MAPBOX_TOKEN.length > 0

/**
 * Mapbox styles used for the two imagery basemaps.
 *
 * Chosen by id, not by URL, so the look can be changed in the Mapbox account without
 * a code change. `satellite-v9` is bare imagery; `satellite-streets-v12` is imagery
 * *plus* the road and place-label layers, which is what makes it the honest
 * counterpart of Google's `hybrid` — the labels are the entire difference between
 * hybrid and satellite, so a "hybrid" built from the bare satellite style would
 * reproduce the exact bug this console already fixed once.
 *
 * Measured at the survey block, zoom 22: `satellite-streets-v12` returns 88 distinct
 * colours against `satellite-v9`'s 33, i.e. the label and road layers are present in
 * the tile rather than being empty at this depth.
 */
export const MAPBOX_STYLE_SATELLITE = 'mapbox/satellite-v9'
export const MAPBOX_STYLE_HYBRID = 'mapbox/satellite-streets-v12'

/**
 * The tile grid Mapbox is asked for, and the largest zoom its raster API serves.
 *
 * 256 is the geographic tile size, and it must match the `tileSize` handed to
 * `ImageMapType` — the two are the same number describing different things, and if
 * they disagree the map silently renders at the wrong scale. 22 is Mapbox's
 * documented maximum for raster tiles.
 *
 * The tile URL requests `@2x`, so the *bitmap* is 512x512 over that same 256-unit
 * footprint. This is not cosmetic, and it is not a zoom-range change either. A 256 px
 * tile is drawn into 256 CSS px, which on a 2x display is 512 device px: without
 * `@2x` the browser stretches every tile to double size before it reaches the screen.
 * At the ceiling, where the imagery is already magnified past its native resolution,
 * that stretch compounds the softness the operator sees. `tileSize` must stay 256
 * regardless — it describes the ground footprint, not the image dimensions, and
 * raising it to 512 would halve the apparent scale and undo the point of zoom 22.
 *
 * Note the honest limit: `@2x` sharpens the rendering of the tile. It does not add
 * detail the provider never recorded. Measured by correlating a z22 tile against the
 * same ground resampled from shallower levels, z22 is indistinguishable from a
 * magnified z21 (r = 0.999) — see `components/map/mapboxImagery.ts`. Going deeper
 * than about z19 here is past the resolution of the satellite itself.
 */
export const MAPBOX_TILE_SIZE = 256
export const MAPBOX_MAX_ZOOM = 22

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
 *   http://10.11.101.241:8080/stream   browser talks to the Jetson directly
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
 */
const DEFAULT_DIRECT_ORIGIN = 'http://10.11.101.241:8080'
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
 * operator can read, not about Google's tiling. The survey block is ten metres
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
 * Google's imagery over this survey block is native to about zoom 21 — roughly 7 cm
 * per pixel at this latitude. Zoom 22 is one step of upsampling, still readable;
 * past that it is interpolation, which looks like a broken map rather than a closer
 * one. So the map stops at 22, and that ceiling is a fact about the imagery, not
 * about the component that happens to set it.
 *
 * It lives here because the diagnostic reads it. A pane tall enough to frame the
 * ten-metre block at the fit's own padding *can afford* zoom 23 in the pure
 * arithmetic, and the map then sits one level below it — at 22, correctly, because
 * that is the ceiling. Anything judging the view by comparing the affordable zoom
 * against the actual one has to know the ceiling exists, or a pan with plenty of
 * room looks exactly like a pane that has been given less than it asked for: the
 * same off-by-one, reported as a fault, at the one moment everything is working.
 */
export const MAX_LIVE_MAP_ZOOM = 22

/**
 * The zoom ceiling the *raster* basemaps actually respect, which is not the one we
 * ask for.
 *
 * This is a measured fact about the Maps API, not a preference, and it is the reason
 * the imagery basemaps looked broken. Asking this project's map — which is raster,
 * because no Map ID is configured — for zoom 22 does not produce zoom 22. It produces
 * 20, silently, no matter how the request is made:
 *
 *   - `new Map({ zoom: 22, mapTypeId: 'satellite' })` reads back 20 and still reads
 *     20 at t = 0.5, 1.5, 3, 5 and 8 seconds. It is a settled value, not a transient.
 *   - `setZoom(22)` -> 20. `setZoom(21)` -> 20. `setZoom(20)` -> 20.
 *   - Fractional zoom is enabled here and `setZoom(21.5)` still lands on 20.
 *   - `map.maxZoom` reads 22. Every `mapTypes.get(id).maxZoom` reads 22. Assigning
 *     22 to the type's own `maxZoom` changes nothing.
 *   - `MaxZoomService.getMaxZoomAtLatLng()` over the survey block returns **20**.
 *   - The built-in raster type is a compiled class with no `getTileUrl`, so it cannot
 *     be wrapped in a custom `ImageMapType` to raise its own ceiling.
 *
 * And it is *not* a shortage of imagery. Fetching the tile URLs directly returns real
 * 256x256 tiles at z = 19, 20, 21 **and 22** for both `lyrs=s` (satellite) and
 * `lyrs=y` (hybrid). The imagery exists; this particular map type will not show it.
 *
 * The practical consequence is what the operator sees. `roadmap` has no raster layer
 * and honours 22, so it reaches 28.1 px/m and frames the ten-metre block at 281 px.
 * `satellite` and `hybrid` stop at 20 — 7.0 px/m, a 70 px block, a quarter of the
 * scale. Identical chrome, identical pane, four times coarser imagery.
 *
 * So the two ceilings are named separately and the basemap picks between them. The
 * alternative — keeping 22 as the single truth and treating 20 as a failure — is what
 * produced a permanent "below 12 px/m" warning and an endless, unwinnable refit on
 * the imagery basemaps, because a fit that cannot be satisfied is attempted again
 * until the budget runs out and then reported as the operator's problem.
 *
 * Raise this and `MAX_LIVE_MAP_ZOOM` together once imagery can actually reach 22 —
 * the licensed route is a Map ID (vector) or the Map Tiles API, both of which are
 * account-level changes rather than code ones. See `docs/` for the trade-off.
 */
export const RASTER_MAX_ZOOM = 20