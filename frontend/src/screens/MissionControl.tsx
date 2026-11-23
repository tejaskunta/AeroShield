import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { Detection, LatLng } from '@/types'
import { useMission } from '@/components/shell/missionContext'
import { useDetections } from '@/hooks/useDetections'
import { usePersistedState } from '@/hooks/usePersistedState'
import { DEMO_MODE, HAS_JETSON_STREAM, setSurveyOrigin } from '@/lib/config'
import { MISSION } from '@/lib/mockData'
import { offsetM } from '@/lib/geo'
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
import { fmtM } from '@/components/map/MeasureLayer'
import { Lightbox } from '@/components/ui/Lightbox'
import { useCommand } from '@/lib/commands'
import { DetectionToasts } from '@/components/mission/DetectionToasts'
import { SimFeed } from '@/components/mission/SimFeed'
import { DemoControl, MissionDebrief, type DemoPickMode } from '@/components/mission/DemoControl'
import { simulator } from '@/lib/simulation'

/** A camera picture exists: the Jetson's, or the simulated one in demo mode. */
const HAS_FEED = HAS_JETSON_STREAM || DEMO_MODE

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
  // The demonstration opens with every mission layer on: grid, coverage and track are the story.
  const [layers, setLayers] = useState<LayerState>(DEMO_MODE ? { ...DEFAULT_LAYERS, grid: true, coverage: true, track: true } : DEFAULT_LAYERS)
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

  // Measure tool (2D): its clicks belong to the ruler, not to selection.
  const [measuring, setMeasuring] = useState(false)
  const [measure, setMeasure] = useState<{ m: number; n: number }>({ m: 0, n: 0 })
  const onMeasure = useCallback((m: number, n: number) => setMeasure({ m, n }), [])
  useEffect(() => {
    if (view !== '2d') setMeasuring(false)
  }, [view])

  // Demo pick modes: 'fly' sends the simulated aircraft to each clicked point;
  // 'site' re-centres the whole survey block (grid, pad, targets) on the click.
  const [pickMode, setPickMode] = useState<DemoPickMode>(null)
  useEffect(() => {
    if (!pickMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickMode(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickMode])

  const onMapClick = useCallback(
    (p: LatLng) => {
      if (picking) {
        setTestPoint(p)
        setPicking(false)
        return
      }
      if (DEMO_MODE && pickMode === 'fly') {
        simulator.goTo(p)
        return
      }
      if (DEMO_MODE && pickMode === 'site') {
        // The origin is the block's SW corner; centre the block on the click.
        const { cols, rows, cellSizeM } = MISSION.grid
        setSurveyOrigin(offsetM(p, -(cols * cellSizeM) / 2, -(rows * cellSizeM) / 2))
        return
      }
      if (measuring) return
      select(null)
    },
    [picking, pickMode, measuring, select],
  )

  const pick = useCallback(
    (d: Detection) => {
      select(d.id)
      setFollow('manual')
      controls?.flyTo(d.position.lat, d.position.lon)
    },
    [controls, select],
  )

  // Palette and keyboard commands (lib/commands.ts).
  useCommand((cmd) => {
    switch (cmd.type) {
      case 'view':
        switchView(cmd.value === 'toggle' ? (view === '2d' ? '3d' : '2d') : cmd.value)
        break
      case 'layout':
        if (HAS_FEED) setLayout(cmd.value === 'toggle' ? (layout === 'split' ? 'overlay' : 'split') : cmd.value)
        break
      case 'fit':
        onFollow('fit')
        break
      case 'follow':
        onFollow('follow')
        break
      case 'zoom':
        if (cmd.dir > 0) controls?.zoomIn()
        else controls?.zoomOut()
        break
      case 'measure':
        if (view === '2d') {
          setMeasuring((v) => !v)
          setMeasure({ m: 0, n: 0 })
        }
        break
      case 'test':
        setTestOpen((o) => !o)
        break
      case 'latest': {
        const d = detections[detections.length - 1]
        if (d) pick(d)
        break
      }
      case 'basemap':
        setBasemap(cmd.value)
        break
    }
  })

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

  // The demo panel's height, so detection toasts stack above it instead of under it.
  const demoRef = useRef<HTMLDivElement | null>(null)
  const [demoH, setDemoH] = useState(0)
  const hasDemoPanel = DEMO_MODE && !!mission?.sim
  useEffect(() => {
    const el = demoRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      setDemoH(0)
      return
    }
    const ro = new ResizeObserver(() => setDemoH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasDemoPanel])

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
  const measureProps = { measuring, onMeasure }

  const split = layout === 'split' && HAS_FEED
  const sim = mission?.sim ?? null

  return (
    // Column below lg: the docked camera styles itself as a full-width band under the
    // map there (w-full, min-h, border-t), which in a row squeezed the map to ~30px.
    <div className="flex h-full w-full flex-col overflow-hidden bg-ink-deep lg:flex-row">
      {/* Map pane. In overlay layout it is the whole screen. */}
      <div className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${picking || pickMode ? 'cursor-crosshair' : ''}`}>
        <div className="absolute inset-0">
          {view === '2d' ? (
            <LiveMap {...shared} {...measureProps}>
              {cardProps && <DetectionCallout {...cardProps} bottomInset={stripH + 24} />}
            </LiveMap>
          ) : (
            <View3DBoundary onFallback={() => switchView('2d')}>
              <Suspense fallback={<Loading3D />}>
                <LiveMap3D {...shared} onBearing={setBearing} />
              </Suspense>
            </View3DBoundary>
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
                onLayout={HAS_FEED ? setLayout : undefined}
              />
              {view === '3d' && (
                <span className="glass px-2.5 py-1 text-[0.6875rem] text-paper-faint">
                  Drag to pan · right-drag to orbit · scroll to zoom
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
              measuring={measuring}
              onMeasure={() => {
                setMeasuring((v) => !v)
                setMeasure({ m: 0, n: 0 })
              }}
            />
          </div>

          <div className="flex-1" />

          {measuring && (
            <div className="mb-2 flex justify-center">
              <span className="glass pointer-events-auto px-3 py-1.5 font-mono text-[0.75rem] text-paper">
                {measure.n < 2 ? 'Click points on the map to measure' : `Total ${fmtM(measure.m)} · ${measure.n} points`}
                <span className="ml-2 font-body text-paper-faint">Esc to finish</span>
              </span>
            </div>
          )}

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
                · Buildings © OpenStreetMap contributors · Ground detail simulated
              </span>
            )}
          </div>
        </div>

        {DEMO_MODE && sim && (
          // Bottom-right, just above the status strip and attribution line; grows upward.
          <div
            ref={demoRef}
            className="pointer-events-none absolute right-[4.25rem] z-[540] flex w-[min(580px,calc(100%-5.5rem))] justify-end"
            style={{ bottom: stripH + 42 }}
          >
            <DemoControl sim={sim} pickMode={pickMode} onPickMode={(m) => setPickMode((cur) => (cur === m ? null : m))} />
          </div>
        )}

        <DetectionToasts detections={detections} onPick={pick} bottom={stripH + 40 + (demoH ? demoH + 8 : 0)} />

        {DEMO_MODE && !split && (
          <SimFeed telemetry={mission?.telemetry ?? null} detections={detections} phase={sim?.phase ?? null} />
        )}
        {!DEMO_MODE && HAS_JETSON_STREAM && !split && (
          <LiveFeed key="float" detectorRunning={detectorRunning} floatClassName="right-[4.25rem] top-3 w-[min(400px,34vw)]" />
        )}
        {DEMO_MODE && sim && <MissionDebrief sim={sim} progress={mission?.progress ?? null} detections={detections} />}
      </div>

      {/* Split layout: the camera as a co-equal column beside the map. */}
      {split && DEMO_MODE && (
        <SimFeed docked telemetry={mission?.telemetry ?? null} detections={detections} phase={sim?.phase ?? null} />
      )}
      {split && !DEMO_MODE && <LiveFeed key="docked" docked detectorRunning={detectorRunning} />}

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

/** A 3D failure (no WebGL, a lost context) must never blank the mission screen. */
class View3DBoundary extends Component<{ onFallback: () => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="grid h-full place-items-center">
        <div className="glass flex flex-col items-center gap-2 px-5 py-4 text-center">
          <span className="text-[0.8125rem] font-medium text-paper">The 3D view could not start on this device.</span>
          <button type="button" onClick={this.props.onFallback} className="rounded-md bg-signal px-3 py-1.5 text-[0.8125rem] font-semibold text-ink">
            Switch to 2D
          </button>
        </div>
      </div>
    )
  }
}

function Loading3D() {
  return (
    <div className="grid h-full place-items-center">
      <span className="glass px-3 py-1.5 text-[0.75rem] text-paper-faint">Loading 3D view…</span>
    </div>
  )
}
