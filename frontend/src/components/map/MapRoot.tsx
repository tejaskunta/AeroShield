import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import L from 'leaflet'
import { CONSOLE_HEX } from '@/lib/consoleInk'
import { MapContext } from './mapContext'
import { basemapTileLayers, type Basemap } from './basemaps'

/**
 * MapRoot — creates the Leaflet map and publishes it to the overlay tree.
 *
 * Leaflet rather than Google Maps, and the reason is the imagery: Esri World Imagery
 * is keyless and open, so a fresh clone and a second laptop see the same map with no
 * `.env.local` in the way. The console's basemap used to depend on a licensed Mapbox
 * token that existed only in a gitignored file, which is how two people on one commit
 * ended up describing maps that differed by a factor of four in ground scale.
 *
 * The instance is still created exactly once, in an effect, and lives for the life of
 * the screen. React has no way to express "this DOM node now belongs to a non-React
 * library and that library owns its children", so the boundary is drawn here and
 * everything inside draws through the imperative Leaflet API. The overlays are
 * therefore render-nothing components that attach layers in effects.
 *
 * Consequences worth knowing:
 *   - Overlays are rendered as *nothing* in the React tree; they attach objects to
 *     the map and re-sync on prop change. This is unavoidable and is why each
 *     overlay component is a thin, effect-only wrapper.
 *   - StrictMode double-invokes effects in development. The map is created in an
 *     effect that tears itself down properly (`L.Map.remove()`), so the double-invoke
 *     costs one extra map construction at startup and nothing else.
 *
 * On failure the children are still rendered, over an empty dark map frame. The
 * mission grid, coverage hatch, detections and the drone are all *data* being drawn
 * on top; losing the basemap costs imagery, not situational awareness. That is why
 * this degrades instead of unmounting the screen.
 */

/** The console's dark canvas, used behind and around the tiles. */
const MAP_BACKGROUND = CONSOLE_HEX.inkDeep

/**
 * How many tile failures before the notice appears.
 *
 * One is too eager: a single 404 at the edge of a dataset is normal and self-corrects
 * as the operator pans. A dozen is not — by then a screenful is missing and what the
 * operator is looking at is grey.
 */
const TILE_ERROR_NOTICE_AT = 12


export interface MapRootProps {
  center: { lat: number; lon: number }
  zoom: number
  minZoom?: number
  /**
   * How far the operator may zoom, which is *not* where the tiles stop being real.
   *
   * These were one prop, and that was a bug worth recording. Leaflet asks two
   * separate questions:
   *
   *   1. How far may the operator zoom?      -> the map's `maxZoom`
   *   2. Where do the tiles stop being real? -> the layer's `maxNativeZoom`
   *
   * Esri World Imagery is native to zoom 19, so question 2 answers 19 — and Leaflet
   * handles it unaided: below `maxNativeZoom` tiles are fetched, above it the deepest
   * tile is scaled up. The ground stays geographically correct and merely softens. A
   * loss of detail is not a loss of position, and it is the right trade.
   *
   * Feeding 19 into question 1 as well is what broke the map. The operating ceiling
   * became 19 and so did the tile layer's own `maxZoom` — and a layer whose `maxZoom`
   * is below the map's current zoom is not degraded by Leaflet, it is *disabled*
   * (see `GridLayer._setView`). Imagery did not stop sharpening past 19, it vanished,
   * and the console offered no way back in.
   *
   * So this prop is the operator's limit only. The native depth lives in
   * `basemaps.ts`, which is the only place that can answer question 2.
   */
  maxZoom?: number
  /** Basemap-type toggle, driven by the console's own switch. */
  mapTypeId: Basemap
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
  /**
   * The operating ceiling, which is now just `maxZoom`.
   *
   * This used to be `Math.min(maxZoom, ceilingZoom ?? maxZoom)` — clamped against the
   * basemap's native depth. The intent was honest (do not pretend the map can do more
   * than the imagery) but the clamp was applied to the wrong quantity and cost the
   * operator everything past zoom 19. See the note on `maxZoom` above.
   *
   * Kept as a named constant rather than inlined because four call sites depend on it
   * agreeing, and `map.getZoom() === effectiveMaxZoom` has to mean "at the limit".
   */
  const effectiveMaxZoom = maxZoom
  const holder = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const [map, setMap] = useState<L.Map | null>(null)
  const [tileErrors, setTileErrors] = useState(0)

