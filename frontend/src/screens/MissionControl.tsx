import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Detection, LatLng } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { useDetections } from '@/hooks/useDetections'
import { usePersistedState } from '@/hooks/usePersistedState'
import { HAS_JETSON_STREAM } from '@/lib/config'
import { ImageryAttribution, LiveMap } from '@/components/map/LiveMap'
import type { Basemap } from '@/components/map/basemaps'
import { DEFAULT_LAYERS, type LayerState } from '@/components/map/LayerToggles'
import type { FollowMode } from '@/components/map/useMapHooks'
import { droneOverlayLabel, useDroneOverlay } from '@/components/map/DroneImageryLayer'
import type { MapControls, MapViewState, ViewMode } from '@/components/map/viewTypes'
import { DetectionCallout } from '@/components/mission/DetectionCallout'
import { DetectionCard } from '@/components/mission/DetectionCard'
import { LiveFeed } from '@/components/mission/LiveFeed'
import { MapChromeTopLeft, MapChromeTopRight } from '@/components/mission/MapChrome'
import { StatusStrip } from '@/components/mission/StatusStrip'
import { Lightbox } from '@/components/ui/Lightbox'

// The 3D engine (MapLibre + three.js, ~1 MB) loads only when someone opens 3D.
const LiveMap3D = lazy(() => import('@/components/map3d/LiveMap3D'))

/**
 * Mission Control — the primary screen.
 *
 * One full-bleed map with the instrument laid over it in glass, in the manner of a
 * flight HUD: what you are looking at (top-left), how the camera moves (top-right),
 * the aircraft's camera (floating, top-right), and the mission's numbers along the
 * bottom. The map used to share the window with a split camera column and a fixed
 * dock, which left it a cramped middle third; now it is the whole window and the
 * readouts float where the eye drops to read them.
 *
 * Two engines behind one switch: Leaflet for the flat map (precise, light), MapLibre
 * for the tilted 3D view (terrain, buildings, the drone at altitude). They share
 * every input — detections, selection, layers, the drone photo — and the 2D↔3D switch
 * carries the camera's place across.
 *
 * There is deliberately no route planner. The aircraft is flown by hand over a
 * ten-metre block; the system records where it went and what it saw.
 */

/*
 * How many detections the map draws at once. A DISPLAY limit only: every detection
 * is still recorded and uploaded, and Detections, Reports and Analytics read the full
 * mission. Past ~60 pins the map stops showing where the aircraft has been.
 */
const MAX_VISIBLE_DETECTIONS = 60

const isView = (v: unknown): v is ViewMode => v === '2d' || v === '3d'

