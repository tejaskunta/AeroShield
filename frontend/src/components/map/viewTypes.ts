/**
 * The contract both map engines (Leaflet 2D, MapLibre 3D) offer the chrome.
 *
 * The glass controls in Mission Control are drawn once and drive whichever view is
 * mounted, so the two engines expose the same small surface: zoom, reset bearing,
 * and where the camera is. `MapView` is how a 2D↔3D switch keeps the operator's
 * place instead of snapping back to the default framing.
 */
export interface MapViewState {
  lat: number
  lon: number
  zoom: number
}

export interface MapControls {
  zoomIn(): void
  zoomOut(): void
  /** Bring a point into the middle of the view (e.g. a detection picked from a list). */
  flyTo(lat: number, lon: number): void
  /** 3D only: turn back to north-up and flat. */
  resetNorth?(): void
  getView(): MapViewState
}

export type ViewMode = '2d' | '3d'