  // Create the map once. Every later view change is imperative, so the operator's
  // panning is never undone by a React re-render.
  useEffect(() => {
    if (!holder.current || mapRef.current) return

    const instance = L.map(holder.current, {
      center: [center.lat, center.lon] as [number, number],
      zoom: Math.min(zoom, effectiveMaxZoom),
      minZoom,
      maxZoom: effectiveMaxZoom,
      // This console draws its own chrome: zoom buttons, the fit control and the
      // basemap switch all live in `LiveMap`, styled as part of the instrument.
      zoomControl: false,
      attributionControl: true,
      // Fractional zoom, and it is load-bearing rather than a nicety. The integer fit
      // can leave the block a whole level short of legible, and half-steps recover
      // roughly 40 % of that without upscaling anything.
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      // Wheel zoom without the 300 ms debounce — a precision instrument should answer
      // the wheel as it turns.
      wheelDebounceTime: 20,
      wheelPxPerZoomLevel: 90,
      /**
       * Canvas for every vector on this map.
       *
       * At the working zoom the survey block is ~280 px across and the map carries a
       * grid, a flight track and the coverage hatch. As SVG each of those is its own
       * DOM node with its own attribute updates on every pan, which shows up as a
       * visible stutter while the aircraft is being followed. Canvas draws the whole
       * vector set into one element per pan. Markers stay DOM — they must, to carry
       * role/title semantics and hit-testing — and that split is exactly what we want.
       */
      preferCanvas: true,
      // Keeps Leaflet from leaving tiles semi-transparent mid-pan, which on a dark
      // console reads as a flickering panel.
      fadeAnimation: true,
      markerZoomAnimation: true,
    })

    mapRef.current = instance
    setMap(instance)

    return () => {
      // `remove()` detaches every layer, listener and DOM node Leaflet owns. React
      // owns the container div, so this is the only teardown needed — and without it a
      // remount leaks a map, a renderer canvas and a set of listeners per mount.
      instance.remove()
      mapRef.current = null
      setMap(null)
    }
    // Deliberately not re-running on center/zoom changes: those are applied
    // imperatively, and re-creating the map would throw away the operator's view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Leaflet measures its container once, at construction, and never re-measures on its
  // own. A map built before layout settles gets the wrong size and stays wrong — tile
  // counts, `fitBounds` and every pixel projection are derived from it. The console's
  // layout shifts as the banner and the dock settle, so this is the normal case here,
  // not an edge case.
  useEffect(() => {
    if (!map || !holder.current) return
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }))
    observer.observe(holder.current)
    // One immediate correction for the case where layout settled before the observer
    // was attached.
    map.invalidateSize({ animate: false })
    return () => observer.disconnect()
  }, [map])

  /**
   * The basemap, as a group of tile layers swapped on change.
   *
   * A group rather than a single layer because Hybrid is genuinely two services —
   * imagery plus cartographic labels — and because adding them one at a time would
   * flicker the labels in a moment after the imagery lands.
   *
   * Removed as a set, too: two stacked tile layers would double the requests and the
   * upper one would occlude the lower anyway.
   */
  useEffect(() => {
    if (!map) return
    const layers = basemapTileLayers(mapTypeId, effectiveMaxZoom)
    // Only the bottom layer reports failures — the label overlay 404s independently at
    // the edge of its coverage and would double-count every missing tile.
    const bottom = layers[0]
    const onError = () => setTileErrors((n) => n + 1)
    bottom?.on('tileerror', onError)
    layers.forEach((l) => l.addTo(map))

    return () => {
      bottom?.off('tileerror', onError)
      layers.forEach((l) => l.remove())
      // Reset the count when the basemap changes, so a broken provider does not leave a
      // stale notice in place after the operator switches to Street.
      setTileErrors(0)
    }
  }, [map, mapTypeId, effectiveMaxZoom])

  // Zoom bounds, applied imperatively so a change to the ceiling does not rebuild the
  // map.
  useEffect(() => {
    if (!map) return
    map.setMinZoom(minZoom)
    map.setMaxZoom(effectiveMaxZoom)
  }, [map, minZoom, effectiveMaxZoom])

  // Panning restriction. Applied as soft bounds rather than as a hard lock, so the
  // operator can still reach the edge of the block without being able to wander
  // into empty desert.
  //
  // `maxBoundsViscosity` is what makes it feel like a boundary rather than a wall: the
  // map resists the drag and springs back instead of stopping dead under the cursor.
  useEffect(() => {
    if (!map) return
    if (!restrictTo) {
      // Leaflet's `setMaxBounds` is typed as taking a `LatLngBoundsExpression` with
      // no `null` overload, though `null` is documented and does clear the limit.
      // The cast states that deliberately rather than widening the type everywhere.
      map.setMaxBounds(undefined)
      return
    }
    map.setMaxBounds(
      L.latLngBounds(
        [restrictTo.south, restrictTo.west] as [number, number],
        [restrictTo.north, restrictTo.east] as [number, number],
      ),
    )
    map.options.maxBoundsViscosity = 0.6
  }, [map, restrictTo])

  // Clicks. Registered once and forwarded through a ref so a changing callback does
  // not thrash the listener.
  const clickRef = useRef(onMapClick)
  clickRef.current = onMapClick
  useEffect(() => {
    if (!map) return
    const onClick = (e: L.LeafletMouseEvent) => {
      clickRef.current?.({ lat: e.latlng.lat, lon: e.latlng.lng })
    }
    map.on('click', onClick)
    return () => {
      map.off('click', onClick)
    }
  }, [map])

  return (
    <div className="relative h-full w-full" style={{ background: MAP_BACKGROUND }}>
      {/* The map's own DOM node. Maps appends its panes here. */}
      <div ref={holder} className="aeroshield-map h-full w-full" aria-label="Mission map" />

      {/* Overlays render into the map via effects, so this subtree is layout-only. */}
      {map && <MapContext.Provider value={{ map }}>{children}</MapContext.Provider>}

      {/* Loading, before the first paint. Deliberately brief and unobtrusive — the
          map is about to become the whole screen. */}
      {!map && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <p className="font-display text-tiny uppercase tracking-[0.16em] text-paper-faint">
            Loading imagery...
          </p>
        </div>
      )}

      {tileErrors >= TILE_ERROR_NOTICE_AT && <TileUnavailable />}
    </div>
  )
}