export function MissionControl() {
  const navigate = useNavigate()
  const mission = useMission()
  const detections = mission?.detections ?? []
  const { selected, selectedId, select, review } = useDetections(detections)

  const visibleDetections =
    detections.length > MAX_VISIBLE_DETECTIONS ? detections.slice(detections.length - MAX_VISIBLE_DETECTIONS) : detections

  // A `backend` detection could only have come from the aircraft running its model.
  const detectorRunning = detections.some((d) => d.source === 'backend')

  // View state, owned here so one set of controls drives both engines.
  const [view, setView] = usePersistedState<ViewMode>('map-view', '2d', isView)
  // `?view=3d` opens straight into a view: a shareable link, and how a test drives it.
  const [params] = useSearchParams()
  useEffect(() => {
    const v = params.get('view')
    if (isView(v)) setView(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [basemap, setBasemap] = useState<Basemap>('satellite')
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS)
  const [follow, setFollow] = useState<FollowMode>('fit')
  const [refitKey, setRefitKey] = useState(0)
  const [bearing, setBearing] = useState(0)
  const droneOverlay = useDroneOverlay()

  // The mounted engine's controls, and the camera handed across a 2D↔3D switch.
  const [controls, setControls] = useState<MapControls | null>(null)
  const carry = useRef<MapViewState | null>(null)
  const switchView = useCallback(
    (v: ViewMode) => {
      if (v === view) return
      carry.current = controls?.getView() ?? null
      setBearing(0)
      setView(v)
    },
    [controls, view, setView],
  )

  const onFollow = useCallback((m: FollowMode) => {
    setFollow(m)
    // Choosing 'fit' again is a request for the framed view back.
    if (m === 'fit') setRefitKey((k) => k + 1)
  }, [])

  const onMapClick = useCallback((_p: LatLng) => select(null), [select])

  const pick = useCallback(
    (d: Detection) => {
      select(d.id)
      // Picking from the list is a request to look at it: stop auto-framing.
      setFollow('manual')
      controls?.flyTo(d.position.lat, d.position.lon)
    },
    [controls, select],
  )

  // Full-screen photo viewer, opened from the card; steps through the visible pins.
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const openViewer = useCallback(() => {
    if (!selected) return
    const i = visibleDetections.findIndex((d) => d.id === selected.id)
    setViewerIndex(i >= 0 ? i : null)
  }, [selected, visibleDetections])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewerIndex === null) select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select, viewerIndex])

  const cardProps = selected
    ? {
      detection: selected,
      onClose: () => select(null),
      onReview: review,
      onOpenInCenter: (id: string) => navigate(`/detections?focus=${id}`),
      onExpand: openViewer,
    }
    : null

  const shared = {
    telemetry: mission?.telemetry ?? null,
    progress: mission?.progress ?? null,
    detections: visibleDetections,
    selectedId,
    onSelect: select,
    onMapClick,
    basemap,
    layers,
    follow,
    refitKey,
    droneOverlay,
    initialView: carry.current,
    onControls: setControls,
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-ink-deep">
      <div className="absolute inset-0">
        {view === '2d' ? (
          <LiveMap {...shared}>{cardProps && <DetectionCallout {...cardProps} />}</LiveMap>
        ) : (
          <Suspense fallback={<Loading3D />}>
            <LiveMap3D {...shared} onBearing={setBearing} />
          </Suspense>
        )}
      </div>

      {/* The instrument, in glass over the map. No backdrop filter on this wrapper:
          the camera's full-screen mode is `fixed`, and a filtered ancestor would trap it. */}
      <div className="pointer-events-none absolute inset-0 z-[500] flex flex-col p-3">
        <div className="flex items-start justify-between gap-3">
          <MapChromeTopLeft view={view} onView={switchView} basemap={basemap} onBasemap={setBasemap} />
          <MapChromeTopRight
            controls={controls}
            follow={follow}
            onFollow={onFollow}
            layers={layers}
            onLayers={setLayers}
            droneLabel={droneOverlay ? droneOverlayLabel(droneOverlay) : null}
            view={view}
            bearing={bearing}
          />
        </div>

        {view === '3d' && (
          <div className="mt-2 flex flex-col items-start gap-2">
            <span className="glass px-2.5 py-1 text-[0.6875rem] text-paper-faint">
              Right-drag or Ctrl-drag to tilt and rotate · drone drawn 3× real size
            </span>
            {cardProps && (
              <div className="pointer-events-auto">
                <DetectionCard {...cardProps} />
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        <StatusStrip
          telemetry={mission?.telemetry ?? null}
          progress={mission?.progress ?? null}
          detections={detections}
          onPick={pick}
        />
        <div className="mt-1.5 flex justify-end">
          <span className="pointer-events-auto">
            <ImageryAttribution basemap={basemap} />
          </span>
          {view === '3d' && (
            <span className="ml-1 text-[0.625rem] text-paper-faint">
              · Buildings © OpenFreeMap, OpenMapTiles, OpenStreetMap · Terrain: Mapzen / AWS
            </span>
          )}
        </div>
      </div>

      {HAS_JETSON_STREAM && (
        <LiveFeed detectorRunning={detectorRunning} floatClassName="right-[4.25rem] top-3 w-[min(400px,34vw)]" />
      )}

      {viewerIndex !== null && (
        <Lightbox
          detections={visibleDetections}
          index={viewerIndex}
          onIndex={(i) => {
            setViewerIndex(i)
            const d = visibleDetections[i]
            if (d) select(d.id)
          }}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  )
}

function Loading3D() {
  return (
    <div className="grid h-full place-items-center">
      <span className="glass px-3 py-1.5 text-[0.75rem] text-paper-faint">Loading 3D view…</span>
    </div>
  )
}
