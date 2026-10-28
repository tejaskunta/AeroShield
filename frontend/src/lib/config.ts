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