import { createContext, useContext } from 'react'

/**
 * The map instance, shared with every overlay that needs to project coordinates.
 *
 * Leaflet supplied this implicitly through `react-leaflet`'s context. The Maps API
 * has no such notion, so the console owns one explicitly: `MapRoot` creates the map
 * and publishes it here, and overlays read it rather than each building their own.
 * One map, one projection, one source of truth for pan/zoom events.
 */
export interface MapContextValue {
  /** The live map instance. Never recreated for the life of the screen. */
  map: google.maps.Map
  /** The API namespace, so overlays construct their own objects without a global. */
  maps: typeof google.maps
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