import { createContext, useContext } from 'react'
import type { Map as LeafletMap } from 'leaflet'

/**
 * The map instance, shared with every overlay that needs to project coordinates.
 *
 * `react-leaflet` ships its own context for this, and components that are children of
 * a `MapContainer` can use `useMap()` from that library directly. This context exists
 * for the components here that are *not* declarative children of the container — the
 * overlays draw imperatively through the Leaflet API rather than through
 * `react-leaflet`'s children API, because they own reconciliation themselves (see
 * `DetectionPins`, whose whole point is that a telemetry tick must not rebuild its
 * markers). Those components still need the instance, so `MapRoot` publishes it here.
 *
 * One map, one projection, one source of truth for pan/zoom events.
 *
 * Note there is no second field for the library namespace any more. The Google Maps
 * version carried `maps: typeof google.maps` so overlays could construct their own
 * objects without reaching for a global; Leaflet is a plain module import, so there is
 * nothing to pass down.
 */
export interface MapContextValue {
  /** The live map instance. Never recreated for the life of the screen. */
  map: LeafletMap
}

export const MapContext = createContext<MapContextValue | null>(null)

/**
 * Access the map.
 *
 * Throws outside a `MapRoot` rather than returning null. An overlay rendered
 * outside the map is a programming error — it would silently draw nothing, and a
 * blank layer is far harder to diagnose than an exception naming the component.
 */
export function useMap(): MapContextValue {
  const ctx = useContext(MapContext)
  if (!ctx) {
    throw new Error('useMap() must be used inside <MapRoot>. Overlays cannot render outside the map.')
  }
  return ctx
}

/** Non-throwing variant, for components that must work with or without a map. */
export function useMapOptional(): MapContextValue | null {
  return useContext(MapContext)
}