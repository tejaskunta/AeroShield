/**
 * Vite's client types (`import.meta.env`) are NOT pulled in automatically here:
 * tsconfig.json pins `"types": ["node"]`, which suppresses the ambient
 * `vite/client` include. So the one env var this app reads is declared by hand —
 * a file that lies about the shape it returns is worse than one that admits it is
 * a fixture, and the same honesty applies to types.
 */
interface ImportMetaEnv {
  /**
   * Vite's own flag, true under `vite dev` and false in a production build.
   *
   * Declared by hand for the same reason as everything else here — this file is the
   * only place the app's env shape is written down. It gates development
   * instrumentation that would otherwise ship: the scale readout on the map, which
   * reports how many pixels a metre of ground is worth, how wide the survey block
   * therefore draws, and how wide the viewport actually is in metres.
   */
  readonly DEV: boolean

  /**
   * Dashboard-scoped API key (detections:read + review) sent as X-API-Key.
   * Set in `frontend/.env.local`. With it unset, `lib/api.ts` keeps every call on
   * its fixture fallback, so the zero-key classroom demo still runs.
   */
  readonly VITE_DASHBOARD_KEY?: string

  /**
   * Google Maps JavaScript API key. Required for the dashboard map: the basemap is
   * drawn with the Maps JS API. Public by construction (it is inlined into the
   * browser bundle), so it must be referrer-restricted in Google Cloud.
   *
   * Absent, the map renders its own "map unavailable" state rather than failing
   * silently — an operator must never be left guessing whether the map broke or
   * the mission did.
   */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string

  /** Optional Google Cloud Map ID, for cloud-styled maps. */
  readonly VITE_GOOGLE_MAPS_MAP_ID?: string

  /**
   * Live MJPEG feed from the Jetson. Empty string disables the in-app feed;
   * undefined falls back to the default in `lib/config.ts`.
   *
   * Prefer the relative `/jetson/stream` path: Chromium blocks a cross-origin
   * `multipart/x-mixed-replace` subresource with `ERR_BLOCKED_BY_ORB`, so a direct
   * URL to the aircraft paints nothing in Chrome even though it works in Firefox.
   */
  readonly VITE_JETSON_STREAM_URL?: string

  /**
   * Bare `scheme://host:port` of the Jetson. Only used for the "Open direct" link
   * in the camera PiP, which navigates to the aircraft and so cannot be relative.
   * Ignored when `VITE_JETSON_STREAM_URL` is already absolute.
   */
  readonly VITE_JETSON_DIRECT_ORIGIN?: string

  /**
   * Survey grid SW corner as `"lat,lon"` — the SW corner of the 10 m × 10 m block
   * on the KMIT campus, Narayanaguda, Hyderabad. Must match the Jetson's
   * `--sim-origin`, or the aircraft's GPS and the grid diverge. Six decimal places
   * are needed: four is ~11 m of latitude, wider than the whole block.
   */
  readonly VITE_SURVEY_ORIGIN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
