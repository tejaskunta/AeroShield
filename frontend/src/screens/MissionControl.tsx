import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { MapChromeTopLeft, MapChromeTopRight, type Layout } from '@/components/mission/MapChrome'
import { StatusStrip } from '@/components/mission/StatusStrip'
import { TestInjectPanel } from '@/components/mission/TestInjectPanel'
import { Lightbox } from '@/components/ui/Lightbox'

// The 3D engine (MapLibre + three.js, ~1 MB) loads only when someone opens 3D.
const LiveMap3D = lazy(() => import('@/components/map3d/LiveMap3D'))

/**
 * Mission Control — the primary screen.
 *
 * Two layouts, the operator's choice and remembered:
 *   Overlay  the map takes the window; the camera floats over it as a card
 *   Split    map and camera side by side, the camera a full-height column
 *
 * Over the map, in glass: what you are looking at (top-left), how the camera moves
 * (top-right), and the mission's numbers along the bottom. Two engines behind one
 * switch — Leaflet for the flat map, MapLibre for the tilted 3D view — share every
 * input, and a 2D↔3D switch keeps the camera where the operator left it.
 *
 * No route planner: the aircraft is flown by hand over a ten-metre block; the system
 * records where it went and what it saw.
 */

/* A DISPLAY limit only; every detection is still recorded and uploaded. */
const MAX_VISIBLE_DETECTIONS = 60

const isView = (v: unknown): v is ViewMode => v === '2d' || v === '3d'
const isLayout = (v: unknown): v is Layout => v === 'overlay' || v === 'split'

