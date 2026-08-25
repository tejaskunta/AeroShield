import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { MapContainer, Polyline, TileLayer, useMap, ScaleControl } from 'react-leaflet'
import type * as L from 'leaflet'
import type { Detection, LatLng, MissionProgress, PathPlan, Telemetry } from '@/types'
import { MISSION } from '@/lib/mockData'
import { gridBounds, gridCenter, toTuple } from '@/lib/geo'
import { MissionGridLayer } from './MissionGridLayer'
import { CoverageHatchLayer } from './CoverageHatchLayer'
import { DronePlatform } from './DronePlatform'
import { DetectionPins } from './DetectionPins'
import { SafeCorridorLayer } from './SafeCorridorLayer'
import { LayerToggles, type LayerState, DEFAULT_LAYERS } from './LayerToggles'
import { MapLegend } from './MapLegend'

/**
 * LiveMap — the canvas everything else docks to.
 *
 * Two basemaps: imagery (what the drone actually sees) and a dark canvas (when
 * imagery is unavailable or too busy to read hazard colour against). Both are
 * damped by the `.aeroshield-tiles` filter so the risk palette stays the most
 * saturated thing on screen — see the note in index.css.
 *
 * Tiles require network access. `TileFailureNotice` covers the offline case rather
 * than leaving the operator staring at an empty grey field wondering if the map
 * broke or the mission did.
 */

export type Basemap = 'imagery' | 'canvas'

const BASEMAPS: Record<Basemap, { url: string; attribution: string; maxZoom: number }> = {
  imagery: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
  canvas: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
  },
}