/**
 * The basemap's own "no imagery" state.
 *
 * Shown *over* the map node rather than instead of it, so the mission overlays
 * underneath remain readable — an operator can still see the survey grid, the
 * coverage, and the drone. Leaflet has no "the map failed" state at all (the library
 * is bundled and cannot fail to load), so the only failure this component can see is
 * imagery that will not arrive, and it is counted from `tileerror`.
 *
 * The notice names both plausible causes instead of guessing, because `tileerror`
 * cannot tell a missing tile from a missing network: one self-corrects as the
 * operator pans, the other needs someone to check a connection.
 */
function TileUnavailable() {
  return (
    <div className="pointer-events-none absolute inset-0 z-[400] grid place-items-center px-6">
      <div className="pointer-events-auto max-w-md border border-caution/50 bg-ink-deep/95 p-3">
        <p className="eyebrow text-caution">Basemap imagery unavailable</p>
        <p className="mt-1.5 text-small leading-relaxed text-paper-dim">
          Tiles are not loading. Check the network, or switch to Street from the basemap
          switch.
        </p>
        <p className="mt-2 font-mono text-tiny uppercase tracking-[0.1em] text-paper-faint">
          Mission overlays and detections below are unaffected
        </p>
      </div>
    </div>
  )
}

/**
 * The street canvas's dimming, as CSS rather than as a style spec.
 *
 * Google's `STREET_STYLES` used to live here and its removal is the reason this
 * comment exists. That spec desaturated `elementType: 'geometry'` — which is not a
 * road selector but *the ground*, covering photographic imagery too — and switched
 * `elementType: 'labels'` off, which deleted exactly the layer distinguishing Hybrid
 * from Satellite. Measured together they flattened imagery (sigma 53.3 -> 43.8) and
 * made the two imagery modes render identically (both mean RGB 111/108/101), so the
 * Hybrid control appeared to do nothing.
 *
 * A raster filter cannot make that mistake: it applies to the street tiles by
 * `className` and cannot reach the imagery layers at all. See `.aeroshield-tiles-street`
 * in `index.css`.
 */

/**
 * The imagery constants live in `lib/config.ts` and are re-exported here for the
 * convenience of map-local callers.
 *
 * They were declared in this file first, which was a mistake worth recording: this is
 * a `.tsx` module, and Node's type-stripping test runner cannot load `.tsx`. A constant
 * that only a component can reach is a constant no test can pin — and the `{z}/{y}/{x}`
 * ordering is precisely the kind of thing that must be pinned, because getting it
 * backwards renders a plausible photograph of the wrong place rather than an error.
 */
export { IMAGERY_URL_ORDER, ESRI_MAX_NATIVE_ZOOM as IMAGERY_NATIVE_ZOOM } from '@/lib/config'