export function MissionControl() {
  const navigate = useNavigate()
  const mission = useMission()
  const detections = useMemo(() => mission?.detections ?? [], [mission?.detections])
  const { selected, selectedId, select, review } = useDetections(detections)

  // Memoised: a fresh slice every render made the 3D view rebuild all its markers on
  // every telemetry tick once there were more than 60 detections.
  const visibleDetections = useMemo(
    () => (detections.length > MAX_VISIBLE_DETECTIONS ? detections.slice(detections.length - MAX_VISIBLE_DETECTIONS) : detections),
    [detections],
  )

  // A `backend` detection could only have come from the aircraft running its model.
  const detectorRunning = detections.some((d) => d.source === 'backend' && d.origin !== 'manual-test')

  const [view, setView] = usePersistedState<ViewMode>('map-view', '2d', isView)
  const [layout, setLayout] = usePersistedState<Layout>('mission-layout', 'overlay', isLayout)
  // `?view=3d` opens straight into a view: a shareable link, and how a test drives it.
  const [params] = useSearchParams()
  useEffect(() => {
    const v = params.get('view')
    if (isView(v)) setView(v)
    const l = params.get('layout')
    if (isLayout(l)) setLayout(l)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [basemap, setBasemap] = useState<Basemap>('satellite')
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS)
  const [follow, setFollow] = useState<FollowMode>('fit')
  const [refitKey, setRefitKey] = useState(0)
  const [bearing, setBearing] = useState(0)
  const droneOverlay = useDroneOverlay()

  const [controls, setControls] = useState<MapControls | null>(null)
  const carry = useRef<MapViewState | null>(null)
  const switchView = useCallback(
    (v: ViewMode) => {
      if (v === view) return
      carry.current = controls?.getView() ?? null
      setBearing(0)
      // Keep the operator's place: with 'fit' still on, the new engine re-framed the
      // block on mount and threw the carried camera away.
      if (carry.current) setFollow('manual')
      setView(v)
    },
    [controls, view, setView],
  )

  const onFollow = useCallback((m: FollowMode) => {
    setFollow(m)
    if (m === 'fit') setRefitKey((k) => k + 1)
  }, [])

  // Test injection: the panel, and map clicks routed to it while picking a point.
  const [testOpen, setTestOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [testPoint, setTestPoint] = useState<LatLng | null>(null)

  const onMapClick = useCallback(
    (p: LatLng) => {
      if (picking) {
        setTestPoint(p)
        setPicking(false)
        return
      }
      select(null)
    },
    [picking, select],
  )

  const pick = useCallback(
    (d: Detection) => {
      select(d.id)
      setFollow('manual')
      controls?.flyTo(d.position.lat, d.position.lon)
    },
    [controls, select],
  )

  // Photo viewer, tracked by detection ID, not by position in the visible list: the
  // list is a sliding window, so an index silently pointed at a different detection
  // as soon as new ones arrived — and the operator could review the wrong hazard.
  const [viewerId, setViewerId] = useState<string | null>(null)
  const viewerIndex = viewerId ? visibleDetections.findIndex((d) => d.id === viewerId) : -1
  const openViewer = useCallback(() => {
    if (selected) setViewerId(selected.id)
  }, [selected])
  useEffect(() => {
    if (viewerId && viewerIndex < 0) setViewerId(null) // aged out of the window
  }, [viewerId, viewerIndex])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || viewerId) return
      if (picking) setPicking(false)
      else select(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select, viewerId, picking])

  // The bottom strip's height, so the pinned photo card never covers it.
  const stripRef = useRef<HTMLDivElement | null>(null)
  const [stripH, setStripH] = useState(0)
  useEffect(() => {
    const el = stripRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setStripH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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

  const split = layout === 'split' && HAS_JETSON_STREAM

  return (
    <div className="flex h-full w-full overflow-hidden bg-ink-deep">
      {/* Map pane. In overlay layout it is the whole screen. */}
      <div className={`relative min-w-0 flex-1 overflow-hidden ${picking ? 'cursor-crosshair' : ''}`}>
        <div className="absolute inset-0">
          {view === '2d' ? (
            <LiveMap {...shared}>
              {cardProps && <DetectionCallout {...cardProps} bottomInset={stripH + 24} />}
            </LiveMap>
          ) : (
            <Suspense fallback={<Loading3D />}>
              <LiveMap3D {...shared} onBearing={setBearing} />
            </Suspense>
          )}
        </div>

        {/* No backdrop filter on this wrapper: the camera's full-screen mode is
            `fixed`, and a filtered ancestor would trap it. */}
        <div className="pointer-events-none absolute inset-0 z-[500] flex flex-col p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col items-start gap-2">
              <MapChromeTopLeft
                view={view}
                onView={switchView}
                basemap={basemap}
                onBasemap={setBasemap}
                layout={layout}
                onLayout={HAS_JETSON_STREAM ? setLayout : undefined}
              />
              {view === '3d' && (
                <span className="glass px-2.5 py-1 text-[0.6875rem] text-paper-faint">
                  Right-drag or Ctrl-drag to tilt and rotate
                </span>
              )}
              {view === '3d' && cardProps && (
                <div className="pointer-events-auto">
                  <DetectionCard {...cardProps} />
                </div>
              )}
              {testOpen && (
                <div className="pointer-events-auto">
                  <TestInjectPanel
                    point={testPoint}
                    picking={picking}
                    onPickToggle={() => setPicking((p) => !p)}
                    onClose={() => {
                      setTestOpen(false)
                      setPicking(false)
                    }}
                  />
                </div>
              )}
            </div>
            <MapChromeTopRight
              controls={controls}
              follow={follow}
              onFollow={onFollow}
              layers={layers}
              onLayers={setLayers}
              droneLabel={droneOverlay ? droneOverlayLabel(droneOverlay) : null}
              view={view}
              bearing={bearing}
              testOpen={testOpen}
              onTest={() => setTestOpen((o) => !o)}
            />
          </div>

          <div className="flex-1" />

          <div ref={stripRef}>
            <StatusStrip
              telemetry={mission?.telemetry ?? null}
              progress={mission?.progress ?? null}
              detections={detections}
              onPick={pick}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-1">
            <span className="pointer-events-auto">
              <ImageryAttribution basemap={basemap} />
            </span>
            {view === '3d' && (
              <span className="text-[0.625rem] text-paper-faint">
                · Buildings © OpenFreeMap, OpenMapTiles, OpenStreetMap · Terrain: Mapzen / AWS
              </span>
            )}
          </div>
        </div>

        {HAS_JETSON_STREAM && !split && (
          <LiveFeed key="float" detectorRunning={detectorRunning} floatClassName="right-[4.25rem] top-3 w-[min(400px,34vw)]" />
        )}
      </div>

      {/* Split layout: the camera as a co-equal column beside the map. */}
      {split && <LiveFeed key="docked" docked detectorRunning={detectorRunning} />}

      {viewerIndex >= 0 && (
        <Lightbox
          detections={visibleDetections}
          index={viewerIndex}
          onIndex={(i) => {
            const d = visibleDetections[i]
            if (!d) return
            setViewerId(d.id)
            select(d.id)
          }}
          onClose={() => setViewerId(null)}
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
