import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { GOOGLE_MAPS_MAP_ID, HAS_GOOGLE_MAPS_KEY } from '@/lib/config'
import { MapContext } from './mapContext'
import { useGoogleMaps } from './useGoogleMaps'
import type { MapsFailure } from './useGoogleMaps'

/**
 * MapRoot — creates the Google map and publishes it to the overlay tree.
 *
 * This is the direct replacement for `react-leaflet`'s `<MapContainer>`, and it
 * exists for one reason: the map instance must be created exactly once, live for
 * the life of the screen, and never be recreated by a re-render. React has no way
 * to express "this DOM node now belongs to a non-React library and that library
 * owns its children", so the boundary is drawn here in an effect and everything
 * inside it renders through the imperative API instead.
 *
 * Consequences worth knowing:
 *   - Overlays are rendered as *nothing* in the React tree; they attach objects to
 *     the map and re-sync on prop change. This is unavoidable and is why each
 *     overlay component is a thin, effect-only wrapper.
 *   - StrictMode double-invokes effects in development. The map is created in an
 *     effect that tears itself down properly, so the double-invoke costs one extra
 *     map construction at startup and nothing else. `useGoogleMaps` is
 *     module-memoised, so the API itself is still loaded only once.
 *
 * On failure the children are still rendered, over an empty dark map frame. The
 * mission grid, coverage hatch, detections and the drone are all *data* being drawn
 * on top; losing the basemap costs imagery, not situational awareness. That is why
 * this degrades instead of unmounting the screen.
 */

/** The console's dark canvas, used when no basemap can be drawn. */
const MAP_BACKGROUND = '#0E141A'

export interface MapRootProps {
  center: { lat: number; lon: number }
  zoom: number
  minZoom?: number
  maxZoom?: number
  /** Basemap-type toggle, driven by the console's own switch. */
  mapTypeId: 'satellite' | 'hybrid' | 'roadmap'
  /** Restrict panning so the operator cannot lose the survey block. */
  restrictTo?: { south: number; west: number; north: number; east: number } | null
  /** Called for every click on the map, in domain coordinates. */
  onMapClick?: (p: { lat: number; lon: number }) => void
  children?: ReactNode
}