export function LiveMap({
  telemetry,
  progress,
  detections,
  selectedId,
  onSelect,
  plan,
  planEndpoints,
  onMapClick,
  children,
}: {
  telemetry: Telemetry | null
  progress: MissionProgress | null
  detections: Detection[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  plan: PathPlan | null
  planEndpoints: { from: LatLng | null; to: LatLng | null }
  /** Used by the planner to pick start/goal by clicking the map. */
  onMapClick?: (p: LatLng) => void
  /**
   * Rendered inside the Leaflet context, above every layer. This is how the
   * detection callout gets access to `useMap()` for its leader line.
   */
  children?: ReactNode
}) {
  const [basemap, setBasemap] = useState<Basemap>('imagery')
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS)
  const [tilesFailed, setTilesFailed] = useState(false)

  const center = useMemo(() => gridCenter(MISSION.grid), [])
  const tiles = BASEMAPS[basemap]

  return (
    <div className="relative h-full w-full bg-ink-deep">
      <MapContainer
        center={toTuple(center)}
        zoom={17}
        maxZoom={tiles.maxZoom}
        zoomControl={false}
        attributionControl
        className="h-full w-full"
        // The survey block is the world; don't let the operator get lost.
        maxBounds={gridBounds(MISSION.grid)}
        maxBoundsViscosity={0.7}
      >
        <TileLayer
          key={basemap}
          url={tiles.url}
          attribution={tiles.attribution}
          maxZoom={tiles.maxZoom}
          className="aeroshield-tiles"
          eventHandlers={{
            tileerror: () => setTilesFailed(true),
            tileload: () => setTilesFailed(false),
          }}
        />

        {layers.grid && <MissionGridLayer grid={MISSION.grid} />}
        {layers.coverage && progress && (
          <CoverageHatchLayer grid={MISSION.grid} coveredCells={progress.coveredCells} />
        )}

        {/* Planned survey path, faint — it is intent, not history. */}
        {layers.plannedPath && (
          <Polyline
            positions={MISSION.plannedPath.map(toTuple)}
            pathOptions={{ color: '#3E5060', weight: 1, dashArray: '3 5', opacity: 0.9 }}
          />
        )}

        {/* Flown track, solid — this is what actually happened. */}
        {layers.track && progress && progress.track.length > 1 && (
          <Polyline
            positions={progress.track.map(toTuple)}
            pathOptions={{ color: '#E8E4DA', weight: 1.5, opacity: 0.55 }}
          />
        )}

        {layers.corridor && plan && <SafeCorridorLayer plan={plan} endpoints={planEndpoints} />}

        {layers.detections && (
          <DetectionPins
            detections={detections}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}

        {telemetry && <DronePlatform telemetry={telemetry} />}

        <ClickHandler onMapClick={onMapClick} />
        <KeepCenteredOnGrid />
        <ScaleControl position="bottomleft" metric imperial={false} />
        {children}
      </MapContainer>

      {/* Map chrome sits above Leaflet's panes. */}
      <div className="pointer-events-none absolute inset-0 z-[500]">
        <div className="pointer-events-auto absolute right-2 top-2 flex flex-col items-end gap-2">
          <BasemapSwitcher value={basemap} onChange={setBasemap} />
          <LayerToggles value={layers} onChange={setLayers} />
        </div>
        <div className="pointer-events-auto absolute bottom-6 right-2">
          <MapLegend detections={detections} />
        </div>
      </div>

      {tilesFailed && <TileFailureNotice basemap={basemap} onSwitch={setBasemap} />}
    </div>
  )
}

/** Basemap switcher — two states, so a segmented control rather than a dropdown. */
function BasemapSwitcher({
  value,
  onChange,
}: {
  value: Basemap
  onChange: (b: Basemap) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Basemap"
      className="flex border border-rule bg-ink-deep/90 backdrop-blur-sm"
    >
      {(['imagery', 'canvas'] as Basemap[]).map((b) => (
        <button
          key={b}
          type="button"
          role="radio"
          aria-checked={value === b}
          onClick={() => onChange(b)}
          className={`px-2 py-1 font-display text-[10px] uppercase tracking-[0.1em] transition-colors ${
            value === b ? 'bg-ink-hover text-paper' : 'text-paper-faint hover:text-paper-dim'
          }`}
        >
          {b === 'imagery' ? 'Imagery' : 'Canvas'}
        </button>
      ))}
    </div>
  )
}

/**
 * Tiles are the one hard external dependency. Say what happened, and offer the
 * fallback — the mission overlays still work without a basemap.
 */
function TileFailureNotice({
  basemap,
  onSwitch,
}: {
  basemap: Basemap
  onSwitch: (b: Basemap) => void
}) {
  return (
    <div className="absolute bottom-2 left-2 z-[600] max-w-xs border border-caution/50 bg-ink-deep/95 p-2.5">
      <p className="eyebrow text-caution">Basemap unavailable</p>
      <p className="mt-1 text-[11px] leading-relaxed text-paper-dim">
        Tiles need network access. The mission grid, coverage, and detections below are
        unaffected — only the background imagery is missing.
      </p>
      {basemap === 'imagery' && (
        <button
          type="button"
          onClick={() => onSwitch('canvas')}
          className="mt-1.5 border border-rule px-2 py-px font-display text-[10px] uppercase tracking-[0.1em] text-paper hover:bg-ink-hover"
        >
          Try canvas basemap
        </button>
      )}
    </div>
  )
}

/** Reports map clicks upward so the planner can set endpoints. */
function ClickHandler({ onMapClick }: { onMapClick?: (p: LatLng) => void }) {
  const map = useMap()
  useEffect(() => {
    if (!onMapClick) return
    const handler = (e: L.LeafletMouseEvent) => onMapClick({ lat: e.latlng.lat, lon: e.latlng.lng })
    map.on('click', handler)
    return () => {
      map.off('click', handler)
    }
  }, [map, onMapClick])
  return null
}

/** Fit the survey block once, on mount. Never fights the operator's panning after. */
function KeepCenteredOnGrid() {
  const map = useMap()
  useEffect(() => {
    map.fitBounds(gridBounds(MISSION.grid), { padding: [40, 40] })
  }, [map])
  return null
}
