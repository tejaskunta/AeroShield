import { useState } from 'react'
import { Compass, Crosshair, Hand, Layers, Minus, Plus, Scan } from 'lucide-react'
import type { Basemap } from '@/components/map/basemaps'
import type { FollowMode } from '@/components/map/useMapHooks'
import type { MapControls, ViewMode } from '@/components/map/viewTypes'
import { LayerToggles, type LayerState } from '@/components/map/LayerToggles'
import { Segmented } from '@/components/ui/Segmented'
import { IconButton } from '@/components/ui/IconButton'

/**
 * MapChrome — every control that sits over the map, drawn once for both engines.
 *
 * Top-left: what you are looking at (2D | 3D, imagery). Top-right: how the camera
 * moves (zoom, tracking, layers, north). Grouping by question rather than scattering
 * buttons is what keeps a full-bleed map from turning into a cockpit of widgets.
 */
export function MapChromeTopLeft({
  view,
  onView,
  basemap,
  onBasemap,
}: {
  view: ViewMode
  onView: (v: ViewMode) => void
  basemap: Basemap
  onBasemap: (b: Basemap) => void
}) {
  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-2">
      <Segmented
        label="Map view"
        value={view}
        onChange={onView}
        options={[
          { value: '2d', label: '2D', title: 'Flat map: precise, fastest' },
          { value: '3d', label: '3D', title: 'Tilted 3D: terrain, buildings, drone altitude' },
        ]}
      />
      <Segmented
        label="Imagery"
        size="sm"
        value={basemap}
        onChange={onBasemap}
        options={[
          { value: 'satellite', label: 'Satellite' },
          { value: 'hybrid', label: 'Hybrid' },
          { value: 'roadmap', label: 'Street' },
        ]}
      />
    </div>
  )
}

export function MapChromeTopRight({
  controls,
  follow,
  onFollow,
  layers,
  onLayers,
  droneLabel,
  view,
  bearing,
}: {
  controls: MapControls | null
  follow: FollowMode
  onFollow: (m: FollowMode) => void
  layers: LayerState
  onLayers: (l: LayerState) => void
  droneLabel: string | null
  view: ViewMode
  /** Current map bearing in degrees (3D); the compass turns to match. */
  bearing: number
}) {
  const [layersOpen, setLayersOpen] = useState(false)
  return (
    <div className="pointer-events-auto flex items-start gap-2">
      {layersOpen && (
        <div className="animate-slide-in-right">
          <LayerToggles value={layers} onChange={onLayers} droneLabel={droneLabel} defaultOpen />
        </div>
      )}
      <div className="glass flex flex-col gap-0.5 p-1">
        <IconButton bare label="Zoom in" onClick={() => controls?.zoomIn()}>
          <Plus size={16} />
        </IconButton>
        <IconButton bare label="Zoom out" onClick={() => controls?.zoomOut()}>
          <Minus size={16} />
        </IconButton>
        <span className="mx-1.5 my-0.5 h-px bg-white/[0.08]" aria-hidden />
        <IconButton bare label="Follow the drone" active={follow === 'follow'} onClick={() => onFollow('follow')}>
          <Crosshair size={16} />
        </IconButton>
        <IconButton bare label="Fit block and drone" active={follow === 'fit'} onClick={() => onFollow('fit')}>
          <Scan size={16} />
        </IconButton>
        <IconButton bare label="Manual: never move the map" active={follow === 'manual'} onClick={() => onFollow('manual')}>
          <Hand size={16} />
        </IconButton>
        <span className="mx-1.5 my-0.5 h-px bg-white/[0.08]" aria-hidden />
        <IconButton bare label="Layers" active={layersOpen} onClick={() => setLayersOpen((o) => !o)}>
          <Layers size={16} />
        </IconButton>
        {view === '3d' && (
          <IconButton bare label="Reset north and tilt" onClick={() => controls?.resetNorth?.()}>
            <Compass size={16} style={{ transform: `rotate(${-bearing}deg)`, transition: 'transform 200ms' }} />
          </IconButton>
        )}
      </div>
    </div>
  )
}