export function MapRoot({
  center,
  zoom,
  minZoom = 3,
  maxZoom = 21,
  mapTypeId,
  restrictTo,
  onMapClick,
  children,
}: MapRootProps) {
  const { status, maps, failure } = useGoogleMaps()
  const holder = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const [map, setMap] = useState<google.maps.Map | null>(null)

  // Create the map once, when both the DOM node and the API are available.
  useEffect(() => {
    if (!maps || !holder.current || mapRef.current) return

    const instance = new maps.Map(holder.current, {
      center: { lat: center.lat, lng: center.lon },
      zoom,
      minZoom,
      maxZoom,
      mapTypeId,
      // No key -> no Map ID; a Map ID requires a cloud-styled map and would fight
      // the mapTypeId switch this console exposes.
      ...(GOOGLE_MAPS_MAP_ID ? { mapId: GOOGLE_MAPS_MAP_ID } : {}),
      // The console draws its own chrome for everything except attribution and the
      // scale bar, so the default control furniture is switched off wholesale and
      // the two keepers are positioned with `position` at construction time.
      disableDefaultUI: true,
      zoomControl: false,
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      // A mission console is a precision instrument, not a browsing surface: no
      // inertia to overshoot the target, and no accidental zoom on scroll.
      gestureHandling: 'greedy',
      scrollwheel: true,
      backgroundColor: MAP_BACKGROUND,
      isFractionalZoomEnabled: true,
      // Rail-style map: no labels competing with the risk palette. Applied on top
      // of whatever the basemap type supplies.
      styles: MAP_STYLES,
    })

    mapRef.current = instance
    setMap(instance)

    return () => {
      // React owns the node; the map owns nothing outside it. Clearing the node
      // releases the Map's DOM and listeners without an explicit destroy (the Maps
      // API has none) — without this, a remount leaks a map per mount.
      mapRef.current = null
      setMap(null)
      if (holder.current) holder.current.innerHTML = ''
    }
    // Deliberately not re-running on center/zoom changes: the map is created once
    // at its initial view and every later view change is imperative, so the
    // operator's panning is never undone by a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maps])

  // Map-type switching, and zoom bounds, are imperative updates.
  useEffect(() => {
    if (!map) return
    map.setMapTypeId(mapTypeId)
  }, [map, mapTypeId])

  useEffect(() => {
    if (!map) return
    map.setOptions({ minZoom, maxZoom })
  }, [map, minZoom, maxZoom])

  // Panning restriction. Applied as bounds rather than as a hard lock, so the
  // operator can still reach the edge of the block without being able to wander
  // into empty desert.
  useEffect(() => {
    if (!map) return
    if (!restrictTo) {
      map.setOptions({ restriction: null })
      return
    }
    const bounds = new google.maps.LatLngBounds(
      { lat: restrictTo.south, lng: restrictTo.west },
      { lat: restrictTo.north, lng: restrictTo.east },
    )
    map.setOptions({ restriction: { latLngBounds: bounds, strictBounds: false } })
  }, [map, restrictTo])

  // Clicks. Registered once and forwarded through a ref so a changing callback
  // does not thrash the listener.
  const clickRef = useRef(onMapClick)
  clickRef.current = onMapClick
  useEffect(() => {
    if (!map) return
    const listener = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      const ll = e.latLng
      if (!ll) return
      clickRef.current?.({ lat: ll.lat(), lon: ll.lng() })
    })
    return () => listener.remove()
  }, [map])

  return (
    <div className="relative h-full w-full" style={{ background: MAP_BACKGROUND }}>
      {/* The map's own DOM node. Maps appends its panes here. */}
      <div ref={holder} className="aeroshield-map h-full w-full" aria-label="Mission map" />

      {/* Overlays render into the map via effects, so this subtree is layout-only. */}
      {map && maps && <MapContext.Provider value={{ map, maps }}>{children}</MapContext.Provider>}

      {/* Loading, before the first paint. Deliberately brief and unobtrusive — the
          map is about to become the whole screen. */}
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="font-display text-[10px] uppercase tracking-[0.16em] text-paper-faint">
            Loading imagery…
          </p>
        </div>
      )}

      {status === 'error' && failure && <MapUnavailable failure={failure} />}

      {/* Nothing to show if the key is missing but the hook has not reported yet. */}
      {status === 'idle' && !HAS_GOOGLE_MAPS_KEY && (
        <MapUnavailable
          failure={{
            summary: 'Map key not configured',
            detail: 'Set VITE_GOOGLE_MAPS_API_KEY in frontend/.env.local and restart the dev server.',
            configuration: true,
          }}
        />
      )}
    </div>
  )
}

/**
 * The map's own "no imagery" state.
 *
 * Shown *over* the map node rather than instead of it, so the mission overlays
 * underneath remain readable — an operator can still see the survey grid, the
 * coverage, and the drone. The notice says which of the two problems it is: a
 * configuration mistake (fixable now) or a network problem (wait), because those
 * call for completely different responses.
 */
function MapUnavailable({ failure }: { failure: MapsFailure }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-[400] grid place-items-center px-6">
      <div className="pointer-events-auto max-w-md border border-caution/50 bg-ink-deep/95 p-3">
        <p className="eyebrow text-caution">{failure.summary}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-paper-dim">{failure.detail}</p>
        <p className="mt-2 font-mono text-[9px] uppercase tracking-[0.1em] text-paper-faint">
          Mission overlays and detections below are unaffected
        </p>
      </div>
    </div>
  )
}

/**
 * Map style.
 *
 * The imagery is the background, not the subject: hazard colour has to stay the
 * most saturated thing on screen or the "red means hazard" rule stops reading.
 * Labels are suppressed because a place name sitting under a detection pin is
 * noise in a minefield survey.
 *
 * This is the Maps equivalent of the old `.aeroshield-tiles` CSS filter, except the
 * mapping is geometric rather than a filter applied to a raster — so it holds up at
 * every zoom rather than only where a tile happens to have been rendered.
 */
const MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { elementType: 'geometry', stylers: [{ saturation: -55 }, { lightness: -22 }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ saturation: -40 }, { lightness: -18 }] },
]