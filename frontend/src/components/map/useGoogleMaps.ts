import { useEffect, useRef, useState } from 'react'
import { Loader } from '@googlemaps/js-api-loader'
import { GOOGLE_MAPS_API_KEY, HAS_GOOGLE_MAPS_KEY } from '@/lib/config'

/**
 * Load the Google Maps JavaScript API, once per page.
 *
 * The Maps API is a global singleton: it can only be loaded a single time, and a
 * second `load()` on an already-loaded page is not merely wasteful, it is the
 * documented cause of "You have included the Google Maps JavaScript API multiple
 * times" warnings and, occasionally, a half-initialised `google.maps` namespace.
 * So the loader lives at module scope — outside React's render and StrictMode's
 * double-invocation — and every component awaits the same promise.
 *
 * Styling note: the API is loaded *without* the default widget CSS being fought
 * over. The map's own chrome (zoom, scale, attribution) is styled through
 * `index.css` in one block, because Maps renders its controls as unstyled DOM and
 * an unstyled Maps control set looks nothing like the rest of this console.
 */

export type MapsStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface MapsApi {
  maps: typeof google.maps
}

/** Why the map is unusable, phrased for an operator rather than a developer. */
export interface MapsFailure {
  /** One-line summary for the map's placeholder. */
  summary: string
  /** What to do about it. */
  detail: string
  /** True when the fix is a config change rather than a network wait. */
  configuration: boolean
}

/**
 * `null` until `loadGoogleMaps` is called; the promise is memoised so N components
 * mounting at once still trigger exactly one script insertion.
 */
let apiPromise: Promise<MapsApi> | null = null

/** Did the API fail because of a bad/missing key rather than, say, no network? */
function describeFailure(err: unknown): MapsFailure {
  const message = err instanceof Error ? err.message : String(err)

  // The API reports an invalid key by invoking the callback with an error, and
  // also by loading a stub `google.maps` whose members throw. Both surface here.
  if (/invalid key|api key|ApiNotActivated|referer|not authorized/i.test(message)) {
    return {
      summary: 'Map key rejected',
      detail:
        'The Google Maps key was refused. Check that "Maps JavaScript API" is ' +
        'enabled for the key\'s project and that the key\'s HTTP-referrer ' +
        'restriction includes this origin.',
      configuration: true,
    }
  }

  if (/failed to load|network|net::|ERR_/i.test(message)) {
    return {
      summary: 'Map unavailable offline',
      detail:
        'The Google Maps script could not be fetched. The mission grid, coverage, ' +
        'and detections below are unaffected — only the background imagery is missing.',
      configuration: false,
    }
  }

  return {
    summary: 'Map failed to load',
    detail: `The Google Maps API reported: ${message}`,
    configuration: true,
  }
}

/**
 * Load (or return the already-loading) Maps API.
 *
 * Throws if no key is configured — that is a configuration error and the caller
 * renders a notice, not an empty map.
 */
export function loadGoogleMaps(): Promise<MapsApi> {
  if (apiPromise) return apiPromise

  // The loader resolves with the whole `google` namespace, not `google.maps`, so
  // the `maps` member is picked off it. Everything downstream depends only on
  // `google.maps`, which keeps the API surface this app touches auditable.
  const attempt: Promise<MapsApi> = HAS_GOOGLE_MAPS_KEY
    ? new Loader({
        apiKey: GOOGLE_MAPS_API_KEY,
        version: 'weekly',
        // Pin the libraries actually used. Every requested library is another
        // script the map view waits on before its first paint.
        libraries: ['geometry'],
        // Don't let a slow Maps CDN look like a broken dashboard.
        retries: 2,
      })
        .load()
        .then((g) => ({ maps: g.maps }))
    : Promise.reject(
        new Error(
          'No Google Maps API key configured. Set VITE_GOOGLE_MAPS_API_KEY in ' +
            'frontend/.env.local and restart the dev server.',
        ),
      )

  // The memoised copy must never be an orphaned rejection: callers get `result`
  // below and always attach a handler, but if the very first caller is unmounted
  // before it settles, this keeps the rejection from surfacing as an unhandled
  // promise. It does not swallow anything a caller would have seen.
  attempt.catch(() => {})

  const result: Promise<MapsApi> = attempt.then(
    (ok) => ok,
    (err: unknown) => {
      // Drop the memo so a later remount can retry, but still reject this call.
      apiPromise = null
      throw err
    },
  )

  apiPromise = result
  return result
}

/**
 * Hook wrapper around `loadGoogleMaps`.
 *
 * Returns a status rather than suspending: the map is the most important thing on
 * Mission Control, and a suspended subtree would blank the whole screen while the
 * Maps CDN is contacted. Showing the grid and a notice instead is strictly better
 * — the operator loses imagery, not situational awareness.
 */
export function useGoogleMaps(): {
  status: MapsStatus
  maps: typeof google.maps | null
  failure: MapsFailure | null
} {
  const [status, setStatus] = useState<MapsStatus>('idle')
  const [maps, setMaps] = useState<typeof google.maps | null>(null)
  const [failure, setFailure] = useState<MapsFailure | null>(null)

  // Guards against a late resolution writing state after unmount.
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true

    if (!HAS_GOOGLE_MAPS_KEY) {
      setStatus('error')
      setFailure({
        summary: 'Map key not configured',
        detail:
          'Set VITE_GOOGLE_MAPS_API_KEY in frontend/.env.local and restart the ' +
          'dev server. The mission grid and detections still render without it.',
        configuration: true,
      })
      return
    }

    setStatus('loading')
    loadGoogleMaps()
      .then(({ maps: api }) => {
        if (!alive.current) return
        setMaps(api)
        setStatus('ready')
        setFailure(null)
      })
      .catch((err: unknown) => {
        if (!alive.current) return
        setFailure(describeFailure(err))
        setStatus('error')
      })

    return () => {
      alive.current = false
    }
  }, [])

  return { status, maps, failure }
}

/**
 * Status of a single tile layer, tracked so the map can tell "no imagery because
 * the network is down" apart from "no imagery because Google refused the key".
 */
export function useTileHealth(): {
  tilesFailed: boolean
  onTileError: () => void
  onTileLoad: () => void
} {
  const [tilesFailed, setTilesFailed] = useState(false)
  return {
    tilesFailed,
    onTileError: () => setTilesFailed(true),
    onTileLoad: () => setTilesFailed(false),
  }
}